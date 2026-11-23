import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { app } from "./app-context";
import { ask, message, modalInput } from "./dialogs";
import { showTransientStatus } from "./statusbar";
import { applyMarkdownAction, type MarkdownAction } from "./markdown-actions";
import { formatJsonText } from "./json-lang";
import { checkToml, checkYaml, formatTomlText, formatYamlText } from "./config-lang";
import { findNext, findPrevious, replaceAllMatches } from "./search";
import { toggleToc } from "./toc";
import { openSettingsDialog } from "./settings";
import { printActiveMarkdown, togglePreview } from "./preview-panel";
import { saveTab } from "./tab-save";
import { cycleTab } from "./tab-lifecycle";
import { ensureEditMode, newTab, openFiles, openFolder } from "./file-open";
import { showRecentPopover } from "./recent-popover";
import { comboFromEvent, DEFAULT_SHORTCUTS, getShortcut } from "./shortcuts";
import { isJson, isToml, isYaml } from "./tabs";

interface MenuActionDeps {
  toggleTree(): Promise<void>;
  toggleBlockMode(): void;
}

let deps: MenuActionDeps;

export function initMenuActions(d: MenuActionDeps): void {
  deps = d;
}

/** 格式化当前文档：JSON 支持选区，YAML/TOML 整篇重排。 */
async function formatJsonTab(): Promise<void> {
  const { store, editor } = app;
  const tab = store.active;
  if (!tab) return;

  if (isJson(tab.title)) {
    if (!ensureEditMode()) return;
    const state = editor.state;
    const range = state.selection.main;
    const source = range.empty
      ? state.doc.toString()
      : state.sliceDoc(range.from, range.to);
    const result = formatJsonText(source);
    if (!result.ok) {
      showTransientStatus(`JSON 格式错误：${result.error}`);
      return;
    }
    const changes = range.empty
      ? { from: 0, to: state.doc.length }
      : { from: range.from, to: range.to };
    editor.replaceText(result.text, changes);
    showTransientStatus("已格式化 JSON");
    return;
  }

  const yaml = isYaml(tab.title);
  if (!yaml && !isToml(tab.title)) {
    showTransientStatus("只有 JSON / YAML / TOML 支持格式化");
    return;
  }

  if (!ensureEditMode()) return;
  const source = editor.state.doc.toString();

  // TOML 重排会丢掉注释：只有真的存在注释时才需要打断用户确认
  if (!yaml && source.split(/\r?\n/).some((line) => line.trimStart().startsWith("#"))) {
    const choice = await ask("TOML 格式化会丢失文件中的注释，是否继续？", [
      { label: "继续格式化", value: "ok", primary: true },
      { label: "取消", value: "cancel" },
    ]);
    if (choice !== "ok" || store.activeId !== tab.id) return;
  }

  const result = yaml ? await formatYamlText(source) : await formatTomlText(source);
  // 格式化是异步的，期间可能已经切换了标签
  if (store.activeId !== tab.id) return;

  if (!result.ok) {
    showTransientStatus(`${yaml ? "YAML" : "TOML"} 格式错误：${result.error}`);
    return;
  }
  editor.replaceText(result.text);
  showTransientStatus(yaml ? "已格式化 YAML" : "已格式化 TOML");
}

async function openSearchInEditor(withReplace: boolean): Promise<void> {
  if (!ensureEditMode()) return;
  app.editor.focus();
  await app.editor.openSearch(withReplace);
}

const formatActions: Record<string, MarkdownAction> = {
  "format.bold": "bold",
  "format.italic": "italic",
  "format.strike": "strike",
  "format.h1": "h1",
  "format.h2": "h2",
  "format.h3": "h3",
  "format.bullet": "bullet",
  "format.ordered": "ordered",
  "format.quote": "quote",
  "format.link": "link",
  "format.code": "code",
};

/** 视图菜单里的终端开关：会话已被 × 关闭时，这里会新起一个 */
async function toggleTerminal(): Promise<void> {
  const { terminal, store, tree } = app;
  if (terminal.visible) {
    terminal.hide();
    return;
  }
  const cwd = terminalStartDir();
  if (!cwd) {
    await message("请先打开文件夹或文件，集成终端需要知道起始目录。");
    return;
  }
  await terminal.open(cwd);
}

/** 起始目录：优先当前标签所在目录，没有标签时退回工作区根目录 */
function terminalStartDir(): string | null {
  const { store, tree } = app;
  const path = store.active?.path ?? "";
  if (path) {
    const dir = path.replace(/[\\/][^\\/]+$/, "");
    if (dir && dir !== path) return dir;
  }
  return tree.currentRoot;
}

/** Gitee release 的更新信息，字段与 updater.rs 的 UpdateInfo 对应 */
interface UpdateInfo {
  has_update: boolean;
  current: string;
  latest: string;
  changelog: string;
  download_url: string | null;
  asset_size: number | null;
  launcher_path: string | null;
}

