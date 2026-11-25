//! 插件注册表：新增插件只需在 PLUGINS 里加一行，
//! 菜单分发、快捷键列表都从这里读取，主程序不需要逐个维护。

import diffPlugin from "./diff";
import httpPlugin from "./http-client";
import encodingPlugin from "./encoding";
import regexPlugin from "./regex";
import colorPlugin from "./color";
import type { ToolPlugin } from "./types";

export const PLUGINS: ToolPlugin[] = [
  diffPlugin,
  httpPlugin,
  encodingPlugin,
  regexPlugin,
  colorPlugin,
];

/** 按原生菜单 id 查插件；未命中返回 null，交回主程序处理 */
export function findPluginByMenuId(menuId: string): ToolPlugin | null {
  return PLUGINS.find((plugin) => plugin.menuId === menuId) ?? null;
}
