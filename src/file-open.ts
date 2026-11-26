import { invoke } from "@tauri-apps/api/core";
import { app } from "./app-context";
import { disposeBinaryTab, getActiveAudioPath, setAutoplay } from "./binary-preview";
import { ask, message } from "./dialogs";
import { hidePreview } from "./preview-panel";
import { scheduleSessionSave } from "./session";
import { activeText, addRecent, buildSession } from "./session-state";
import { showTransientStatus, updateStatus } from "./statusbar";
import {
  activate,
  applyPayload,
  closeTab,
  defaultPreview,
  readTextFile,
  type FilePayload,
  type ReadTextResult,
} from "./tab-lifecycle";
import {
  basename,
  binaryKindOf,
  createTab,
  isSvg,
  nextUntitledTitle,
  normalizePath,
  type BinaryKind,
  type Tab,
} from "./tabs";
import { isWhiteboardText, WHITEBOARD_SKELETON } from "./whiteboard";
import { expandSidebar } from "./sidebar";
import { saveTab } from "./tab-save";
import { tryInsertDroppedImages } from "./md-image";
import type { OpenMode } from "./file-tree";

interface PrintResultPayload {
  path: string;
  error: string | null;
}

interface FileOpenDeps {
  renderTabs(): void;
  /** 顺序播放换歌后强制重渲染媒体面板 */
  refreshBinaryView(tab: Tab): Promise<void>;
}

let deps: FileOpenDeps;

export function initFileOpen(d: FileOpenDeps): void {
  deps = d;
}

export async function openPath(path: string, activateAfter = true, record = false): Promise<void> {
  const { store } = app;
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
    await openBinaryTab(path, binary, activateAfter, record);
    return;
  }

  let result: ReadTextResult;
  try {
    result = await readTextFile(path);
  } catch (error) {
    await message(`无法打开文件：\n${path}\n\n${error}`);
    return;
  }
  // 用户在超大文件提示里选择取消，不创建标签
  if (result.kind === "cancel") return;
  if (result.kind === "large") {
    await openLargeTab(path, result.size, activateAfter, record);
    return;
  }
  const payload = result.payload;

  const tab = createTab({ path: payload.path, loaded: true });
  applyPayload(tab, payload);
  // 画板保存的 svg 带标记，重新打开后继续以可视化画板编辑
  if (isSvg(tab.title) && isWhiteboardText(payload.content)) {
    tab.canvas = true;
    tab.preview = true;
  } else {
    defaultPreview(tab);
  }
  store.add(tab);
  if (record) addRecent(payload.path);
  deps.renderTabs();
  if (activateAfter) await activate(tab.id);
  scheduleSessionSave(buildSession);
}

/** 超大文本：创建只读分块标签，正文由翻页按需从磁盘加载 */
async function openLargeTab(
  path: string,
  size: number,
  activateAfter: boolean,
  record = false,
): Promise<void> {
  const { store } = app;
  const tab = createTab({
    path,
    title: basename(path),
    loaded: true,
    size,
    // 编码与块范围在首次加载时由 Rust 的探测结果覆盖
    encoding: "—",
    large: { total: size, start: 0, end: 0, encoding: "—" },
  });
  store.add(tab);
  if (record) addRecent(path);
  deps.renderTabs();
  if (activateAfter) await activate(tab.id);
  scheduleSessionSave(buildSession);
}

/** 顺序播放 / 列表循环切歌：复用当前音频标签，避免每首歌都新开一个页签 */
export async function openMediaReplacingCurrent(path: string): Promise<void> {
  const { store } = app;
  const normalized = normalizePath(path);
  const existing = store.tabs.find(
    (tab) => tab.path && normalizePath(tab.path) === normalized,
  );
  if (existing) {
    await activate(existing.id);
    return;
  }

  const active = store.active;
  // 用户可能已切到别的标签，但要替换的应该是「正在播放的那个」音频标签，
  // 只看活动标签会导致每次切歌都多开一个页签
  const playingPath = getActiveAudioPath();
  const current =
    active && active.binary === "audio" && active.path
      ? active
      : playingPath
        ? store.tabs.find(
            (tab) => tab.path && normalizePath(tab.path) === normalizePath(playingPath),
          ) ?? null
        : null;
  // 找不到可复用的音频标签时（比如从没播放过）退化成普通打开
  if (!current || !current.path) {
    await openPath(path);
    return;
  }

  // 先停掉上一首，否则旧音频会与新文件同时出声
  disposeBinaryTab(current.path);
  current.path = path;
  current.title = basename(path);
  current.loaded = true;
  deps.renderTabs();
  // 当前就在这个音频标签上：直接重渲染面板。
  // 同一个标签再次 activate 会被切换队列/token 拦截，
  // 表现为页签标题变了、播放器还停在上一首
  if (store.activeId === current.id) {
    await deps.refreshBinaryView(current);
  } else {
    await activate(current.id);
  }
  scheduleSessionSave(buildSession);
}

