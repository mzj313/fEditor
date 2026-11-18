import { redo, undo } from "@codemirror/commands";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { EditorController } from "./editor";
import {
  TabStore,
  basename,
  binaryKindOf,
  createTab,
  isJson,
  isMarkdown,
  isSvg,
  isToml,
  isYaml,
  nextUntitledTitle,
  normalizePath,
  noteUntitledTitle,
  type BinaryKind,
  type Tab,
} from "./tabs";
import { flushSession, loadSession, scheduleSessionSave } from "./session";
import { findNext, findPrevious, replaceAllMatches } from "./search";
import { applyMarkdownAction, type MarkdownAction } from "./markdown-actions";
import { formatJsonText } from "./json-lang";
import { checkToml, checkYaml, formatTomlText, formatYamlText } from "./config-lang";
import { FileTree, type OpenMode } from "./file-tree";
import { TerminalPanel } from "./terminal";
import { showContextMenu } from "./context-menu";
import { disposeBinaryTab } from "./binary-preview";
import { ask, message, modalInput } from "./dialogs";
import {
  applySidebarWidth,
  applyTerminalHeight,
  applyTocWidth,
  bindPreviewResizer,
  bindSidebarResizer,
  bindTerminalResizer,
} from "./layout";
import { splitPath } from "./paths";
import { initFontSize } from "./font-size";
import { initEditorAppearance, openSettingsDialog } from "./settings";
import { finishStartupTiming, markStartup } from "./startup-timing";
import { applyUiScale, bindUiZoom } from "./ui-zoom";
import { initStatusBar, showTransientStatus, updateStatus } from "./statusbar";
import { initToc, syncTocVisibility, toggleToc } from "./toc";
import { bindTabDrag, bindTabDragGlobal, initTabDrag } from "./tab-drag";
import { initGitMenu, showTreeMenu } from "./git-menu";
import {
  activeText,
  addRecent,
  buildSession,
  initSessionState,
  setRecent,
} from "./session-state";
import {
  hidePreview,
  initPreviewPanel,
  printActiveMarkdown,
  showBinary,
  showBinaryPanel,
  showPreview,
  togglePreview,
} from "./preview-panel";
import "./styles.css";

interface FilePayload {
  path: string;
  content: string;
  encoding: string;
  eol: "LF" | "CRLF";
  has_bom: boolean;
  mtime: number;
  size: number;
}

interface SaveResult {
  mtime: number;
  size: number;
}

const appWindow = getCurrentWebviewWindow();
const store = new TabStore();

const tabbar = document.getElementById("tabs") as HTMLDivElement;
const newTabButton = document.getElementById("new-tab") as HTMLButtonElement;
const editorHost = document.getElementById("editor-host") as HTMLDivElement;
const blockToggle = document.getElementById("block-toggle") as HTMLButtonElement;
const sidebar = document.getElementById("sidebar") as HTMLElement;
const sidebarResizer = document.getElementById("sidebar-resizer") as HTMLDivElement;
const rootCrumbs = document.getElementById("root-crumbs") as HTMLDivElement;
const rootUpButton = document.getElementById("root-up") as HTMLButtonElement;
const closeFolderButton = document.getElementById("close-folder") as HTMLButtonElement;

let switchingToken = 0;
/** 编辑器当前真正承载的是哪个标签，用于避免快速切换时状态互相覆盖 */
let displayedId: string | null = null;
// 自动换行是编辑器行为偏好：入口在设置面板（编辑器分类），这里只存状态。
// "0" 表示关闭，其余（含无记录）默认开启
let wrapEnabled = localStorage.getItem("fEditor.wrap") !== "0";
// 列块模式对所有可编辑标签共享，与主题一样记在本地
let blockMode = localStorage.getItem("fEditor.blockMode") === "1";
// 侧栏是否被用户手动收起；与“有没有打开文件夹”分开，避免收起后找不到入口
let treeCollapsed = false;
// 主题偏好存在 localStorage，重启后沿用；不写进会话文件以免改会话版本号
let theme: "light" | "dark" = localStorage.getItem("fEditor.theme") === "dark" ? "dark" : "light";

const editor = new EditorController(editorHost, {
  onChange: () => {
    const tab = store.active;
    if (tab) {
      tab.dirty = editor.state.doc.toString() !== tab.savedText;
    }
    updateStatus();
    scheduleSessionSave(buildSession);
  },
  onCursor: () => {
    updateStatus();
    scheduleSessionSave(buildSession);
  },
});

// 状态栏与目录模块依赖以上对象，注入后其内部函数即可直接使用
initStatusBar({ store, editor, appWindow });
initToc({ store });

const terminal = new TerminalPanel(
  document.getElementById("terminal-panel") as HTMLDivElement,
  document.getElementById("terminal-host") as HTMLDivElement,
  document.getElementById("terminal-title") as HTMLSpanElement,
);
const terminalCloseButton = document.getElementById("terminal-close") as HTMLButtonElement;
const terminalHost = document.getElementById("terminal-host") as HTMLDivElement;

