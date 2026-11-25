//! 快捷键注册表：默认组合键 + 用户自定义覆盖（localStorage）。
//! 原生菜单的加速键只是显示，实际触发统一在 bindShortcuts 的 keydown 里，
//! 自定义只影响 keydown 匹配，菜单栏显示的仍是默认组合键。

import { PLUGINS } from "./plugins/registry";

const STORE_KEY = "fEditor.shortcuts";

/** 主程序自身的菜单动作默认组合键，key 与 Rust 菜单项 id 一致 */
const BASE_SHORTCUTS: Record<string, string> = {
  "file.new": "Ctrl+N",
  "file.canvas": "Ctrl+Shift+N",
  "file.open": "Ctrl+O",
  "file.reopen": "Ctrl+Shift+T",
  "file.recent": "Ctrl+Alt+R",
  "folder.open": "Ctrl+Shift+O",
  "file.save": "Ctrl+S",
  "file.print": "Ctrl+Alt+P",
  "view.tree": "Ctrl+Shift+E",
  "view.terminal": "Ctrl+T",
  "view.preview": "Ctrl+E",
  "view.toc": "Ctrl+Shift+M",
  "view.maximize": "Ctrl+Alt+M",
  "settings.open": "Ctrl+,",
  "edit.find": "Ctrl+F",
  "edit.replace": "Ctrl+H",
  "edit.findInFiles": "Ctrl+Shift+F",
  "format.bold": "Ctrl+B",
  // Ctrl+I 被 CodeMirror 占用（选中父级语法节点），改用与其它格式命令一致的 Ctrl+Alt 组合
  "format.italic": "Ctrl+Alt+I",
  "format.strike": "Ctrl+Shift+X",
  "format.h1": "Ctrl+Alt+1",
  "format.h2": "Ctrl+Alt+2",
  "format.h3": "Ctrl+Alt+3",
  "format.bullet": "Ctrl+Alt+L",
  "format.ordered": "Ctrl+Alt+O",
  "format.quote": "Ctrl+Alt+Q",
  "format.link": "Ctrl+Alt+K",
  "format.code": "Ctrl+Alt+C",
  "format.document": "Ctrl+Alt+J",
  "edit.block": "Ctrl+Alt+B",
};

/** 主程序菜单动作的中文名称 */
const BASE_LABELS: Record<string, string> = {
  "file.new": "新建",
  "file.canvas": "新建画板",
  "file.open": "打开文件",
  "file.reopen": "重新打开关闭的标签",
  "file.recent": "最近打开",
  "folder.open": "打开文件夹",
  "file.save": "保存",
  "file.print": "打印预览",
  "view.tree": "资源管理器",
  "view.terminal": "集成终端",
  "view.preview": "切换预览",
  "view.toc": "文档目录",
  "view.maximize": "最大化编辑区",
  "settings.open": "设置",
  "edit.find": "查找",
  "edit.replace": "替换",
  "edit.findInFiles": "在文件中查找",
  "format.bold": "加粗",
  "format.italic": "斜体",
  "format.strike": "删除线",
  "format.h1": "标题 1",
  "format.h2": "标题 2",
  "format.h3": "标题 3",
  "format.bullet": "无序列表",
  "format.ordered": "有序列表",
  "format.quote": "引用",
  "format.link": "插入链接",
  "format.code": "行内代码",
  "format.document": "格式化文档",
  "edit.block": "列块模式",
};

// 插件自己声明菜单 id、标题与默认快捷键，合并后设置面板自动列出，无需改这里
const pluginShortcuts: Record<string, string> = {};
const pluginLabels: Record<string, string> = {};
for (const plugin of PLUGINS) {
  if (!plugin.menuId) continue;
  pluginLabels[plugin.menuId] = plugin.title;
  if (plugin.shortcut) pluginShortcuts[plugin.menuId] = plugin.shortcut;
}

export const DEFAULT_SHORTCUTS: Record<string, string> = {
  ...BASE_SHORTCUTS,
  ...pluginShortcuts,
};

export const ACTION_LABELS: Record<string, string> = {
  ...BASE_LABELS,
  ...pluginLabels,
};

function loadOverrides(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function saveOverrides(overrides: Record<string, string>): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(overrides));
  // 通知 bindShortcuts 立即刷新映射，无需重启
  window.dispatchEvent(new CustomEvent("shortcuts-changed"));
}

/** 生效组合键 = 自定义覆盖 ?? 默认值 */
export function getShortcut(action: string): string {
  return loadOverrides()[action] ?? DEFAULT_SHORTCUTS[action] ?? "";
}

/** 是否被用户改过（决定设置面板里是否显示「恢复默认」） */
export function isCustomized(action: string): boolean {
  return action in loadOverrides();
}

/** 自定义组合键；传 null 表示恢复默认。同组合键的其他动作会被让出，避免一键多绑 */
export function setShortcutOverride(action: string, combo: string | null): void {
  const overrides = loadOverrides();
  if (combo === null) {
    delete overrides[action];
  } else {
    overrides[action] = combo;
    // 冲突处理：其他动作绑定了同一组合键时自动恢复其默认值
    for (const [other, otherCombo] of Object.entries(overrides)) {
      if (other !== action && otherCombo === combo) delete overrides[other];
    }
  }
  saveOverrides(overrides);
}

/** 键盘事件归一化成「Ctrl+Alt+Shift+Key」格式，macOS 的 Cmd 统一按 Ctrl 处理 */
export function comboFromEvent(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return [...parts, key].join("+");
}
