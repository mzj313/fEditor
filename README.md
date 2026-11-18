# fEditor · 轻量文本编辑器

Sublime 风格的轻量文本编辑器，以 Markdown 为主，同时支持 txt 等常见文本文件的打开、编辑与保存，并可只读预览 PDF、Word、图片、音频与视频。跨 Windows / macOS，单文件分发，免安装即可用。

| 项 | 内容 |
|---|---|
| 目标平台 | Windows 10/11、macOS |
| 形态 | 绿色单文件可执行程序（Windows `.exe` / macOS `.app`、`.dmg`），附 `scripts/` 下的启动脚本，不做安装器 |
| 技术栈 | Tauri 2 + 原生 TypeScript + Vite + CodeMirror 6 |

## 目标与非目标

| 目标 | 非目标 |
|---|---|
| 启动后自动恢复上次打开的文件 | 插件系统、Git 集成、LSP |
| 支持多标签、编辑、保存、另存为 | 分栏实时预览、minimap |
| Markdown 语法高亮与切换式预览 | 视频转码、字幕轨道 |
| txt 等文本文件的搜索替换与列块编辑 | 正则高级特性（捕获组引用等） |
| 跨 Windows / macOS，同一套代码 | 云端同步、协作编辑 |
| 单文件分发，免安装即可用 | 完整 IDE 能力（这是 VSCode 的领域） |

`others/dbx/dbx-file-viewer` 仅作功能参考，未迁移其代码与插件架构。

## 技术选型

| 层 | 选型 | 依据 |
|---|---|---|
| 桌面框架 | Tauri 2 | 复用系统 WebView，不内嵌 Chromium |
| 后端 | Rust，最小 feature 集 | 文件读写、编码转换、原生对话框、会话文件 |
| 前端 | 原生 TypeScript + Vite，不引入 Vue/React | 省运行时与打包体积 |
| 编辑器 | CodeMirror 6（state / view / commands / lang-markdown） | 行号、语法高亮、独立撤销栈 |
| 搜索替换 | `@codemirror/search` | `searchKeymap`、`openSearchPanel`、`replaceAll` |
| 列块模式 | `@codemirror/view` 的 `rectangularSelection` | 矩形选区与多光标有原生支持 |
| Markdown 预览 | `markdown-it` + `DOMPurify` | 切换预览时才加载渲染，输出前净化 |
| 文档预览 | `pdfjs-dist`、`docx-preview`、自定义媒体协议 | PDF / DOCX / 图片 / 音视频只读预览 |
| 图表 | `mermaid` | Markdown 内图表渲染 |
| 终端 | `@xterm/xterm` + `addon-fit` | 内置终端面板 |
| 编码 | `encoding_rs` + `chardetng` | UTF-8 / GBK / GB18030 探测与回写 |
| 原子写 | `tempfile` | 同目录临时文件 + `sync_all` + 替换 |
| 对话框 | `rfd` 或 `tauri-plugin-dialog` | 跨平台原生打开/保存对话框 |
| 明确排除 | Electron、Monaco、Flutter、JavaFX、Wails | 体积或内存不满足约束 |

**体积与性能预算**（未标注项为目标量级，非承诺值）

| 指标 | 实测 / 目标 |
|---|---|
| 前端首屏包 | 实测约 450 KB（JS 427 KB + CSS 17 KB） |
| 前端按需加载资源 | 实测约 8 MB（mermaid、pdf.js、xterm、docx-preview 用到时才加载） |
| 安装包体积 | 目标 10–15 MB 量级（前端资源 + Rust 二进制） |
| 空闲内存 | 30–60 MB 量级 |
| 冷启动 | 窗口先可见，会话异步恢复 |

体积优化项：`strip = true`、`lto = true`、`codegen-units = 1`、`panic = "abort"`、`opt-level = "z"`；不引入前端框架；搜索结果面板与预览渲染按需懒加载，不进首屏包。构建时清空 `dist`，避免旧 hash 文件被一起打进安装包。

## 功能规格

