//! 界面字号：标签栏、资源管理器、状态栏、提示弹窗等 HTML 界面元素的文字大小。
//! 与编辑器字号（--editor-font-size）互不影响；菜单栏属于系统原生菜单，不在此范围。
//! 偏好存 localStorage，与主题、编辑器字号同一套机制。

const STORAGE_KEY = "fEditor.uiFontSize";
export const DEFAULT_UI_FONT_SIZE = 13;
const MIN_UI_FONT_SIZE = 10;
const MAX_UI_FONT_SIZE = 16;

let size = readStoredSize();
const listeners = new Set<() => void>();

function readStoredSize(): number {
  const raw = Number.parseFloat(localStorage.getItem(STORAGE_KEY) ?? "");
  if (!Number.isFinite(raw)) return DEFAULT_UI_FONT_SIZE;
  return Math.min(MAX_UI_FONT_SIZE, Math.max(MIN_UI_FONT_SIZE, raw));
}

function apply(): void {
  document.documentElement.style.setProperty("--ui-font-size", `${size}px`);
}

export function getUiFontSize(): number {
  return size;
}

export function setUiFontSize(next: number): void {
  const value = Math.min(MAX_UI_FONT_SIZE, Math.max(MIN_UI_FONT_SIZE, next));
  if (value === size) return;
  size = value;
  localStorage.setItem(STORAGE_KEY, String(size));
  apply();
  for (const fn of listeners) fn();
}

export function resetUiFontSize(): void {
  if (size === DEFAULT_UI_FONT_SIZE) return;
  size = DEFAULT_UI_FONT_SIZE;
  localStorage.removeItem(STORAGE_KEY);
  apply();
  for (const fn of listeners) fn();
}

export function onUiFontSizeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 启动时调用一次，赶在首帧之前把存储里的字号落到 CSS 变量上 */
export function initUiFont(): void {
  apply();
}