// 设置面板切换自动换行（编辑器分类的开关）
window.addEventListener("set-wrap", (event) => {
  wrapEnabled = (event as CustomEvent<boolean>).detail;
  localStorage.setItem("fEditor.wrap", wrapEnabled ? "1" : "0");
  editor.setWrap(wrapEnabled);
});

// 设置面板切换主题：与视图菜单共用同一套状态与联动（编辑器/终端配色）
window.addEventListener("set-theme", (event) => {
  const next = (event as CustomEvent<"light" | "dark">).detail;
  if (next !== theme) {
    theme = next;
    localStorage.setItem("fEditor.theme", theme);
    applyTheme();
  }
});

// WebView2 自带右键菜单里有「书写方向」「更多工具」等无关项，且无法逐项裁剪，
// 因此整体屏蔽，各区域改用下面的自定义菜单
window.addEventListener("contextmenu", (event) => event.preventDefault());

function writeClipboard(text: string): void {
  if (!text) return;
  void invoke("clipboard_write", { text }).catch(() => undefined);
}

async function readClipboard(): Promise<string> {
  return invoke<string>("clipboard_read").catch(() => "");
}

/** 编辑器右键菜单：撤销/重做与剪贴板操作 */
editorHost.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  const view = editor.view;
  const { from, to } = view.state.selection.main;
  showContextMenu(event.clientX, event.clientY, [
    { type: "item", label: "撤销", action: () => undo(view) },
    { type: "item", label: "重做", action: () => redo(view) },
    { type: "separator" },
    {
      type: "item",
      label: "剪切",
      action: () => {
        const text = view.state.sliceDoc(from, to);
        if (!text) return;
        writeClipboard(text);
        view.dispatch(view.state.replaceSelection(""));
        view.focus();
      },
    },
    { type: "item", label: "复制", action: () => writeClipboard(view.state.sliceDoc(from, to)) },
    {
      type: "item",
      label: "粘贴",
      action: () => {
        void readClipboard().then((text) => {
          if (!text) return;
          view.dispatch(view.state.replaceSelection(text));
          view.focus();
        });
      },
    },
    { type: "separator" },
    {
      type: "item",
      label: "全选",
      action: () => {
        view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
        view.focus();
      },
    },
  ]);
});

/** 终端右键菜单：复制/粘贴/全选/清屏/关闭 */
terminalHost.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  showContextMenu(event.clientX, event.clientY, [
    { type: "item", label: "复制", action: () => writeClipboard(terminal.selectedText()) },
    {
      type: "item",
      label: "粘贴",
      action: () => {
        void readClipboard().then((text) => terminal.paste(text));
      },
    },
    { type: "item", label: "全选", action: () => terminal.selectAll() },
    { type: "separator" },
    { type: "item", label: "清屏", action: () => terminal.clear() },
    { type: "item", label: "关闭终端", action: () => void terminal.close() },
  ]);
});

const tree = new FileTree(document.getElementById("file-tree") as HTMLDivElement, {
  // 单击复用当前标签，双击新开标签；已在其他标签打开的文件直接切过去
  onOpenFile: (path, mode) => void openFileFromTree(path, mode),
  onContextMenu: (entry, event) => void showTreeMenu(entry, event),
  // 双击目录 = 把该目录设为工作区根，方便在上层/下层之间跳
  onSetRoot: (path) => void changeRoot(path),
  onStateChange: () => scheduleSessionSave(buildSession),
  onError: (text) => void message(text),
});

// 会话 / 标签拖拽 / Git 菜单 / 预览面板模块依赖以上对象，注入后即可直接使用
initSessionState({ store, editor, tree });
initTabDrag({
  store,
  afterReorder: () => {
    renderTabs();
    scheduleSessionSave(buildSession);
  },
});
initGitMenu({ tree, terminal, openPath });
initPreviewPanel({ store, editor, openPath });

/** 主题同时作用于界面外壳、编辑器语法色与集成终端 */
function applyTheme(): void {
  const dark = theme === "dark";
  document.documentElement.dataset.theme = theme;
  editor.setTheme(dark);
  terminal.setTheme(dark);
}


/** 列块模式开关：状态栏按钮与菜单共用，状态记在本地，对所有标签生效 */
function toggleBlockMode(): void {
  blockMode = !blockMode;
  localStorage.setItem("fEditor.blockMode", blockMode ? "1" : "0");
  editor.setBlockMode(blockMode);
  blockToggle.classList.toggle("on", blockMode);
  showTransientStatus(
    blockMode ? "列块模式：开（直接拖动即为矩形选择）" : "列块模式：关（按住 Alt 临时矩形选择）",
  );
}

/** 侧栏只在打开文件夹后显示，顶部面包屑展示当前根的路径 */
function syncSidebar(): void {
  const root = tree.currentRoot;
  const visible = root !== null && !treeCollapsed;
  sidebar.hidden = !visible;
  // 拖动条与侧栏同进同退，放在 JS 里控制避免依赖 DOM 相邻顺序
  sidebarResizer.hidden = !visible;
  renderCrumbs();
}