| 模块 | 内容 |
|---|---|
| 标签 | 新建、打开、点击切换、中键关闭、脏标记 `*`、关闭确认 |
| 会话 | 启动时恢复标签页、激活标签、光标与滚动位置；最近打开列表 |
| 编辑 | Markdown 语法高亮、行号、自动换行开关、独立撤销栈、查找与替换、列块（矩形）选择与多光标编辑 |
| 搜索替换 | 对所有文本标签一致生效（含 txt）：大小写敏感、全词匹配、正则、选区内替换、查找上一个/下一个、替换单个与全部替换 |
| 列块模式 | 对所有文本标签一致生效（含 txt）：矩形拖选、按行拆分多光标、上下添加光标、多光标同时输入/删除、`Esc` 回到单光标 |
| 文件 | 打开、保存、另存为、拖放打开、命令行参数传路径 |
| 文件类型 | 见下文「支持的格式」：文本类可编辑，PDF / DOCX / 图片 / 音视频只读预览；二进制文件拒绝打开 |
| 预览 | Markdown / SVG 切换式预览（净化后 HTML / 图形），预览态只读不可编辑 |
| 二进制预览 | PDF 分页懒渲染、DOCX 分页排版、图片缩放与 1:1 查看、音视频播放（倍速、循环）；切走标签时释放 PDF 资源 |
| 状态栏 | 行列号、字数、编码、EOL、语言模式、光标数量 / 列块状态、保存状态 |
| 编码 | UTF-8 / GBK / GB18030 读取与按原编码回写，保留 BOM 与 CRLF |

### 支持的格式

**可编辑文本**（≤20 MB，非二进制）

| 类型 | 扩展名 | 能力 |
|---|---|---|
| Markdown | `.md` `.markdown` | 语法高亮、切换式预览、Mermaid、任务列表、相对路径图片 |
| JSON | `.json` | 语法高亮、格式化 / 校验（支持选区） |
| YAML | `.yaml` `.yml` | 语法高亮、格式化（保留注释与键顺序） |
| TOML | `.toml` | 语法高亮、格式化（会丢注释，先确认） |
| SVG | `.svg` | 文本编辑 + 图形预览（默认进预览，`<img>` 渲染不执行脚本） |
| 其他文本 | 无扩展名白名单，如 `.txt` `.log` `.sql` `.xml` `.csv` `.ini` 及常见源码扩展名 | 纯文本编辑，无语法高亮 |

编码：UTF-8 / UTF-8 BOM / GBK / GB18030 自动探测并原样回写；前 8 KB 含 NUL 的文件按二进制拒绝。

**只读预览**

| 格式 | 扩展名 | 能力 | 上限 |
|---|---|---|---|
| PDF | `.pdf` | pdf.js 逐页懒渲染，缩放 40%–300%，页码跟随滚动；经自定义协议按需读取，不整份转 base64 | 100 MB |
| Word | `.docx` | docx-preview 分页排版，保留页眉页脚 | 100 MB |
| 图片 | `.png` `.jpg` `.jpeg` `.gif` `.webp` `.bmp` `.ico` | 自适应缩放、缩放按钮、1:1 查看，显示原始像素尺寸 | 40 MB |
| 音频 | `.mp3` `.m4a` `.wav` `.aac` `.flac` | 流式播放、倍速 0.75–1.5、循环 | 100 MB（兜底） |
| 视频 | `.mp4` `.webm` | 流式播放、倍速 0.75–1.5、循环；MP4 建议 H.264 + AAC | 协议按 4 MB 分片，兜底 100 MB |

**Markdown 内嵌内容**：Mermaid 图（流程图 / 时序图 / 类图等）；本地图片 `svg/png/jpg/jpeg/gif/webp/bmp/ico` 按文档目录解析相对路径，单张 ≤50 MB；`http(s)` / `data:` / `blob:` 保持原样。

**不支持**：旧版 Word `.doc`、Excel / PowerPoint、压缩包、可执行文件等二进制文件会提示后拒绝；`ogg/opus/wma` 不在音频白名单内；视频仅支持 MP4 / WebM，MKV、AVI、FLV、WMV 及 HEVC 等编码不做保证。

