//! 悬停翻译：鼠标在英文单词上停留后，用本地词典给出中文释义。
//! 词库随应用打包，查词走 Rust 命令，不发起任何网络请求。

import { invoke } from "@tauri-apps/api/core";
import { hoverTooltip, type EditorView, type Tooltip } from "@codemirror/view";

export const HOVER_TRANSLATE_KEY = "fEditor.hoverTranslate";
/** 悬停多少毫秒后弹窗；设置面板可调 */
export const HOVER_DELAY_KEY = "fEditor.hoverTranslateDelay";
export const DEFAULT_HOVER_DELAY_MS = 350;
/** 本地查不到时是否联网查询；默认关闭 */
export const ONLINE_LOOKUP_KEY = "fEditor.hoverTranslateOnline";

/** 悬停范围：selection=必须先选中内容；any=任意单词都能触发。默认仅选中 */
export const HOVER_RANGE_KEY = "fEditor.hoverTranslateRange";
export type HoverRange = "selection" | "any";

export function getHoverRange(): HoverRange {
  return localStorage.getItem(HOVER_RANGE_KEY) === "any" ? "any" : "selection";
}

export function setHoverRange(range: HoverRange): void {
  localStorage.setItem(HOVER_RANGE_KEY, range);
}

export function isOnlineLookupEnabled(): boolean {
  return localStorage.getItem(ONLINE_LOOKUP_KEY) === "1";
}

export function setOnlineLookupEnabled(enabled: boolean): void {
  localStorage.setItem(ONLINE_LOOKUP_KEY, enabled ? "1" : "0");
  // 清空在线结果缓存；本地词库结果与开关无关，无需清理
  onlineCache.clear();
}

/** 弹出延迟可选项，单位秒；与设置面板下拉保持一致 */
export const HOVER_DELAY_OPTIONS = [0.1, 0.2, 0.35, 0.5, 0.8, 1, 1.5, 2];

/** 默认开启；只有显式存成 "0" 才关闭 */
export function isHoverTranslateEnabled(): boolean {
  return localStorage.getItem(HOVER_TRANSLATE_KEY) !== "0";
}

export function setHoverTranslateEnabled(enabled: boolean): void {
  localStorage.setItem(HOVER_TRANSLATE_KEY, enabled ? "1" : "0");
}

export function getHoverDelayMs(): number {
  const raw = Number(localStorage.getItem(HOVER_DELAY_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HOVER_DELAY_MS;
}

export function setHoverDelayMs(ms: number): void {
  localStorage.setItem(HOVER_DELAY_KEY, String(ms));
}

interface DictEntry {
  word: string;
  phonetic: string;
  translation: string;
  source?: string;
}

interface Hit {
  word: string;
  from: number;
  to: number;
}

/** 本地词库结果缓存；值可为 null（表示本地查不到） */
const localCache = new Map<string, DictEntry | null>();
/** 在线查询成功结果缓存；失败不缓存，方便网络恢复后重试 */
const onlineCache = new Map<string, DictEntry | null>();

async function lookupLocal(word: string): Promise<DictEntry | null> {
  const key = word.toLowerCase();
  if (localCache.has(key)) return localCache.get(key) ?? null;
  try {
    const entry = await invoke<DictEntry | null>("dict_lookup", { word: key });
    localCache.set(key, entry ?? null);
    return entry ?? null;
  } catch {
    localCache.set(key, null);
    return null;
  }
}

async function lookupOnline(word: string): Promise<DictEntry | null> {
  const key = word.toLowerCase();
  const cached = onlineCache.get(key);
  if (cached) return cached;
  try {
    const entry = await invoke<DictEntry | null>("dict_lookup_online", { word: key });
    if (entry) onlineCache.set(key, entry);
    return entry ?? null;
  } catch {
    return null;
  }
}

const isWordChar = (char: string): boolean => /[A-Za-z'’-]/.test(char);

/** 选区文本清洗为可查询的词组：压缩空白、去首尾标点、限长；不合格返回 null */
function phraseFromText(text: string): string | null {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > 500) return null;
  // 只裁掉首尾的空白与标点：中文选区的汉字必须保留，在线接口支持中译英
  return cleaned.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "") || null;
}

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

const CJK_TEXT = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 挑出弹窗里该朗读的英文内容：本地词条读原词，中译英结果读译文 */
function speakTarget(entry: DictEntry): string | null {
  const picked = [entry.word, entry.translation].find(
    (text) => /[A-Za-z]/.test(text) && !CJK_TEXT.test(text),
  );
  if (!picked) return null;
  return picked.replace(/\s+/g, " ").trim().slice(0, 200) || null;
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

/** 往已有容器填充弹窗内容；在线查询成功后复用同一容器刷新，避免事件监听丢失 */
function fillDom(dom: HTMLDivElement, entry: DictEntry): void {
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
  // 在线兜底结果标注来源，和本地词库区分
  if (entry.source === "online") {
    const badge = document.createElement("span");
    badge.className = "cm-translate-badge";
    badge.textContent = "联网";
    head.append(badge);
  }

  const speakText = speakTarget(entry);
  if (speakText) {
    const speak = document.createElement("button");
    speak.type = "button";
    speak.className = "cm-translate-speak";
    speak.title = `朗读 ${speakText}`;
    speak.setAttribute("aria-label", `朗读 ${speakText}`);
    speak.innerHTML = SPEAKER_ICON;
    // 按下时不要抢焦点、不要改变编辑器选区；预览弹窗的全局 mousedown 也要放行
    speak.addEventListener("mousedown", (event) => event.preventDefault());
    speak.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void speakWord(speakText);
    });
    head.append(speak);
  }

  const body = document.createElement("div");
  body.className = "cm-translate-body";
  body.textContent = entry.translation;

  dom.replaceChildren(head, body);
}

