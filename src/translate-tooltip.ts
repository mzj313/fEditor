//! 悬停翻译：鼠标在英文单词上停留后，用本地词典给出中文释义。
//! 词库随应用打包，查词走 Rust 命令，不发起任何网络请求。

import { invoke } from "@tauri-apps/api/core";
import { hoverTooltip, type EditorView, type Tooltip } from "@codemirror/view";

export const HOVER_TRANSLATE_KEY = "fEditor.hoverTranslate";


/** 默认开启；只有显式存成 "0" 才关闭 */
export function isHoverTranslateEnabled(): boolean {
  return localStorage.getItem(HOVER_TRANSLATE_KEY) !== "0";
}

export function setHoverTranslateEnabled(enabled: boolean): void {
  localStorage.setItem(HOVER_TRANSLATE_KEY, enabled ? "1" : "0");
}

interface DictEntry {
  word: string;
  phonetic: string;
  translation: string;
}

interface Hit {
  word: string;
  from: number;
  to: number;
}

const cache = new Map<string, DictEntry | null>();

async function lookupWord(word: string): Promise<DictEntry | null> {
  const key = word.toLowerCase();
  if (cache.has(key)) return cache.get(key) ?? null;
  try {
    const entry = await invoke<DictEntry | null>("dict_lookup", { word: key });
    cache.set(key, entry ?? null);
    return entry ?? null;
  } catch {
    cache.set(key, null);
    return null;
  }
}