**搜索替换与列块模式的实现约束**

| 能力 | 实现方式 |
|---|---|
| 搜索替换 | `@codemirror/search` 的面板与 keymap；结果高亮、匹配计数显示在面板中 |
| 列块模式 | `rectangularSelection` 提供矩形拖选；配合 `EditorSelection` 多 range 与自定义 keymap 实现加光标、按行拆分 |
| 撤销一致性 | 搜索替换、列块编辑、多光标输入都进入同一标签的撤销栈，可整体撤销；不改变编码 / EOL / BOM 保存链路 |
| 预览态 | 预览（只读 HTML）下禁用编辑类快捷键，避免按键无响应 |
| 平台差异 | mac 的 `Option + 拖动` 及部分 `Cmd+Alt` 组合可能被系统占用，需实机验证；冲突时改用 `Shift+Option+拖动` / `Ctrl+Shift+↑↓` |

**可选增强**：草稿保活（崩溃后恢复未保存内容）、自动保存开关、命令面板、文件树、主题切换、更多语言高亮包、安装器与文件类型关联、正则替换的捕获组引用。

## 会话恢复设计

**位置**：通过 Tauri `app_config_dir()` 取得，一份代码跨平台。

| 平台 | 路径 |
|---|---|
| Windows | `%APPDATA%\com.mzj.file-editor\session.json` |
| macOS | `~/Library/Application Support/com.mzj.file-editor/session.json` |

**数据结构**（只存路径与视图状态，不存文件正文）：

```json
{
  "version": 1,
  "activeId": "t2",
  "tabs": [
    {
      "id": "t2",
      "path": "D:/notes/readme.md",
      "title": "readme.md",
      "dirty": false,
      "encoding": "UTF-8",
      "eol": "CRLF",
      "hasBom": false,
      "mtime": 1762412345000,
      "cursor": 128,
      "scrollTop": 640
    }
  ],
  "recent": ["D:/notes/readme.md"],
  "updatedAt": 1762412400000
}
```

**写入时机**：标签增删/切换、激活标签变化、光标与滚动变化后防抖约 400 ms 落盘；窗口 `Destroyed` 事件强制 flush；会话文件本身也用临时文件 + 替换写入，避免退出瞬间写坏 JSON。

**恢复校验**：

| 情况 | 处理 |
|---|---|
| 路径不存在 / 无权限 / 被移动 | 显示为「文件已丢失」占位标签，不静默丢弃 |
| 超过大小上限或二进制 | 跳过并在状态栏提示 |
| 会话 JSON 损坏或版本不符 | 退回空窗口，不崩溃 |
| `mtime` 与磁盘不一致 | 正常重读磁盘内容，以磁盘为准 |

**启动时序**：窗口先显示 → 异步读 `session.json` → 恢复标签栏（标题先占位）→ 只为激活标签创建编辑器视图 → 其余标签保留纯数据，切换时才加载。首屏不做预览渲染、不做全文索引。

**退出处理**：存在脏标签时弹出「保存全部 / 不保存退出 / 取消」，不允许静默丢失。选择「不保存退出」时，会话仍按路径记录这些标签，下次重开得到磁盘上的版本。

## 编辑与保存链路

**读取时记录的字段**

| 字段 | 用途 |
|---|---|
| `encoding` | 保存时按原编码回写，避免中文 Windows 上 GBK 文件保存后乱码 |
| `eol`（CRLF / LF） | 编辑器内部统一 LF，保存时还原 |
| `hasBom` | 保存时补回 UTF-8 BOM |
| `mtime` | 保存前检测外部修改 |
| `size` | 超限拒绝或只读打开 |

解码顺序：UTF-8 BOM → 严格 UTF-8 → `chardetng` 探测，若判为 `WINDOWS_1252` 则按 GBK 兜底。

**保存步骤**

