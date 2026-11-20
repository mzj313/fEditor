import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { EditorController } from "./editor";
import type { FileTree } from "./file-tree";
import type { TerminalPanel } from "./terminal";
import type { TabStore } from "./tabs";

/**
 * 主窗口的全局共享对象。
 * main.ts 作为装配根创建这些对象后一次性注入，各业务模块只读使用，
 * 避免模块间互相 import 形成环（与 session-state 的 init 注入同一思路）。
 */
export interface AppContext {
  appWindow: WebviewWindow;
  store: TabStore;
  editor: EditorController;
  tree: FileTree;
  terminal: TerminalPanel;
  /** 当前主题；设置面板切换时由 main.ts 更新 */
  theme: "light" | "dark";
  /** 自动换行开关；设置面板切换时由 main.ts 更新 */
  wrapEnabled: boolean;
}

export const app = {} as AppContext;

export function initAppContext(ctx: AppContext): void {
  Object.assign(app, ctx);
}