function renderCrumbs(): void {
  const root = tree.currentRoot;
  rootCrumbs.replaceChildren();
  rootUpButton.disabled = true;
  if (!root) return;

  const parts = splitPath(root);
  parts.forEach((part, index) => {
    if (index > 0) {
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.textContent = "›";
      rootCrumbs.appendChild(sep);
    }
    const crumb = document.createElement("button");
    crumb.className = "crumb";
    crumb.textContent = part.label;
    crumb.title = part.path;
    if (index === parts.length - 1) {
      crumb.classList.add("current");
    } else {
      crumb.addEventListener("click", () => void changeRoot(part.path));
    }
    rootCrumbs.appendChild(crumb);
  });
  rootUpButton.disabled = parts.length <= 1;
}

/** 切换工作区根：保留当前文件定位，往上走时不会丢失位置 */
async function changeRoot(path: string): Promise<void> {
  if (normalizePath(path) === normalizePath(tree.currentRoot ?? "")) return;
  const activePath = store.active?.path ?? "";
  if (!(await tree.setRoot(path))) return;
  treeCollapsed = false;
  syncSidebar();
  // 文件仍在新的根之下时会自动展开到它，相当于「记住我刚才在哪」
  if (activePath) tree.markActive(activePath);
}

/** ↑ 按钮：切到当前根目录的上一级 */
function goUpOneLevel(): void {
  const root = tree.currentRoot;
  if (!root) return;
  const parts = splitPath(root);
  if (parts.length <= 1) return;
  void changeRoot(parts[parts.length - 2].path);
}

/** 标签栏的文件树按钮：没打开文件夹时直接选目录，否则显示/收起侧栏 */
async function toggleTree(): Promise<void> {
  if (!tree.currentRoot) {
    await openFolder();
    return;
  }
  treeCollapsed = !treeCollapsed;
  syncSidebar();
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

function renderTabs(): void {
  tabbar.replaceChildren(
    ...store.tabs.map((tab) => {
      const item = document.createElement("div");
      item.className = "tab" + (tab.id === store.activeId ? " active" : "");
      item.title = tab.path ?? tab.title;

      const label = document.createElement("span");
      label.className = "tab-title";
      label.textContent = tab.title;
      item.appendChild(label);

      if (tab.dirty) {
        const dot = document.createElement("span");
        dot.className = "dirty";
        dot.textContent = "●";
        item.appendChild(dot);
      }

      const close = document.createElement("button");
      close.className = "tab-close";
      close.textContent = "×";
      close.title = "关闭标签（Ctrl/Cmd+W）";
      close.draggable = false;
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        void closeTab(tab.id);
      });
      item.appendChild(close);

      bindTabDrag(item, tab);
      item.addEventListener("click", () => void activate(tab.id));
      item.addEventListener("auxclick", (event) => {
        if (event.button === 1) {
          event.preventDefault();
          void closeTab(tab.id);
        }
      });
      return item;
    }),
  );
}

/** 按文件类型装载语法高亮，切换标签与重新加载共用同一套分派。 */
async function applyLanguage(title: string): Promise<void> {
  if (isMarkdown(title)) {
    await editor.ensureMarkdown();
  } else if (isJson(title)) {
    editor.ensureJson();
  } else if (isYaml(title)) {
    await editor.ensureYaml();
  } else if (isToml(title)) {
    await editor.ensureToml();
  }
}

