import type { EditorController } from "./editor";
import type { FileTree } from "./file-tree";
import type { SessionData } from "./session";
import { normalizePath, type Tab, type TabStore } from "./tabs";

const recentLimit = 10;
let recent: string[] = [];

let store: TabStore | null = null;
let editor: EditorController | null = null;
let tree: FileTree | null = null;

/** 依赖在 main.ts 里创建完成后注入，避免模块间循环 import */
export function initSessionState(deps: {
  store: TabStore;
  editor: EditorController;
  tree: FileTree;
}): void {
  store = deps.store;
  editor = deps.editor;
  tree = deps.tree;
}

export function activeText(tab: Tab): string {
  if (!store || !editor) return tab.savedText;
  if (tab.id === store.activeId) return editor.state.doc.toString();
  return tab.state ? tab.state.doc.toString() : tab.savedText;
}

function captureActive(): void {
  if (!store || !editor) return;
  const tab = store.active;
  if (!tab) return;
  tab.state = editor.state;
  tab.scrollTop = editor.scrollTop;
}

export function buildSession(): SessionData {
  if (!store || !editor || !tree) {
    throw new Error("session-state 尚未初始化");
  }
  // 局部别名让闭包内也能通过空值收窄
  const storeRef = store;
  const editorRef = editor;
  const treeRef = tree;
  captureActive();
  const tabs = storeRef.tabs
    .filter((tab) => tab.path)
    .map((tab) => ({
      id: tab.id,
      path: tab.path as string,
      title: tab.title,
      dirty: tab.dirty,
      encoding: tab.encoding,
      eol: tab.eol,
      hasBom: tab.hasBom,
      mtime: tab.mtime,
      cursor: tab.state ? tab.state.selection.main.head : tab.pendingCursor ?? 0,
      scrollTop: tab.id === storeRef.activeId ? editorRef.scrollTop : tab.scrollTop,
      binary: tab.binary,
    }));

  // 未命名草稿没有磁盘路径，内容只能随会话保存，否则重启后就会丢失
  const drafts = storeRef.tabs
    .filter((tab) => !tab.path)
    .map((tab) => ({
      id: tab.id,
      title: tab.title,
      text: tab.state ? tab.state.doc.toString() : tab.savedText,
      cursor: tab.state ? tab.state.selection.main.head : tab.pendingCursor ?? 0,
      scrollTop: tab.id === storeRef.activeId ? editorRef.scrollTop : tab.scrollTop,
    }));

  const activeVisible =
    tabs.some((tab) => tab.id === storeRef.activeId) ||
    drafts.some((tab) => tab.id === storeRef.activeId);
  return {
    version: 1,
    activeId: activeVisible ? storeRef.activeId : tabs[0]?.id ?? null,
    tabs,
    drafts,
    recent,
    updatedAt: Date.now(),
    root: treeRef.currentRoot,
    treeExpanded: treeRef.expandedDirs,
  };
}

export function addRecent(path: string): void {
  const normalized = normalizePath(path);
  recent = recent.filter((item) => normalizePath(item) !== normalized);
  recent.unshift(path);
  if (recent.length > recentLimit) recent.length = recentLimit;
}

/** 「最近」面板里删除单条记录（按展示顺序的索引） */
export function removeRecent(index: number): void {
  if (index >= 0 && index < recent.length) recent.splice(index, 1);
}

/** 清空全部最近记录 */
export function clearRecent(): void {
  recent = [];
}

/** 启动时从会话文件恢复最近文件列表 */
export function setRecent(paths: string[]): void {
  recent = paths;
}

/** 「最近」菜单点击时按索引取回路径（顺序与菜单项一致） */
export function getRecent(): string[] {
  return recent;
}