const isWordChar = (char: string): boolean => /[A-Za-z'’-]/.test(char);

/** 喇叭图标；发音按钮用，保持和弹窗文字同色 */
const SPEAKER_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M3 6.2h2.1l3.3-2.6a.55.55 0 0 1 .9.43v7.94a.55.55 0 0 1-.9.43L5.1 9.8H3a.55.55 0 0 1-.55-.55v-2.5A.55.55 0 0 1 3 6.2Z"/><path fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" d="M11.1 5.4a3.6 3.6 0 0 1 0 5.2M12.8 3.7a6 6 0 0 1 0 8.6"/></svg>`;

/** 系统语音优先；在浏览器里单独调试预览时退回 Web Speech */
async function speakWord(word: string): Promise<void> {
  try {
    await invoke("speak_word", { word });
  } catch {
    fallbackSpeak(word);
  }
}

function fallbackSpeak(word: string): void {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = "en-US";
  utterance.rate = 0.9;
  window.speechSynthesis.speak(utterance);
}

/** 取光标位置所在的英文单词；中文、数字和符号不触发 */
function wordAt(view: EditorView, pos: number): Hit | null {
  const line = view.state.doc.lineAt(pos);
  const text = line.text;
  const index = pos - line.from;
  if (index < 0 || index >= text.length || !isWordChar(text[index])) return null;

  let start = index;
  let end = index + 1;
  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (end < text.length && isWordChar(text[end])) end++;

  // 去掉首尾的撇号、连字符，避免把引号包住的情况算进单词
  while (start < end && !/[A-Za-z]/.test(text[start])) start++;
  while (end > start && !/[A-Za-z]/.test(text[end - 1])) end--;
  if (end - start < 2) return null;

  return {
    word: text.slice(start, end),
    from: line.from + start,
    to: line.from + end,
  };
}

function buildDom(entry: DictEntry): HTMLDivElement {
  const dom = document.createElement("div");
  dom.className = "cm-translate-tooltip";

  const head = document.createElement("div");
  head.className = "cm-translate-head";
  const word = document.createElement("span");
  word.className = "cm-translate-word";
  word.textContent = entry.word;
  head.append(word);
  if (entry.phonetic) {
    const phonetic = document.createElement("span");
    phonetic.className = "cm-translate-phonetic";
    phonetic.textContent = `/${entry.phonetic}/`;
    head.append(phonetic);
  }

  const speak = document.createElement("button");
  speak.type = "button";
  speak.className = "cm-translate-speak";
  speak.title = `朗读 ${entry.word}`;
  speak.setAttribute("aria-label", `朗读 ${entry.word}`);
  speak.innerHTML = SPEAKER_ICON;
  // 按下时不要抢焦点、不要改变编辑器选区；预览弹窗的全局 mousedown 也要放行
  speak.addEventListener("mousedown", (event) => event.preventDefault());
  speak.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void speakWord(entry.word);
  });
  head.append(speak);

  const body = document.createElement("div");
  body.className = "cm-translate-body";
  body.textContent = entry.translation;

  dom.append(head, body);
  return dom;
}

function buildTooltip(entry: DictEntry): Tooltip {
  return {
    pos: 0,
    create() {
      return { dom: buildDom(entry) };
    },
  };
}


export function hoverTranslate() {
  return hoverTooltip(
    async (view, pos) => {
      if (!isHoverTranslateEnabled()) return null;
      const hit = wordAt(view, pos);
      if (!hit) return null;
      const entry = await lookupWord(hit.word);
      if (!entry) return null;
      return { ...buildTooltip(entry), pos: hit.from, end: hit.to };
    },
    { hoverTime: 350 },
  );
}

/* ---- 预览态：Markdown / SVG 预览里的悬停翻译 ---- */

interface PreviewHit {
  word: string;
  rect: DOMRect;
}

let previewTip: HTMLDivElement | null = null;
let previewTimer: number | undefined;
let previewHideTimer: number | undefined;
let previewWord = "";
let previewToken = 0;

function cancelPreviewHide(): void {
  if (previewHideTimer !== undefined) {
    window.clearTimeout(previewHideTimer);
    previewHideTimer = undefined;
  }
}

function disposePreviewTip(): void {
  if (previewTimer !== undefined) {
    window.clearTimeout(previewTimer);
    previewTimer = undefined;
  }
  cancelPreviewHide();
  previewTip?.remove();
  previewTip = null;
}

function clearPreviewTip(): void {
  disposePreviewTip();
  previewWord = "";
  previewToken++;
}

/** 留出把指针移到喇叭上的时间，离开后再收起 */
function schedulePreviewHide(): void {
  cancelPreviewHide();
  previewHideTimer = window.setTimeout(() => {
    previewHideTimer = undefined;
    clearPreviewTip();
  }, 260);
}

/** 取坐标处文本节点与字符偏移；不支持的环境直接跳过 */
function textAtPoint(x: number, y: number): { node: Text; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };

  let node: Node | null = null;
  let offset = 0;
  if (doc.caretPositionFromPoint) {
    const point = doc.caretPositionFromPoint(x, y);
    node = point?.offsetNode ?? null;
    offset = point?.offset ?? 0;
  } else if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(x, y);
    node = range?.startContainer ?? null;
    offset = range?.startOffset ?? 0;
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  return { node: node as Text, offset };
}

function previewWordAt(x: number, y: number): PreviewHit | null {
  const point = textAtPoint(x, y);
  if (!point) return null;

  const { node, offset } = point;
  const text = node.textContent ?? "";
  let index = -1;
  if (offset > 0 && isWordChar(text[offset - 1] ?? "")) index = offset - 1;
  else if (isWordChar(text[offset] ?? "")) index = offset;
  if (index < 0) return null;

  let start = index;
  let end = index + 1;
  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (end < text.length && isWordChar(text[end])) end++;
  while (start < end && !/[A-Za-z]/.test(text[start])) start++;
  while (end > start && !/[A-Za-z]/.test(text[end - 1])) end--;
  if (end - start < 2) return null;

  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return { word: text.slice(start, end), rect: range.getBoundingClientRect() };
}

function showPreviewTip(entry: DictEntry, rect: DOMRect): void {
  disposePreviewTip();
  const tip = document.createElement("div");
  tip.className = "preview-translate-tooltip";
  tip.append(buildDom(entry));
  tip.addEventListener("mouseenter", cancelPreviewHide);
  tip.addEventListener("mouseleave", schedulePreviewHide);
  document.body.append(tip);

  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const top =
    rect.bottom + 8 + height > window.innerHeight ? Math.max(8, rect.top - height - 8) : rect.bottom + 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  previewTip = tip;
}

function onPreviewMove(event: MouseEvent): void {
  if (!isHoverTranslateEnabled()) return;
  const hit = previewWordAt(event.clientX, event.clientY);
  if (!hit) {
    schedulePreviewHide();
    return;
  }
  const key = hit.word.toLowerCase();
  if (key === previewWord) {
    cancelPreviewHide();
    return;
  }

  clearPreviewTip();
  previewWord = key;
  const token = ++previewToken;
  previewTimer = window.setTimeout(async () => {
    previewTimer = undefined;
    const entry = await lookupWord(hit.word);
    if (!entry || token !== previewToken) return;
    showPreviewTip(entry, hit.rect);
  }, 350);
}

/** 让 Markdown / SVG 预览也支持悬停翻译；预览内容会重建，监听挂在外层容器上 */
export function initPreviewTranslate(): void {
  const host = document.getElementById("preview-host");
  if (!host) return;
  host.addEventListener("mousemove", onPreviewMove);
  host.addEventListener("mouseleave", schedulePreviewHide);
  document.addEventListener(
    "mousedown",
    (event) => {
      // 点在弹窗（喇叭）上时不要提前把弹窗移除
      if (previewTip && event.target instanceof Node && previewTip.contains(event.target)) return;
      clearPreviewTip();
    },
    true,
  );
  window.addEventListener("scroll", clearPreviewTip, true);
}