/** 格式化当前文档：JSON 支持选区，YAML/TOML 整篇重排。 */
async function formatJsonTab(): Promise<void> {
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

async function loadTabContent(tab: Tab): Promise<void> {
  if (!tab.path) {
    tab.loaded = true;
    return;
  }
  try {
    const payload = await invoke<FilePayload>("read_file", { path: tab.path });
    applyPayload(tab, payload);
  } catch (error) {
    tab.error = String(error);
    tab.savedText = "";
  }
  tab.loaded = true;
}

function applyPayload(tab: Tab, payload: FilePayload): void {
  tab.path = payload.path;
  tab.title = basename(payload.path);
  tab.encoding = payload.encoding;
  tab.eol = payload.eol;
  tab.hasBom = payload.has_bom;
  tab.mtime = payload.mtime;
  tab.size = payload.size;
  tab.savedText = payload.content;
  tab.dirty = false;
  tab.error = null;
  tab.state = null;
  tab.langApplied = false;
}

function defaultPreview(tab: Tab): void {
  if (isMarkdown(tab.title) || isSvg(tab.title)) tab.preview = true;
}

/**
 * 切换标签时，若文件不在当前文件树的工作区内，就把树根切到该文件所在目录，
 * 避免左侧还停在旧文件夹、找不到当前文件。
 */
async function followTabFolder(tab: Tab): Promise<void> {
  const root = tree.currentRoot;
  if (!root || !tab.path) return;

  const unified = tab.path.replace(/\\/g, "/");
  const rootTrim = root.replace(/[\\/]+$/, "");
  if (normalizePath(unified).startsWith(`${normalizePath(rootTrim)}/`)) return;

  const cut = unified.lastIndexOf("/");
  if (cut <= 0) return;
  let parent = unified.slice(0, cut);
  // 盘符根目录（D:）要补斜杠才是有效路径
  if (/^[A-Za-z]:$/.test(parent)) parent = `${parent}/`;

  if (await tree.setRoot(parent)) {
    syncSidebar();
    showTransientStatus(`已切换到文件夹：${tree.currentRootName}`);
  }
}

let activationQueue: Promise<void> = Promise.resolve();

/**
 * 标签切换统一排队执行。
 * 切换里要读盘、建语法状态、渲染预览，都是异步的；
 * 允许并发就会出现“后点的还没跑完，先点的又把面板和编辑器改回去”，
 * 表现为内容空白、标题与高亮对不上、PDF 盖住文本。
 */
function activate(id: string, focus = true, followFolder = true): Promise<void> {
  const run = (): Promise<void> =>
    activateNow(id, focus, followFolder).catch((error) => {
      console.error("切换标签失败", error);
      showTransientStatus("切换标签失败，已忽略本次操作");
    });
  activationQueue = activationQueue.then(run, run);
  return activationQueue;
}

async function activateNow(id: string, focus: boolean, followFolder: boolean): Promise<void> {
  const token = (switchingToken += 1);
  const previous = store.active;
  // 只有编辑器里确实还是上一个标签时才回存，否则会把加载到一半的
  // 空状态写进别的标签（快速切标签时原本会互相覆盖）
  if (previous && previous.id !== id && displayedId === previous.id) {
    previous.state = editor.state;
    previous.scrollTop = editor.scrollTop;
  }

  const tab = store.get(id);
  if (!tab) return;
  // 类型以扩展名为准：缺失就补上，和扩展名不符说明是历史脏状态，一并重置
  const inferred = binaryKindOf(tab.path ?? tab.title) ?? undefined;
  if (tab.binary !== inferred) {
    tab.binary = inferred;
    tab.loaded = Boolean(inferred);
    tab.state = null;
    tab.dirty = false;
  }
  store.setActive(id);
  renderTabs();
  hidePreview();

  if (tab.binary) {
    // 二进制标签不需要文本编辑器，给一个只读空状态占住 editor，
    // 防止隐藏起来的上一个文档还被快捷键改到
    if (!tab.state) tab.state = editor.createState("", { readOnly: true });
    editor.setState(tab.state);
    displayedId = tab.id;
    showBinaryPanel();
    syncTocVisibility();
    // 标题不依赖预览内容，先同步掉：即使后面的渲染被打断，标题也和高亮一致
    updateStatus();
    await showBinary(tab);
    if (token !== switchingToken) return;
    if (followFolder) {
      await followTabFolder(tab);
      if (token !== switchingToken) return;
    }
    if (tab.path) tree.markActive(tab.path);
    updateStatus();
    scheduleSessionSave(buildSession);
    return;
  }

  if (!tab.loaded) {
    if (tab.path) {
      await loadTabContent(tab);
      if (token !== switchingToken) return;
      markStartup("文件读取");
    } else {
      // 未命名草稿的内容已在 savedText 里，不需要读盘
      tab.loaded = true;
    }
  }

  // 空文档 + 已有磁盘内容，说明状态被之前的中断写坏了，按磁盘内容重建
  const corrupted =
    tab.state !== null && tab.state.doc.length === 0 && !tab.dirty && tab.savedText.length > 0;
  if (!tab.state || corrupted) {
    const text = tab.error ? `文件已丢失：${tab.path ?? ""}` : tab.savedText;
    tab.state = editor.createState(text, {
      readOnly: Boolean(tab.error),
      cursor: tab.pendingCursor,
    });
    tab.pendingCursor = null;
    tab.loaded = true;
    markStartup("编辑器状态");
  }

  editor.setState(tab.state);
  displayedId = tab.id;
  editor.setWrap(wrapEnabled);
  // 非活动标签的状态保留着创建时的主题，切回来时统一校准一次
  editor.setTheme(theme === "dark");

  if (!tab.langApplied) {
    await applyLanguage(tab.title);
    if (token !== switchingToken) return;
    tab.langApplied = true;
    markStartup("语法高亮");
  }

  if (tab.preview && (isMarkdown(tab.title) || isSvg(tab.title))) {
    await showPreview(tab);
    markStartup("预览渲染");
  }

  requestAnimationFrame(() => {
    editor.setScrollTop(tab.scrollTop);
  });
  if (focus && !tab.preview) editor.focus();
  // 切换标签时让文件树跟随：先确保工作区覆盖当前文件，再定位高亮
  if (followFolder) {
    await followTabFolder(tab);
    if (token !== switchingToken) return;
  }
  if (tab.path) tree.markActive(tab.path);
  updateStatus();
  scheduleSessionSave(buildSession);
}

async function openPath(path: string, activateAfter = true): Promise<void> {
  const normalized = normalizePath(path);
  const existing = store.tabs.find(
    (tab) => tab.path && normalizePath(tab.path) === normalized,
  );
  if (existing) {
    if (activateAfter) await activate(existing.id);
    return;
  }

  const binary = binaryKindOf(path);
  if (binary) {
    await openBinaryTab(path, binary, activateAfter);
    return;
  }

  let payload: FilePayload;
  try {
    payload = await invoke<FilePayload>("read_file", { path });
  } catch (error) {
    await message(`无法打开文件：\n${path}\n\n${error}`);
    return;
  }

  const tab = createTab({ path: payload.path, loaded: true });
  applyPayload(tab, payload);
  defaultPreview(tab);
  store.add(tab);
  addRecent(payload.path);
  renderTabs();
  if (activateAfter) await activate(tab.id);
  scheduleSessionSave(buildSession);
}

/** PDF / Word / 图片 / 音频只进只读预览标签，不读文本、不建编辑器状态 */
async function openBinaryTab(
  path: string,
  kind: BinaryKind,
  activateAfter: boolean,
): Promise<void> {
  const tab = createTab({
    path,
    title: basename(path),
    binary: kind,
    loaded: true,
    encoding: "—",
  });
  store.add(tab);
  addRecent(path);
  renderTabs();
  if (activateAfter) await activate(tab.id);
  scheduleSessionSave(buildSession);
}

/**
 * 文件树打开文件：双击始终新开标签；
 * 单击复用当前标签，但目标已在别的标签里打开时改为切过去，避免同一文件出现两份内容。
 */
async function openFileFromTree(path: string, mode: OpenMode): Promise<void> {
  const normalized = normalizePath(path);
  const opened = store.tabs.find(
    (tab) => tab.path && normalizePath(tab.path) === normalized,
  );
  if (opened) {
    await activate(opened.id);
    return;
  }

  // PDF / Word / 图片 / 音频是只读预览标签，不能顶替当前文本标签
  if (binaryKindOf(path)) {
    await openPath(path);
    return;
  }

  const current = store.active;
  if (mode === "newTab" || !current) {
    await openPath(path);
    return;
  }

  // 当前标签是只读预览（PDF / Word / 图片 / 音频）时不能拿来复用成文本，
  // 否则类型会沿用上一个文件，出现 .md 被按 PDF 渲染这种错乱
  if (current.binary) {
    await openPath(path);
    return;
  }

  if (current.dirty) {
    const choice = await ask("当前标签有未保存的修改，是否保存后再打开？", [
      { label: "保存并打开", value: "save", primary: true },
      { label: "放弃修改", value: "discard" },
      { label: "取消", value: "cancel" },
    ]);
    if (choice === "cancel") return;
    if (choice === "save" && !(await saveTab(current))) return;
  }

  let payload: FilePayload;
  try {
    payload = await invoke<FilePayload>("read_file", { path });
  } catch (error) {
    await message(`无法打开文件：\n${path}\n\n${error}`);
    return;
  }
  // 读取期间用户可能已经切走，此时复用会覆盖错的文件
  if (store.activeId !== current.id) return;

  replaceTabFile(current, payload);
  addRecent(payload.path);
  await activate(current.id);
  scheduleSessionSave(buildSession);
}

/** 把文件内容装进指定标签；state 置空交给 activate 重建编辑器状态 */
function replaceTabFile(tab: Tab, payload: FilePayload): void {
  applyPayload(tab, payload);
  tab.state = null;
  tab.loaded = true;
  tab.scrollTop = 0;
  tab.pendingCursor = null;
  tab.preview = false;
  defaultPreview(tab);
}

function newTab(): void {
  const tab = createTab({ loaded: true });
  store.add(tab);
  tab.state = editor.createState("");
  tab.savedText = "";
  renderTabs();
  void activate(tab.id);
}

async function saveTab(tab: Tab, force = false): Promise<boolean> {
  if (tab.binary) return false;
  if (tab.error) {
    await message("原文件已不存在，无法保存当前内容。");
    return false;
  }
  let targetPath = tab.path;
  if (!targetPath) {
    const picked = await invoke<string | null>("pick_save_path", {
      defaultName: `${tab.title}.md`,
    });
    if (!picked) return false;
    targetPath = picked;
  }

  const text = activeText(tab);

  // YAML/TOML 的缩进错误往往肉眼难辨，保存前先做一次语法检查
  const title = targetPath ? basename(targetPath) : tab.title;
  if (isYaml(title) || isToml(title)) {
    const problem = isYaml(title) ? await checkYaml(text) : await checkToml(text);
    if (problem) {
      const choice = await ask(`语法检查未通过：\n${problem}\n\n仍要保存吗？`, [
        { label: "仍要保存", value: "save" },
        { label: "取消", value: "cancel", primary: true },
      ]);
      if (choice !== "save") return false;
    }
  }

  try {
    const result = await invoke<SaveResult>("save_file", {
      path: targetPath,
      content: text,
      encoding: tab.encoding,
      eol: tab.eol,
      hasBom: tab.hasBom,
      expectedMtime: force ? 0 : tab.mtime,
    });

    tab.path = targetPath;
    tab.title = basename(targetPath);
    tab.mtime = result.mtime;
    tab.size = result.size;
    tab.savedText = text;
    tab.dirty = false;
    tab.error = null;
    addRecent(targetPath);
    if (tab.id === store.activeId) {
      tab.state = editor.state;
    }
    renderTabs();
    updateStatus();
    scheduleSessionSave(buildSession);
    return true;
  } catch (error) {
    const raw = String(error);
    if (raw.includes("EXTERNAL_MODIFIED")) {
      const choice = await ask("文件已被其他程序修改，如何处理？", [
        { label: "重新打开", value: "reload" },
        { label: "仍要覆盖", value: "overwrite" },
        { label: "取消", value: "cancel", primary: true },
      ]);
      if (choice === "overwrite") return saveTab(tab, true);
      if (choice === "reload") {
        await reloadTab(tab);
        return false;
      }
      return false;
    }
    await message(`保存失败：\n${raw}`);
    return false;
  }
}

async function reloadTab(tab: Tab): Promise<void> {
  if (!tab.path) return;
  try {
    const payload = await invoke<FilePayload>("read_file", { path: tab.path });
    applyPayload(tab, payload);
    tab.state = editor.createState(payload.content, { cursor: 0 });
    tab.loaded = true;
    if (tab.id === store.activeId) {
      editor.setState(tab.state);
      await applyLanguage(tab.title);
      tab.langApplied = true;
      if (tab.preview) {
        await showPreview(tab);
      } else {
        hidePreview();
      }
      updateStatus();
    }
    renderTabs();
  } catch (error) {
    await message(`重新打开失败：\n${error}`);
  }
}

async function closeTab(id: string): Promise<void> {
  const tab = store.get(id);
  if (!tab) return;
  if (tab.dirty) {
    const choice = await ask(`“${tab.title}”有未保存的修改。`, [
      { label: "保存", value: "save", primary: true },
      { label: "不保存", value: "discard" },
      { label: "取消", value: "cancel" },
    ]);
    if (choice === "cancel") return;
    if (choice === "save" && !(await saveTab(tab))) return;
  }

  const wasActive = tab.id === store.activeId;
  if (tab.binary) disposeBinaryTab(tab.path);
  store.remove(id);
  if (displayedId === id) displayedId = null;
  if (store.tabs.length === 0) {
    newTab();
    return;
  }
  renderTabs();
  if (wasActive) {
    await activate(store.activeId as string);
  }
  updateStatus();
  scheduleSessionSave(buildSession);
}

function cycleTab(direction: 1 | -1): void {
  if (store.tabs.length < 2) return;
  const index = store.tabs.findIndex((tab) => tab.id === store.activeId);
  const next = (index + direction + store.tabs.length) % store.tabs.length;
  void activate(store.tabs[next].id);
}

async function openFiles(): Promise<void> {
  try {
    const paths = await invoke<string[]>("pick_open_files");
    for (const path of paths) {
      await openPath(path);
    }
  } catch (error) {
    await message(`打开对话框失败：\n${error}`);
  }
}

async function openFolder(): Promise<void> {
  try {
    const picked = await invoke<string | null>("pick_open_folder");
    if (!picked) return;
    await openFolderPath(picked);
  } catch (error) {
    await message(`打开文件夹失败：\n${error}`);
  }
}

async function openFolderPath(path: string): Promise<void> {
  if (!(await tree.setRoot(path))) return;
  // 新打开文件夹时强制展开侧栏，否则用户可能看不到刚打开的内容
  treeCollapsed = false;
  syncSidebar();
  showTransientStatus(`已打开文件夹：${tree.currentRootName}`);
  scheduleSessionSave(buildSession);
}

/** 拖入文件夹时切换工作区，拖入文件时仍按普通文件打开 */
async function handleDropped(paths: string[]): Promise<void> {
  for (const path of paths) {
    try {
      const info = await invoke<{ path: string; isDir: boolean; parent: string | null }>(
        "inspect_path",
        { path },
      );
      if (info.isDir) {
        await openFolderPath(info.path);
      } else {
        await openPath(info.path);
      }
    } catch (error) {
      await message(`无法打开：\n${path}\n\n${error}`);
    }
  }
}

function ensureEditMode(): boolean {
  const tab = store.active;
  if (!tab) return false;
  if (tab.binary) {
    showTransientStatus("该文件为只读预览");
    return false;
  }
  if (tab.preview) {
    tab.preview = false;
    hidePreview();
    updateStatus();
  }
  return true;
}

async function openSearchInEditor(withReplace: boolean): Promise<void> {
  if (!ensureEditMode()) return;
  editor.focus();
  await editor.openSearch(withReplace);
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
  const path = store.active?.path ?? "";
  if (path) {
    const dir = path.replace(/[\\/][^\\/]+$/, "");
    if (dir && dir !== path) return dir;
  }
  return tree.currentRoot;
}

interface PrintResultPayload {
  path: string;
  error: string | null;
}

/** PDF 生成完毕：在 fEditor 里以只读标签打开，等同打印预览；打印可交给系统预览 */
async function handlePrintDone(payload: PrintResultPayload): Promise<void> {
  if (payload.error) {
    await message(`打印预览失败：\n${payload.error}`);
    return;
  }
  const normalized = normalizePath(payload.path);
  const existing = store.tabs.find((tab) => tab.path && normalizePath(tab.path) === normalized);
  // 同名预览已打开时先关再开，保证展示的是最新内容
  if (existing) await closeTab(existing.id);
  await openPath(payload.path);
  showTransientStatus("打印预览已生成，需要打印可用系统的「预览」打开该 PDF");
}

async function handleMenuAction(action: string): Promise<void> {
  if (action === "format.document") {
    await formatJsonTab();
    return;
  }

  const format = formatActions[action];
  if (format) {
    if (!ensureEditMode() || !store.active) return;
    applyMarkdownAction(editor.view, format);
    editor.focus();
    return;
  }

  switch (action) {
    case "file.open":
      await openFiles();
      break;
    case "folder.open":
      await openFolder();
      break;
    case "view.tree":
      await toggleTree();
      break;
    case "view.toc":
      toggleToc();
      break;
    case "view.terminal":
      await toggleTerminal();
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
      toggleBlockMode();
      break;
    case "help.about":
      await showAbout();
      break;
    default:
      break;
  }
}

/** 归一化成菜单里书写的组合键形式，macOS 的 Cmd 统一按 Ctrl 处理 */
function shortcutCombo(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return [...parts, key].join("+");
}

function bindShortcuts(): void {
  // 原生菜单加速键在 WebView2 下不会真正触发，菜单里定义的快捷键全部在此兜底
  const menuShortcuts: Record<string, string> = {
    "Ctrl+O": "file.open",
    "Ctrl+Shift+O": "folder.open",
    "Ctrl+Shift+E": "view.tree",
    "Ctrl+`": "view.terminal",
    "Ctrl+S": "file.save",
    "Ctrl+F": "edit.find",
    "Ctrl+H": "edit.replace",
    "Ctrl+E": "view.preview",
    "Ctrl+B": "format.bold",
    "Ctrl+I": "format.italic",
    "Ctrl+Shift+X": "format.strike",
    "Ctrl+Alt+1": "format.h1",
    "Ctrl+Alt+2": "format.h2",
    "Ctrl+Alt+3": "format.h3",
    "Ctrl+Alt+L": "format.bullet",
    "Ctrl+Alt+O": "format.ordered",
    "Ctrl+Alt+Q": "format.quote",
    "Ctrl+Alt+K": "format.link",
    "Ctrl+Alt+C": "format.code",
    "Ctrl+Alt+J": "format.document",
    "Ctrl+Alt+B": "edit.block",
  };

  window.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement | null;
    // 焦点在集成终端、输入弹窗或查找弹框里时，按键属于该控件本身，不能被编辑器快捷键拦截
    if (target?.closest?.(".xterm") || target === modalInput || target?.closest?.(".find-card"))
      return;

    const action = menuShortcuts[shortcutCombo(event)];
    if (action) {
      event.preventDefault();
      void handleMenuAction(action);
      return;
    }

    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (!mod && event.key === "F3") {
      event.preventDefault();
      void (event.shiftKey ? findPrevious(editor.view) : findNext(editor.view));
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
      void (event.shiftKey ? findPrevious(editor.view) : findNext(editor.view));
      return;
    }
    if (key === "enter" && event.altKey) {
      event.preventDefault();
      void replaceAllMatches(editor.view);
      return;
    }
  });
}