1. 比对当前 `mtime` 与打开时记录值；不一致则拒绝静默覆盖，提示「重新打开 / 仍要覆盖」。
2. 把编辑器内容规范化为 LF，再按原 `eol` 还原 CRLF。
3. 按 `encoding` 编码回字节，必要时补 BOM。
4. 在**同目录**创建临时文件 → 写入 → `sync_all` → 原子替换原文件。
5. 成功后回传新 `mtime`，清除脏标记，更新状态栏。
6. 失败时保留内容与脏标记，不关闭标签。

**其他规则**

- 新建标签命名 `未命名-N`，首次保存走原生「另存为」对话框。
- 关闭脏标签 / 关闭窗口走同一套「保存 / 不保存 / 取消」逻辑；mac 的 `Cmd+W`、`Cmd+Q` 与 Windows 关窗口统一处理。
- 大小上限默认 20 MB（可配置），超长行由 CodeMirror 视口渲染缓解；PDF / Word 100 MB、图片 40 MB、音频兜底 100 MB。
- 只读文件、权限不足时明确报错，不伪装成保存成功。

## 多标签状态模型

| 字段 | 说明 |
|---|---|
| `id` / `path` / `title` | 标识与显示；`path` 为空表示未命名新标签 |
| `dirty` | 脏标记，驱动 `*`、关闭确认、退出拦截 |
| `encoding` / `eol` / `hasBom` / `mtime` | 保存链路所需的原始文件属性 |
| `cursor` / `scrollTop` | 会话恢复用；列块/多光标状态随 `editorState` 保留 |
| `editorState` | CodeMirror `EditorState`，含文档、选区（含多光标）与独立撤销栈 |
| `previewMode` | 编辑 / 预览 |

全局只持有**一个** `EditorView`：切换标签时把当前 state 存回标签对象，再把目标 state 灌入同一视图。未激活标签只有文本字符串与撤销栈，不创建 DOM，因此开多个标签的内存增量很小。

## 界面与快捷键

布局：顶部标签栏（含新建按钮）→ 工具行（打开 / 保存 / 查找 / 替换 / 预览切换 / 列块状态提示）→ 编辑或预览区 → 底部状态栏。默认浅色主题，窗口最小尺寸 900×600；mac 使用系统菜单栏，Windows 使用自绘标签栏。

| 操作 | Windows | macOS |
|---|---|---|
| 新建标签 | `Ctrl+N` | `Cmd+N` |
| 打开文件 | `Ctrl+O` | `Cmd+O` |
| 保存 | `Ctrl+S` | `Cmd+S` |
| 另存为 | `Ctrl+Shift+S` | `Cmd+Shift+S` |
| 关闭标签 | `Ctrl+W` | `Cmd+W` |
| 下一个 / 上一个标签 | `Ctrl+Tab` / `Ctrl+Shift+Tab` | `Ctrl+Tab` / `Ctrl+Shift+Tab`（`Cmd+Tab` 由系统占用） |
| 查找 | `Ctrl+F` | `Cmd+F` |
| 查找下一个 / 上一个 | `F3` / `Shift+F3` | `Cmd+G` / `Cmd+Shift+G` |
| 打开替换 / 全部替换 | `Ctrl+H` / `Ctrl+Alt+Enter` | `Cmd+Alt+F` / `Cmd+Alt+Enter` |
| 列块矩形拖选 | `Alt + 鼠标左键拖动` | `Option + 鼠标左键拖动`（冲突时 `Shift+Option+拖动`） |
| 向上 / 下添加光标 | `Ctrl+Alt+↑` / `Ctrl+Alt+↓` | `Cmd+Alt+↑` / `Cmd+Alt+↓`（冲突时 `Ctrl+Shift+↑↓`） |
| 选中多行拆成多光标 | `Ctrl+Shift+L` | `Cmd+Shift+L` |
| 退出列块 / 回到单光标 | `Esc` | `Esc` |
| 切换 Markdown 预览 | `Ctrl+E` | `Cmd+E` |
| 退出 | 关闭窗口 | `Cmd+Q` |

