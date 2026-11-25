//! 插件宿主：把插件挂到主界面内嵌的面板里（编辑区底部，可拖动调高）。
//! 宿主管生命周期、异常隔离与关闭；同一时间只挂载一个插件，
//! 插件只拿到 host 容器与受控的 ctx，碰不到编辑器和标签等核心对象。

import { invoke } from "@tauri-apps/api/core";
import { setPluginHeight } from "../layout";
import { exitEditorMaximize, exitPluginMaximize, exitTerminalMaximize } from "../maximize";
import { showTransientStatus } from "../statusbar";
import { findPluginByMenuId } from "./registry";
import type { PluginContext, PluginFilePayload, ToolPlugin } from "./types";

const panel = document.getElementById("plugin-panel") as HTMLElement;
const panelTitle = document.getElementById("plugin-title") as HTMLElement;
const panelClose = document.getElementById("plugin-close") as HTMLButtonElement;
const host = document.getElementById("plugin-host") as HTMLElement;

/** 宿主提供给插件的受控能力 */
const context: PluginContext = {
  pickFiles: () => invoke<string[]>("pick_open_files"),
  readFile: (path) => invoke<PluginFilePayload>("read_file", { path }),
  showStatus: (text) => showTransientStatus(text),
};

let current: ToolPlugin | null = null;
let cleanup: (() => void) | null = null;

export function closePlugin(): void {
  if (cleanup) {
    try {
      cleanup();
    } catch {
      // 插件清理失败不应影响主程序
    }
  }
  cleanup = null;
  current = null;
  host.replaceChildren();
  panel.hidden = true;
  exitPluginMaximize();
}

export function openPlugin(plugin: ToolPlugin): void {
  // 最大化状态下插件面板会被 CSS 隐藏，先退出，保证点击后立刻能看到面板
  exitEditorMaximize();
  exitTerminalMaximize();
  // 同一插件已打开时只保持现状，避免重复挂载丢状态
  if (current && current.id === plugin.id) return;

  closePlugin();
  current = plugin;
  if (plugin.preferredHeight) setPluginHeight(plugin.preferredHeight);
  panelTitle.textContent = plugin.title;
  host.replaceChildren();
  panel.hidden = false;
  panelTitle.title = plugin.title;

  try {
    const result = plugin.mount(host, context);
    cleanup = typeof result === "function" ? result : null;
  } catch (error) {
    // 单个插件出错只影响自己的面板，主界面其余功能照常可用
    host.replaceChildren(
      Object.assign(document.createElement("div"), {
        className: "plugin-error",
        textContent: `插件加载失败：${String(error)}`,
      }),
    );
  }
}

/**
 * 菜单动作 → 插件。命中返回 true 表示已处理，
 * 主程序无需为每个插件写 case。
 */
export function openPluginByMenuId(action: string): boolean {
  const plugin = findPluginByMenuId(action);
  if (!plugin) return false;
  openPlugin(plugin);
  return true;
}

panelClose.addEventListener("click", () => closePlugin());