/** PDF / Word / 图片 / 音频只进只读预览标签，不读文本、不建编辑器状态 */
async function openBinaryTab(
  path: string,
  kind: BinaryKind,
  activateAfter: boolean,
  record = false,
): Promise<void> {
  const { store } = app;
  const tab = createTab({
    path,
    title: basename(path),
    binary: kind,
    loaded: true,
    encoding: "—",
  });
  store.add(tab);
  if (record) addRecent(path);
  deps.renderTabs();
  if (activateAfter) await activate(tab.id);
  scheduleSessionSave(buildSession);
}

/**
 * 文件树打开文件：双击始终复用当前标签；
 * 目标已在别的标签里打开时改为切过去，避免同一文件出现两份内容。
 */
export async function openFileFromTree(path: string, mode: OpenMode): Promise<void> {
  const { store } = app;
  const normalized = normalizePath(path);
  const kind = binaryKindOf(path);
  // 双击音频立即播放：提前标记，等标签渲染完成后自动开始
  if (kind === "audio") setAutoplay(path);

  const opened = store.tabs.find(
    (tab) => tab.path && normalizePath(tab.path) === normalized,
  );
  if (opened) {
    await activate(opened.id);
    return;
  }

  // PDF / Word / 图片 / 音频是只读预览标签，不能顶替当前文本标签
  if (kind) {
    // 当前已经是音频标签时复用它，避免每双击一首就多一个页签
    if (kind === "audio" && store.active?.binary === "audio") {
      await openMediaReplacingCurrent(path);
    } else {
      await openPath(path);
    }
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

  let result: ReadTextResult;
  try {
    result = await readTextFile(path);
  } catch (error) {
    await message(`无法打开文件：\n${path}\n\n${error}`);
    return;
  }
  // 用户在超大文件提示里选择取消，保持当前标签内容不变
  if (result.kind === "cancel") return;
  // 读取期间用户可能已经切走，此时复用会覆盖错的文件
  if (store.activeId !== current.id) return;

  if (result.kind === "large") {
    // 复用当前标签改为只读分块模式，内容等激活时再按块加载
    current.binary = undefined;
    current.path = path;
    current.title = basename(path);
    current.large = { total: result.size, start: 0, end: 0, encoding: "…" };
    current.size = result.size;
    current.dirty = false;
    current.error = null;
    current.state = null;
    current.loaded = true;
    current.scrollTop = 0;
    await activate(current.id);
    scheduleSessionSave(buildSession);
    return;
  }

  replaceTabFile(current, result.payload);
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

export function newTab(): void {
  const { store, editor } = app;
  const tab = createTab({ loaded: true });
  store.add(tab);
  tab.state = editor.createState("");
  tab.savedText = "";
  deps.renderTabs();
  void activate(tab.id);
}

/* ---- 最近关闭的标签 ---- */

interface ClosedSnapshot {
  path: string | null;
  title: string;
  text: string;
  encoding: string;
  eol: "LF" | "CRLF";
  hasBom: boolean;
  binary?: BinaryKind;
  canvas?: boolean;
}

const closedStack: ClosedSnapshot[] = [];
/** 只保留最近若干条，避免长时间运行后占用内存 */
const CLOSED_LIMIT = 30;

/** 关闭标签时留一份快照：有磁盘路径的只需路径，未命名草稿要连内容一起保存 */
export function recordClosedTab(tab: Tab): void {
  closedStack.push({
    path: tab.path,
    title: tab.title,
    text: tab.path && !tab.binary ? activeText(tab) : tab.savedText,
    encoding: tab.encoding,
    eol: tab.eol,
    hasBom: tab.hasBom,
    binary: tab.binary,
    canvas: tab.canvas,
  });
  if (closedStack.length > CLOSED_LIMIT) closedStack.shift();
}

/** 文件 →「重新打开关闭的标签」（Ctrl+Shift+T） */
export async function reopenClosedTab(): Promise<void> {
  const snapshot = closedStack.pop();
  if (!snapshot) {
    showTransientStatus("没有可恢复的标签");
    return;
  }
  // 有路径的标签重新读盘，能顺带反映磁盘上的最新内容
  if (snapshot.path) {
    await openPath(snapshot.path);
    return;
  }
  const { store, editor } = app;
  const tab = createTab({
    title: snapshot.title,
    loaded: true,
    encoding: snapshot.encoding,
    eol: snapshot.eol,
    hasBom: snapshot.hasBom,
    preview: snapshot.canvas === true,
    canvas: snapshot.canvas,
  });
  tab.state = editor.createState(snapshot.text);
  tab.savedText = snapshot.text;
  // 恢复出来的草稿原本就没落盘，继续保持未保存提醒
  tab.dirty = true;
  store.add(tab);
  deps.renderTabs();
  await activate(tab.id);
  scheduleSessionSave(buildSession);
}

/** 新建画板：内容就是一份空 SVG，保存后成为标准 svg 文件 */
export function newWhiteboard(): void {
  const { store, editor } = app;
  const tab = createTab({
    loaded: true,
    title: `${nextUntitledTitle()}.svg`,
    preview: true,
    canvas: true,
  });
  store.add(tab);
  tab.state = editor.createState(WHITEBOARD_SKELETON);
  // 骨架只存在于内存，用户没保存过，标签应显示为未保存状态
  tab.savedText = "";
  tab.dirty = true;
  deps.renderTabs();
  void activate(tab.id);
}

/** 菜单打开文件夹后准备干净标签：当前已是空白未命名标签就直接用，否则新开一个 */
function switchToBlankTab(): void {
  const { store } = app;
  const active = store.active;
  const blank =
    active &&
    !active.path &&
    !active.binary &&
    !active.preview &&
    !active.dirty &&
    activeText(active).length === 0;
  if (!blank) newTab();
}

export async function openFiles(): Promise<void> {
  try {
    const paths = await invoke<string[]>("pick_open_files");
    for (const path of paths) {
      // 只有通过文件菜单打开的才进「最近」记录
      await openPath(path, true, true);
    }
  } catch (error) {
    await message(`打开对话框失败：\n${error}`);
  }
}

export async function openFolder(): Promise<void> {
  try {
    const picked = await invoke<string | null>("pick_open_folder");
    if (!picked) return;
    await openFolderPath(picked, true);
  } catch (error) {
    await message(`打开文件夹失败：\n${error}`);
  }
}

export async function openFolderPath(path: string, fromMenu = false): Promise<void> {
  const { tree } = app;
  if (!(await tree.setRoot(path))) return;
  if (fromMenu) addRecent(path);
  // 新打开文件夹时强制展开侧栏，否则用户可能看不到刚打开的内容
  expandSidebar();
  // 菜单打开文件夹时切到一个干净标签：之后首次双击文件会复用这个空白标签，
  // 不会把用户之前正在看的文件覆盖掉。拖放打开文件夹保持原行为
  if (fromMenu) switchToBlankTab();
  showTransientStatus(`已打开文件夹：${tree.currentRootName}`);
  scheduleSessionSave(buildSession);
}

/** 拖入文件夹时切换工作区，拖入文件时仍按普通文件打开；
 *  Markdown 标签下把图片拖进编辑区则转存 assets，不打开新标签 */
export async function handleDropped(
  paths: string[],
  position?: { x: number; y: number },
): Promise<void> {
  if (await tryInsertDroppedImages(paths, position)) return;
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

/** 从「文件 → 最近」打开：点菜单项也算菜单打开，会刷新记录排序 */
export async function openRecentEntry(path: string): Promise<void> {
  try {
    const info = await invoke<{ path: string; isDir: boolean }>("inspect_path", { path });
    if (info.isDir) {
      await openFolderPath(info.path, true);
    } else {
      await openPath(info.path, true, true);
    }
  } catch (error) {
    await message(`无法打开：\n${path}\n\n${error}`);
  }
}

export function ensureEditMode(): boolean {
  const { store } = app;
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

/** PDF 生成完毕：在 fEditor 里以只读标签打开，等同打印预览；打印可交给系统预览 */
export async function handlePrintDone(payload: PrintResultPayload): Promise<void> {
  const { store } = app;
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