function buildDom(entry: DictEntry): HTMLDivElement {
  const dom = document.createElement("div");
  dom.className = "cm-translate-tooltip";
  fillDom(dom, entry);
  return dom;
}

/**
 * 本地查不到且开启联网时的占位弹窗：只显示单词和「联网翻译」按钮，
 * 点击后才真正请求在线翻译，成功就地把弹窗刷新成完整释义。
 */
function buildPendingDom(word: string, onLoaded: (entry: DictEntry) => void): HTMLDivElement {
  const dom = document.createElement("div");
  dom.className = "cm-translate-tooltip";

  const head = document.createElement("div");
  head.className = "cm-translate-head";
  const wordSpan = document.createElement("span");
  wordSpan.className = "cm-translate-word";
  wordSpan.textContent = word;
  head.append(wordSpan);

  const body = document.createElement("div");
  body.className = "cm-translate-body";

  const fetchButton = document.createElement("button");
  fetchButton.type = "button";
  fetchButton.className = "cm-translate-fetch";
  fetchButton.textContent = "联网翻译";
  fetchButton.addEventListener("mousedown", (event) => event.preventDefault());
  fetchButton.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    fetchButton.disabled = true;
    fetchButton.textContent = "查询中…";
    const entry = await lookupOnline(word);
    if (!entry) {
      // 查询失败恢复按钮，允许重试
      fetchButton.disabled = false;
      fetchButton.textContent = "联网翻译";
      return;
    }
    // 编辑器弹窗与预览弹窗分别通过回调完成刷新
    fillDom(dom, entry);
    onLoaded(entry);
  });
  body.append(fetchButton);

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
      // 仅选中模式：没有选区或悬停在选区外一律不弹
      const sel = view.state.selection.main;
      const inSelection = sel.from !== sel.to && pos >= sel.from && pos <= sel.to;
      if (!inSelection && getHoverRange() === "selection") return null;

      // 选中词组：悬停点落在选区内时翻译整个选区内容
      let target: string | null = null;
      let from: number;
      let to: number;
      if (inSelection) {
        target = phraseFromText(view.state.sliceDoc(sel.from, sel.to));
        from = sel.from;
        to = sel.to;
      } else {
        const hit = wordAt(view, pos);
        if (!hit) return null;
        target = hit.word;
        from = hit.from;
        to = hit.to;
      }
      if (!target) return null;

      const entry = await lookupLocal(target);
      if (entry) {
        return { ...buildTooltip(entry), pos: from, end: to };
      }
      // 本地查不到且开启联网：弹出占位框，由用户手动点按钮查询
      if (!isOnlineLookupEnabled()) return null;
      return {
        pos: from,
        end: to,
        create() {
          return { dom: buildPendingDom(target as string, () => {}) };
        },
      };
    },
    { hoverTime: getHoverDelayMs() },
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
  // 选中词组：鼠标落在选区内时翻译整个选区内容，弹窗定位到选区矩形
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.rangeCount > 0 && sel.containsNode(node, true)) {
    const phrase = phraseFromText(sel.toString());
    if (phrase) {
      return { word: phrase, rect: sel.getRangeAt(0).getBoundingClientRect() };
    }
  }
  // 仅选中模式：没有命中选区就不再回退到单词识别
  if (getHoverRange() === "selection") return null;

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

/** 把弹窗定位到单词矩形下方；放不下时翻到上方 */
function positionTip(tip: HTMLDivElement, rect: DOMRect): void {
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const top =
    rect.bottom + 8 + height > window.innerHeight ? Math.max(8, rect.top - height - 8) : rect.bottom + 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function attachPreviewBehavior(tip: HTMLDivElement): void {
  tip.addEventListener("mouseenter", cancelPreviewHide);
  tip.addEventListener("mouseleave", schedulePreviewHide);
}

function showPreviewTip(entry: DictEntry, rect: DOMRect): void {
  disposePreviewTip();
  const tip = document.createElement("div");
  tip.className = "preview-translate-tooltip";
  tip.append(buildDom(entry));
  attachPreviewBehavior(tip);
  document.body.append(tip);
  positionTip(tip, rect);
  previewTip = tip;
}

/** 本地查不到且开启联网时的占位弹窗：点击「联网翻译」后才请求在线结果 */
function showPendingTip(word: string, rect: DOMRect): void {
  disposePreviewTip();
  const tip = document.createElement("div");
  tip.className = "preview-translate-tooltip";
  tip.append(
    buildPendingDom(word, (entry) => {
      // 查询成功后换成完整释义弹窗；重建以恢复隐藏延迟与定位
      showPreviewTip(entry, rect);
    }),
  );
  attachPreviewBehavior(tip);
  document.body.append(tip);
  positionTip(tip, rect);
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
    if (token !== previewToken) return;
    const entry = await lookupLocal(hit.word);
    if (entry) {
      showPreviewTip(entry, hit.rect);
      return;
    }
    // 本地查不到且开启联网：弹占位框，由用户手动点按钮查询
    if (!isOnlineLookupEnabled()) return;
    showPendingTip(hit.word, hit.rect);
  }, getHoverDelayMs());
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