async function boot(): Promise<void> {
  bindShortcuts();
  bindTabDragGlobal();
  // 尽早应用主题，避免深色用户先看到一帧浅色界面
  applyTheme();
  // 恢复上次的界面缩放，同样要赶在首帧之前
  applyUiScale();
  bindUiZoom();
  // 恢复上次的编辑器字号与字体外观，同样赶在首帧之前，避免先按默认值排一帧再跳
  initFontSize();
  initEditorAppearance();
  // 恢复上次的文件树宽度，避免首帧先按默认宽度排版再跳动
  applySidebarWidth();
  bindSidebarResizer();
  applyTocWidth();
  bindPreviewResizer();
  applyTerminalHeight();
  bindTerminalResizer();
  // 列块模式是纯前端行为，直接恢复上次状态并同步状态栏按钮
  editor.setBlockMode(blockMode);
  blockToggle.classList.toggle("on", blockMode);
  blockToggle.addEventListener("click", () => toggleBlockMode());
  newTabButton.addEventListener("click", () => newTab());
  // 只收起侧栏、保留工作区，随时可通过标签栏的 ☰ 或 Ctrl+Shift+E 唤回
  closeFolderButton.addEventListener("click", () => {
    treeCollapsed = true;
    syncSidebar();
  });
  rootUpButton.addEventListener("click", goUpOneLevel);
  terminalCloseButton.addEventListener("click", () => void terminal.close());
  syncSidebar();
  syncTocVisibility();
  markStartup("界面初始化");

  try {
    await listen<string>("menu-action", (event) => {
      void handleMenuAction(event.payload);
    });
    await listen<PrintResultPayload>("print-pdf-done", (event) => {
      void handlePrintDone(event.payload);
    });
  } catch (error) {
    console.warn("注册菜单事件失败", error);
  }
  markStartup("菜单事件就绪");

  // 会话、命令行参数与右键菜单目录互不依赖，并发取回，减少串行 IPC 等待
  const [session, cli, cliDir] = await Promise.all([
    loadSession(),
    invoke<string[]>("cli_files").catch(() => [] as string[]),
    invoke<string | null>("cli_dir").catch(() => null),
  ]);
  markStartup("会话读取");
  if (session) {
    setRecent(session.recent ?? []);
    for (const saved of session.tabs) {
      if (!saved.path) continue;
      // 标题始终是文件名，完整目录通过标签的悬停提示展示
      const title = basename(saved.path);
      // 类型始终按扩展名重新判定：旧会话里的 binary 字段可能和文件对不上
      const binary = binaryKindOf(title) ?? undefined;
      store.add(
        createTab({
          id: saved.id,
          path: saved.path,
          title,
          encoding: binary ? "—" : saved.encoding || "UTF-8",
          eol: saved.eol === "CRLF" ? "CRLF" : "LF",
          hasBom: Boolean(saved.hasBom),
          mtime: saved.mtime ?? 0,
          scrollTop: saved.scrollTop ?? 0,
          pendingCursor: saved.cursor ?? 0,
          preview: isMarkdown(title) || isSvg(title),
          binary,
          loaded: Boolean(binary),
        }),
      );
    }
    for (const draft of session.drafts ?? []) {
      const title = draft.title || nextUntitledTitle();
      noteUntitledTitle(title);
      store.add(
        createTab({
          id: draft.id,
          title,
          savedText: draft.text,
          scrollTop: draft.scrollTop ?? 0,
          pendingCursor: draft.cursor ?? 0,
          loaded: false,
        }),
      );
    }
  }

  // 先让编辑器把内容显示出来，用户不必等目录扫描完成。
  // 右键菜单打开时以传入目录为工作区；其余情况恢复上次的文件夹，
  // 上次的文件夹可能已被移动或删除，恢复失败时静默忽略，不打断启动。
  const rootToOpen = cliDir ?? session?.root ?? null;
  const treeReady = rootToOpen
    ? tree.setRoot(rootToOpen, true).then(async (opened) => {
        if (!opened) return;
        // 展开集合属于上次的根目录，切换目录时不能套用
        if (!cliDir) await tree.restoreExpanded(session?.treeExpanded ?? []);
        syncSidebar();
        // 目录扫描期间用户可能已切换标签，这里按当前标签补一次定位高亮
        const current = store.active;
        if (current?.path) tree.markActive(current.path);
      })
    : Promise.resolve();

  if (store.tabs.length === 0 && cli.length === 0) {
    newTab();
  } else if (store.tabs.length > 0) {
    const target =
      (session?.activeId && store.get(session.activeId)?.id) ||
      store.tabs[0].id;
    // 启动恢复时保持上次保存的文件夹，不因激活标签而切换工作区
    await activate(target, false, false);
    markStartup("首屏文件就绪");
  }

  for (const path of cli) {
    await openPath(path, true);
  }

  // 首屏内容已经进编辑器，立刻显示窗口；
  // 目录扫描和事件注册放到显示之后，大目录时也不会拖慢开窗
  revealWindow();

  await treeReady;
  markStartup("文件树恢复");

  try {
    await appWindow.onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        void handleDropped(event.payload.paths);
      }
    });
  } catch (error) {
    console.warn("注册拖拽事件失败", error);
  }

  try {
    await appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      const dirtyTabs = store.tabs.filter((tab) => tab.dirty);
      if (dirtyTabs.length > 0) {
        const choice = await ask(`有 ${dirtyTabs.length} 个标签未保存，确定退出吗？`, [
          { label: "保存全部", value: "save", primary: true },
          { label: "不保存退出", value: "discard" },
          { label: "取消", value: "cancel" },
        ]);
        if (choice === "cancel") return;
        if (choice === "save") {
          for (const tab of dirtyTabs) {
            const saved = await saveTab(tab);
            if (!saved) return;
          }
        }
      }
      await flushSession(buildSession);
      // 先结束终端进程再退出，否则 PTY 子进程会残留
      await terminal.close();
      await appWindow.destroy();
    });
  } catch (error) {
    console.warn("注册关闭事件失败", error);
  }

  window.addEventListener("beforeunload", () => {
    void flushSession(buildSession);
  });

  finishStartupTiming();
}