/** 检查更新：有新版时下载替换启动器，重启后由新启动器解包新主程序 */
async function checkForUpdate(): Promise<void> {
  showTransientStatus("正在检查更新…");
  let info: UpdateInfo;
  try {
    info = await invoke<UpdateInfo>("update_check");
  } catch (error) {
    await message(`检查更新失败：${error}`);
    return;
  }
  if (!info.has_update) {
    await message(`当前已是最新版本（${info.current}）`);
    return;
  }
  // 开发模式直接运行主程序时没有启动器可替换，跳转 release 页手动下载
  if (!info.launcher_path || !info.download_url) {
    await message(`发现新版本 ${info.latest}，当前环境不支持自动更新，请在浏览器中手动下载`);
    await invoke("open_release_page");
    return;
  }

  const sizeText = info.asset_size
    ? `（约 ${(info.asset_size / 1024 / 1024).toFixed(1)} MB）`
    : "";
  const choice = await ask(
    `发现新版本 ${info.latest}${sizeText}\n\n${info.changelog || "暂无更新说明"}`,
    [
      { label: "下载并安装", value: "update", primary: true },
      { label: "暂不更新", value: "cancel" },
    ],
  );
  if (choice !== "update") return;

  showTransientStatus("正在下载更新…");
  try {
    await invoke("update_download", {
      url: info.download_url,
      launcher: info.launcher_path,
    });
  } catch (error) {
    await message(`更新失败：${error}`);
    return;
  }
  const restart = await ask("更新已就绪，重启应用后生效，现在重启吗？", [
    { label: "立即重启", value: "restart", primary: true },
    { label: "稍后手动重启", value: "cancel" },
  ]);
  if (restart === "restart") {
    await invoke("update_restart", { launcher: info.launcher_path });
  }
}

/** 关于弹窗：版本号取自 Tauri 构建配置，避免前端再维护一份 */
async function showAbout(): Promise<void> {
  const version = await getVersion().catch(() => "");
  const lines = [
    `fEditor${version ? ` ${version}` : ""}`,
    "",
    "轻量多标签文本编辑器，基于 Tauri 2 与 CodeMirror 6。",
    "",
    "资源管理器 · 集成终端 · Markdown 预览 · 列块选择 · 浅色/深色主题",
    "",
    "支持格式",
    "编辑：Markdown、JSON、YAML、TOML、SVG 及各类文本 / 源码文件",
    "预览：PDF、Word（.docx）、图片（png/jpg/gif/webp/bmp/ico）、音频（mp3/m4a/wav/aac/flac）、视频（mp4/webm）",
    "导出：Markdown 打印预览生成 PDF",
    "上限：文本 20 MB，PDF / Word 100 MB，图片 40 MB，音视频 100 MB",
  ];
  await message(lines.join("\n"));
}

export async function handleMenuAction(action: string): Promise<void> {
  if (action === "format.document") {
    await formatJsonTab();
    return;
  }

  const format = formatActions[action];
  if (format) {
    const { editor, store } = app;
    if (!ensureEditMode() || !store.active) return;
    applyMarkdownAction(editor.view, format);
    editor.focus();
    return;
  }

  const { editor, store } = app;
  switch (action) {
    case "file.new":
      // 新建未命名标签，可直接输入纯文本；首次保存时默认 .txt 扩展名
      newTab();
      break;
    case "file.open":
      await openFiles();
      break;
    case "folder.open":
      await openFolder();
      break;
    case "view.tree":
      await deps.toggleTree();
      break;
    case "view.toc":
      toggleToc();
      break;
    case "view.terminal":
      await toggleTerminal();
      break;
    case "file.recent":
      showRecentPopover();
      break;
    case "file.save": {
      const tab = store.active;
      if (tab) await saveTab(tab);
      break;
    }
    case "file.print":
      await printActiveMarkdown();
      break;
    case "edit.undo":
      if (ensureEditMode()) {
        editor.undo();
        editor.focus();
      }
      break;
    case "edit.redo":
      if (ensureEditMode()) {
        editor.redo();
        editor.focus();
      }
      break;
    case "edit.find":
      await openSearchInEditor(false);
      break;
    case "edit.replace":
      await openSearchInEditor(true);
      break;
    case "view.preview":
      await togglePreview();
      break;
    case "settings.open":
      openSettingsDialog();
      break;
    case "edit.block":
      deps.toggleBlockMode();
      break;
    case "help.update":
      await checkForUpdate();
      break;
    case "help.about":
      await showAbout();
      break;
    default:
      break;
  }
}

export function bindShortcuts(): void {
  // 原生菜单加速键在 WebView2 下不会真正触发，快捷键统一在此兜底。
  // 组合键 → 动作的映射从 shortcuts 注册表读取（默认值 + 用户自定义覆盖）
  let menuShortcuts = buildShortcutMap();
  window.addEventListener("shortcuts-changed", () => {
    menuShortcuts = buildShortcutMap();
  });

  function buildShortcutMap(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const [action, combo] of Object.entries(DEFAULT_SHORTCUTS)) {
      map[getShortcut(action) || combo] = action;
    }
    return map;
  }

  window.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement | null;
    // 焦点在集成终端、输入弹窗或查找弹框里时，按键属于该控件本身，不能被编辑器快捷键拦截
    if (target?.closest?.(".xterm") || target === modalInput || target?.closest?.(".find-card"))
      return;

    const action = menuShortcuts[comboFromEvent(event)];
    if (action) {
      event.preventDefault();
      void handleMenuAction(action);
      return;
    }

    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (!mod && event.key === "F3") {
      event.preventDefault();
      void (event.shiftKey ? findPrevious(app.editor.view) : findNext(app.editor.view));
      return;
    }

    if (!mod) return;

    if (event.key === "Tab") {
      event.preventDefault();
      cycleTab(event.shiftKey ? -1 : 1);
      return;
    }
    // Ctrl+Alt+F 不在菜单里，作为替换面板的快捷方式保留
    if (key === "f" && event.altKey) {
      event.preventDefault();
      void openSearchInEditor(true);
      return;
    }
    if (key === "g") {
      event.preventDefault();
      void (event.shiftKey ? findPrevious(app.editor.view) : findNext(app.editor.view));
      return;
    }
    if (key === "enter" && event.altKey) {
      event.preventDefault();
      void replaceAllMatches(app.editor.view);
      return;
    }
  });
}
