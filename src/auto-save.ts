//! 自动保存：停止输入后延时把当前标签写回原文件。
//! 只处理已有路径的普通文本标签；未命名、二进制、出错的标签保持原行为。

import { app } from "./app-context";
import { showTransientStatus, updateStatus } from "./statusbar";
import { saveTab } from "./tab-save";

const AUTO_SAVE_KEY = "fEditor.autoSave";
/** 停止输入后等待多久再保存：太短会在输入过程中频繁写盘 */
const AUTO_SAVE_DELAY_MS = 1200;

/** 按标签 id 保存计时器，连续输入只保留最后一次 */
const timers = new Map<string, number>();

export function isAutoSaveEnabled(): boolean {
  return localStorage.getItem(AUTO_SAVE_KEY) === "1";
}

export function setAutoSaveEnabled(on: boolean): void {
  localStorage.setItem(AUTO_SAVE_KEY, on ? "1" : "0");
  if (!on) {
    for (const timer of timers.values()) window.clearTimeout(timer);
    timers.clear();
  }
  showTransientStatus(on ? "自动保存已开启" : "自动保存已关闭");
}

/** 编辑变更后调用；关闭开关或标签不满足条件时直接跳过 */
export function scheduleAutoSave(): void {
  if (!isAutoSaveEnabled()) return;
  const tab = app.store.active;
  if (!tab || !tab.dirty || tab.binary || tab.error || !tab.path) return;

  const existing = timers.get(tab.id);
  if (existing !== undefined) window.clearTimeout(existing);

  const timer = window.setTimeout(() => {
    timers.delete(tab.id);
    // 触发时重新确认：期间可能已手动保存、关闭标签或恢复成不脏状态
    if (!app.store.tabs.includes(tab) || !tab.dirty || !tab.path) return;
    void saveTab(tab, false, true).then((ok) => {
      updateStatus();
      showTransientStatus(ok ? "已自动保存" : "自动保存失败，文件可能已被外部修改");
    });
  }, AUTO_SAVE_DELAY_MS);
  timers.set(tab.id, timer);
}
