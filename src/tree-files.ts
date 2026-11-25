//! 资源管理器右键操作：新建文件/文件夹、重命名、删除。
//! 路径合法性由 Rust 侧统一校验，这里只负责交互，以及同步已打开标签的路径。

import { invoke } from "@tauri-apps/api/core";
import { app } from "./app-context";
import { ask, message, promptText } from "./dialogs";
import { openPath } from "./file-open";
import type { TreeEntry } from "./file-tree";
import { parentDir } from "./paths";
import { scheduleSessionSave } from "./session";
import { buildSession } from "./session-state";
import { showTransientStatus } from "./statusbar";
import { closeTab } from "./tab-lifecycle";
import { normalizePath } from "./tabs";

interface TreeFilesDeps {
  renderTabs(): void;
}

let deps: TreeFilesDeps;

export function initTreeFiles(d: TreeFilesDeps): void {
  deps = d;
}

/** 菜单作用目录：文件取父目录，目录取自身，空白处取工作区根 */
function targetDir(entry: TreeEntry | null): string | null {
  if (!entry) return app.tree.currentRoot;
  return entry.isDir ? entry.path : parentDir(entry.path);
}

export async function createEntry(entry: TreeEntry | null, isDir: boolean): Promise<void> {
  const dir = targetDir(entry);
  if (!dir) return;
  const name = await promptText(isDir ? "新建文件夹名称" : "新建文件名");
  if (!name) return;
  try {
    const path = await invoke<string>("create_entry", { parent: dir, name, isDir });
    await app.tree.refresh();
    app.tree.markActive(path);
    if (!isDir) await openPath(path);
    showTransientStatus(`已创建 ${name}`);
  } catch (error) {
    await message(`创建失败：\n${error}`);
  }
}

export async function renameEntry(entry: TreeEntry): Promise<void> {
  const name = await promptText("重命名", entry.name);
  if (!name || name === entry.name) return;
  try {
    const path = await invoke<string>("rename_entry", {
      path: entry.path,
      newName: name,
    });
    // 已打开的标签要跟着改名，否则保存会写回旧路径、再打开又变成两份
    const oldPrefix = normalizePath(entry.path);
    for (const tab of app.store.tabs) {
      if (!tab.path) continue;
      const normalized = normalizePath(tab.path);
      if (normalized === oldPrefix) {
        tab.path = path;
        tab.title = name;
      } else if (entry.isDir && normalized.startsWith(`${oldPrefix}/`)) {
        // 目录重命名：把子文件的路径前缀整体换掉
        tab.path = path + tab.path.slice(entry.path.length);
      }
    }
    deps.renderTabs();
    await app.tree.refresh();
    app.tree.markActive(path);
    scheduleSessionSave(buildSession);
    showTransientStatus(`已重命名为 ${name}`);
  } catch (error) {
    await message(`重命名失败：\n${error}`);
  }
}

export async function deleteEntry(entry: TreeEntry): Promise<void> {
  if (!entry) return;
  const prefix = normalizePath(entry.path);
  const affected = app.store.tabs.filter((tab) => {
    if (!tab.path) return false;
    const normalized = normalizePath(tab.path);
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
  const dirtyCount = affected.filter((tab) => tab.dirty).length;
  const openNote =
    affected.length > 0
      ? `\n\n已打开的标签：${affected.length} 个${dirtyCount > 0 ? `（其中 ${dirtyCount} 个有未保存修改）` : ""}`
      : "";
  const choice = await ask(
    `确定永久删除「${entry.name}」吗？此操作不可恢复。${openNote}`,
    [
      { label: "删除", value: "delete" },
      { label: "取消", value: "cancel", primary: true },
    ],
  );
  if (choice !== "delete") return;

  try {
    await invoke("delete_entry", { path: entry.path });
    // 用户已确认删除，直接丢弃受影响标签，不再逐个弹保存提示
    for (const tab of affected) {
      tab.dirty = false;
      await closeTab(tab.id);
    }
    await app.tree.refresh();
    showTransientStatus(`已删除 ${entry.name}`);
  } catch (error) {
    await message(`删除失败：\n${error}`);
  }
}
