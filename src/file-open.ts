import { invoke } from "@tauri-apps/api/core";
import { app } from "./app-context";
import { disposeBinaryTab } from "./binary-preview";
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
  type FilePayload,
} from "./tab-lifecycle";
import {
  basename,
  binaryKindOf,
  createTab,
  normalizePath,
  type BinaryKind,
  type Tab,
} from "./tabs";
import { expandSidebar } from "./sidebar";
import { saveTab } from "./tab-save";
import type { OpenMode } from "./file-tree";

interface PrintResultPayload {
  path: string;
  error: string | null;
}

interface FileOpenDeps {
  renderTabs(): void;
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
  if (record) addRecent(payload.path);
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

  const current = store.active;
  // 当前标签不是音频预览时（比如用户已切走）退化成普通打开
  if (!current || current.binary !== "audio" || !current.path) {
    await openPath(path);
    return;
  }

  // 先停掉上一首，否则旧音频会与新文件同时出声
  disposeBinaryTab(current.path);
  current.path = path;
  current.title = basename(path);
  current.loaded = true;
  deps.renderTabs();
  await activate(current.id);
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

/** 拖入文件夹时切换工作区，拖入文件时仍按普通文件打开 */
export async function handleDropped(paths: string[]): Promise<void> {
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
