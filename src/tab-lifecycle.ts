import { invoke } from "@tauri-apps/api/core";
import { disposeBinaryTab } from "./binary-preview";
import { app } from "./app-context";
import { ask } from "./dialogs";
import {
  hidePreview,
  showBinary,
  showBinaryPanel,
  showPreview,
  stagePreviewPanel,
} from "./preview-panel";
import { isMindText } from "./mindmap";
import { scheduleSessionSave } from "./session";
import { buildSession } from "./session-state";
import { showTransientStatus, updateStatus } from "./statusbar";
import { markStartup } from "./startup-timing";
import { syncTocVisibility } from "./toc";
import {
  basename,
  binaryKindOf,
  isCsv,
  isJson,
  isMarkdown,
  isSvg,
  isToml,
  isYaml,
  normalizePath,
  type Tab,
} from "./tabs";

export interface FilePayload {
  path: string;
  content: string;
  encoding: string;
  eol: "LF" | "CRLF";
  has_bom: boolean;
  mtime: number;
  size: number;
}

interface TabLifecycleDeps {
  renderTabs(): void;
  syncSidebar(): void;
  saveTab(tab: Tab, force?: boolean): Promise<boolean>;
  newTab(): void;
}

let deps: TabLifecycleDeps;

/** main.ts 装配完成后注入跨界回调，避免与标签渲染/保存模块互相 import */
export function initTabLifecycle(d: TabLifecycleDeps): void {
  deps = d;
}

let switchingToken = 0;
/** 编辑器当前真正承载的是哪个标签，用于避免快速切换时状态互相覆盖 */
let displayedId: string | null = null;
let activationQueue: Promise<void> = Promise.resolve();

/** 按文件类型装载语法高亮，切换标签与重新加载共用同一套分派。 */
export async function applyLanguage(title: string): Promise<void> {
  const { editor } = app;
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

export async function loadTabContent(tab: Tab): Promise<void> {
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

export function applyPayload(tab: Tab, payload: FilePayload): void {
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

export function defaultPreview(tab: Tab): void {
  // CSV/TSV 默认进表格预览：数据文件以"看表"为主，需要编辑时 Ctrl+E 切回文本
  if (isMarkdown(tab.title) || isSvg(tab.title) || isCsv(tab.title)) tab.preview = true;
}

/**
 * 切换标签时，若文件不在当前文件树的工作区内，就把树根切到该文件所在目录，
 * 避免左侧还停在旧文件夹、找不到当前文件。
 */
async function followTabFolder(tab: Tab): Promise<void> {
  const { tree } = app;
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
    deps.syncSidebar();
    showTransientStatus(`已切换到文件夹：${tree.currentRootName}`);
  }
}

/**
 * 标签切换统一排队执行。
 * 切换里要读盘、建语法状态、渲染预览，都是异步的；
 * 允许并发就会出现“后点的还没跑完，先点的又把面板和编辑器改回去”，
 * 表现为内容空白、标题与高亮对不上、PDF 盖住文本。
 */
export function activate(id: string, focus = true, followFolder = true): Promise<void> {
  const run = (): Promise<void> =>
    activateNow(id, focus, followFolder).catch((error) => {
      console.error("切换标签失败", error);
      showTransientStatus("切换标签失败，已忽略本次操作");
    });
  activationQueue = activationQueue.then(run, run);
  return activationQueue;
}

async function activateNow(id: string, focus: boolean, followFolder: boolean): Promise<void> {
  const { store, editor, tree } = app;
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
  deps.renderTabs();
  hidePreview();
  // 预览型标签先切到预览面板占位，避免渲染完成前编辑器原文先闪现
  const willPreview =
    !tab.binary &&
    tab.preview &&
    (isMarkdown(tab.title) || isSvg(tab.title) || isMindText(tab.title) || isCsv(tab.title));
  if (willPreview) stagePreviewPanel();

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
  editor.setWrap(app.wrapEnabled);
  // 非活动标签的状态保留着创建时的主题，切回来时统一校准一次
  editor.setTheme(app.theme === "dark");

  // 预览渲染与语法高亮互不依赖，并行执行缩短等待；编辑器状态已就绪，
  // showPreview 里 activeText 能立刻取到当前内容
  const previewTask = willPreview ? showPreview(tab) : Promise.resolve();

  if (!tab.langApplied) {
    await applyLanguage(tab.title);
    if (token !== switchingToken) return;
    tab.langApplied = true;
    markStartup("语法高亮");
  }

  await previewTask;
  if (token !== switchingToken) return;
  if (willPreview) markStartup("预览渲染");

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

export async function closeTab(id: string): Promise<void> {
  const { store } = app;
  const tab = store.get(id);
  if (!tab) return;
  if (tab.dirty) {
    const choice = await ask(`“${tab.title}”有未保存的修改。`, [
      { label: "保存", value: "save", primary: true },
      { label: "不保存", value: "discard" },
      { label: "取消", value: "cancel" },
    ]);
    if (choice === "cancel") return;
    if (choice === "save" && !(await deps.saveTab(tab))) return;
  }

  const wasActive = tab.id === store.activeId;
  if (tab.binary) disposeBinaryTab(tab.path);
  store.remove(id);
  if (displayedId === id) displayedId = null;
  if (store.tabs.length === 0) {
    deps.newTab();
    return;
  }
  deps.renderTabs();
  if (wasActive) {
    await activate(store.activeId as string);
  }
  updateStatus();
  scheduleSessionSave(buildSession);
}

export function cycleTab(direction: 1 | -1): void {
  const { store } = app;
  if (store.tabs.length < 2) return;
  const index = store.tabs.findIndex((tab) => tab.id === store.activeId);
  const next = (index + direction + store.tabs.length) % store.tabs.length;
  void activate(store.tabs[next].id);
}