let windowRevealed = false;

/**
 * 窗口在 tauri.conf.json 里初始隐藏，等两帧渲染完成再显示。
 * WebView2 初始化期间窗口是纯白的，先显示会看到 1-2 秒白屏；
 * 隐藏后直接出现在内容已绘制好的画面上，观感是「一点就开」。
 */
function revealWindow(): void {
  if (windowRevealed) return;
  windowRevealed = true;
  const show = () => {
    // 权限缺失或窗口已销毁时会失败，静默忽略即可（Rust 侧还有兜底）
    void appWindow
      .show()
      .then(() => {
        markStartup("窗口显示");
        return appWindow.setFocus();
      })
      .catch(() => undefined);
  };
  requestAnimationFrame(() => requestAnimationFrame(show));
  // 双 rAF 在某些情况下（窗口未显示时合成器降频）可能不触发，加个短定时器保底
  window.setTimeout(show, 200);
}

// 打印窗口复用同一份前端：按窗口标签分流，主窗口才启动完整界面
if (appWindow.label === "print") {
  void import("./print-mode");
} else {
  void boot().catch((error) => {
    console.error("启动失败", error);
    // 启动流程出错也要把窗口放出来，否则用户只看到一个任务栏图标
    revealWindow();
  });

  // 兜底：启动流程卡住时也要尽快把窗口放出来，避免长时间「点了没反应」
  window.setTimeout(revealWindow, 1500);
}
