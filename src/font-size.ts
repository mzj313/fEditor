//! 编辑器字号：只影响代码编辑区与 Markdown 预览，与 Ctrl+滚轮的界面缩放互不干扰
//! （界面缩放是整页合成层拉伸，字号是真实的文本重排）。
//! 偏好存 localStorage（与主题同一套机制），不进会话文件以免动会话版本号。

const STORAGE_KEY = "fEditor.editorFontSize";
export const DEFAULT_FONT_SIZE = 13.5;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 32;

let size = readStoredSize();
const listeners = new Set<() => void>();

function readStoredSize(): number {
  const raw = Number.parseFloat(localStorage.getItem(STORAGE_KEY) ?? "");
  if (!Number.isFinite(raw)) return DEFAULT_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, raw));
}

function apply(): void {
  document.documentElement.style.setProperty("--editor-font-size", `${size}px`);
}

export function getFontSize(): number {
  return size;
}

export function changeFontSize(delta: number): void {
  setFontSize(size + delta);
}

export function setFontSize(next: number): void {
  const value = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, next));
  if (value === size) return;
  size = value;
  localStorage.setItem(STORAGE_KEY, String(size));
  apply();
  for (const fn of listeners) fn();
}

export function resetFontSize(): void {
  if (size === DEFAULT_FONT_SIZE) return;
  size = DEFAULT_FONT_SIZE;
  localStorage.removeItem(STORAGE_KEY);
  apply();
  for (const fn of listeners) fn();
}

export function onFontSizeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 应用启动时调用一次，把存储里的字号落到 CSS 变量上（须赶在首帧之前） */
export function initFontSize(): void {
  apply();
}