状态栏显示：行:列、字数、编码、EOL、语言模式、光标数量（列块模式下显示活动状态）、「已保存 / 未保存」。

## 目录结构

```text
tools/fEditor/
├── README.md                    本文档（使用说明 + 设计规格）
├── index.html                   前端入口
├── package.json                 pnpm 脚本与前端依赖
├── pnpm-lock.yaml               依赖锁定
├── tsconfig.json                TypeScript 编译配置
├── vite.config.ts               Vite 构建配置
├── src/                         原生 TS 前端
├── public/                      静态资源
├── src-tauri/                   Rust 外壳
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json          窗口、打包、权限配置
│   ├── capabilities/            权限声明
│   ├── icons/                   应用图标
│   └── src/                     Rust 业务代码
├── launcher/                    单文件启动器（Rust）
├── dist/                        前端构建产物
├── node_modules/                依赖
└── scripts/                     所有启动与构建脚本
    ├── start.bat                Windows 启动
    ├── start.sh                 macOS / Linux 启动
    ├── start.command            macOS 双击启动
    ├── build-single.bat         Windows 单文件打包
    └── register-context-menu.bat  资源管理器右键菜单注册
```

**根目录配置文件说明**

| 文件 | 作用 | 位置约束 |
|---|---|---|
| `package.json` | pnpm 脚本、依赖清单、应用元信息 | 必须留在根目录，pnpm 与 Tauri CLI 按此定位工程 |
| `pnpm-lock.yaml` | 依赖版本锁定 | 与 `package.json` 同级 |
| `tsconfig.json` | TypeScript 编译与路径配置 | 必须留在根目录，`tsc` 默认在此查找 |
| `vite.config.ts` | 构建入口、端口、产物输出 | 必须留在根目录，Vite 默认在此查找 |
| `index.html` | Vite 入口页面 | 必须留在根目录 |

这些文件都被工具链按固定位置约定读取，移动会直接导致 `pnpm dev` / `pnpm build` / `pnpm tauri` 失效，因此保持原位，只在此集中说明。

## 开发与构建

```bash
pnpm install
pnpm dev        # 浏览器调试
pnpm tauri dev  # Tauri 窗口调试
pnpm build      # 类型检查 + 前端构建
pnpm tauri build
```

Windows 单文件打包与右键菜单注册：

```bash
scripts\build-single.bat            # 生成 dist-build\fEditor.exe
scripts\register-context-menu.bat   # 注册资源管理器右键菜单
```

## 启动

- macOS：`./scripts/start.command`（双击）或 `./scripts/start.sh`
- Windows：`scripts\start.bat`

启动脚本会优先运行已构建的 release 产物（最快），找不到产物时自动回退 `pnpm tauri dev`（首次会自动安装依赖）。

脚本内部都会先切到项目根目录再执行，因此在任何位置调用都能正常工作。

## 跨平台与交付

| 差异点 | 处理 |
|---|---|
| 启动方式 | Windows 双击 `scripts/start.bat`、mac 运行 `scripts/start.sh`；优先启动 release 产物，无产物回退 `pnpm tauri dev`；不做安装器 |
| 脚本细节 | bat 为 CRLF 行尾、纯 ASCII 提示；sh 为 UTF-8 + LF、中文提示；两者都先补 `~/.cargo/bin` 到 PATH |
| 快捷键 | 代码统一判断 `metaKey \|\| ctrlKey`；`Cmd+Tab` 被系统占用，标签切换统一用 `Ctrl+Tab` |
| 列块快捷键 | mac 的 `Option` 拖动与 `Cmd+Alt` 组合可能被系统占用，需实机验证并提供备用组合 |
| 配置目录 | `app_config_dir()`，不硬编码路径 |
| 拖放路径 | Windows `C:\...`、mac `/Users/...`；`file://` 需解码，统一 canonicalize |
| 原生对话框 | 跨平台同一接口 |
| 窗口与菜单 | mac 需菜单栏（关闭标签 / 退出）；Windows 自绘标签栏 |
| 文件关联 | 一期用命令行参数传路径；安装器与注册表 / `CFBundleDocumentTypes` 属可选增强 |
| 签名 | Windows 无签名会触发 SmartScreen；mac 未签名会被 Gatekeeper 拦截，正式交付需签名 + 公证 |

**构建方式**：Windows 版本机 `pnpm tauri build` 产出；macOS 版无法在 Windows 上交叉编译（需 Xcode / WKWebView / 签名链），默认走 CI 双 runner（`windows-latest` + `macos-latest`）产出 `.exe` 与 `.dmg`。

## 实施阶段

| 阶段 | 内容 | 验证方式 |
|---|---|---|
| S0 | 决策与规格文档、启动脚本 | 脚本走守卫分支冒烟通过 |
| S1 | 工程骨架 + 单标签打开/编辑/保存 | UTF-8 与 GBK 文件保存后不乱码、CRLF 与 BOM 保留、外部修改被拦截 |
| S2 | 多标签 + 会话恢复 + 退出拦截 | 重启后标签与光标恢复；脏标签退出被挡住 |
| S3 | 切换式预览、搜索替换、列块模式、状态栏、快捷键、拖放 | 逐项功能验收，重点用 `.txt` 验证搜索替换与列块编辑 |
| S4 | 双平台打包、图标、CI、启动脚本联调 | 产出双平台产物并分别启动验证 |

每一步单独可验证，不一次性堆积改动。

## 风险与未决项

| 项 | 现状 | 建议 |
|---|---|---|
| macOS 签名与公证证书 | 未确认是否具备 | 内测先出未签名 `.app`，正式交付前补签名 |
| CI runner 可用性 | 未确认 | 有 CI 权限优先用双 runner；否则提供 mac 本地构建步骤 |
| 会话恢复与未保存内容 | 不保草稿 | 后续做草稿区，需同时定义草稿与磁盘冲突规则 |
| 语法高亮范围 | Markdown / JSON / YAML / TOML | 按需加语言包；二进制文件一律拒绝 |
| 列块快捷键冲突 | mac 的 `Option` / `Cmd+Alt` 组合可能被系统占用 | 实机验证，提供备用组合 |
| 正则替换范围 | 基础正则匹配与替换 | 捕获组引用 `$1` 等后续支持 |
| WebView2 依赖 | Win11 自带，老 Win10 可能缺运行时 | 交付说明里注明，必要时附 Evergreen 引导 |

## 验收清单

- [ ] 双击/命令行传入 `.md` 路径可直接打开
- [ ] `.txt` 文件可编辑并保存，GBK 编码的 txt 保存后不乱码、CRLF 不丢失
- [ ] `.txt` 文件内可搜索替换：大小写敏感、全词、正则、选区内替换、全部替换
- [ ] `.txt` 文件可进入列块模式，矩形拖选后多光标同时输入 / 删除
- [ ] 列块编辑与批量替换可整体撤销，撤销栈与标签绑定不串
- [ ] 启动后自动恢复上次标签、激活标签、光标与滚动位置
- [ ] 多个标签各自独立撤销栈与脏标记，切换不丢光标
- [ ] `Ctrl/Cmd+S` 保存后编码、EOL、BOM 与打开时一致
- [ ] 外部程序改动文件后保存被拦截，不静默覆盖
- [ ] 保存过程异常不会留下半截文件
- [ ] 脏标签关闭 / 退出时有确认，不静默丢字
- [ ] 切换式预览可正常渲染且过滤危险 HTML，预览态禁用编辑快捷键
- [ ] 图片可直接双击预览，自适应缩放、缩放按钮与 1:1 正常
- [ ] MP4 / WebM 可流式播放、拖动进度条与倍速切换正常
- [ ] PDF / DOCX / 图片 / 音视频预览标签与文本标签切换互不干扰
- [ ] `scripts/start.bat` / `scripts/start.sh` 在有 release 产物时直接启动，无产物时给出明确提示或走开发模式
- [ ] Windows 与 macOS 各有一份可启动的产物
- [ ] release 产物体积与空闲内存在预算量级内
