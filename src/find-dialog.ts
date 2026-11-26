//! 查找 / 替换弹框。
//!
//! 之前直接用的是 CodeMirror 自带的顶部搜索条，字体小、样式也融不进现有界面。
//! 这里保留 CM 的搜索能力（SearchQuery + 全文高亮 + 查找替换命令），
//! 只把交互外壳换成居中弹框，因此正则、整词、区分大小写的行为和原来一致。

import type { EditorView } from "@codemirror/view";
import {
  SearchQuery,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  setSearchQuery,
} from "@codemirror/search";

interface FindOptions {
  caseSensitive: boolean;
  regexp: boolean;
  wholeWord: boolean;
}

interface FindDialog {
  view: EditorView;
  card: HTMLDivElement;
  backdrop: HTMLDivElement;
  searchInput: HTMLInputElement;
  replaceInput: HTMLInputElement;
  replaceRow: HTMLElement;
  countLabel: HTMLSpanElement;
  nextButton: HTMLButtonElement;
  prevButton: HTMLButtonElement;
  replaceButton: HTMLButtonElement;
  replaceAllButton: HTMLButtonElement;
  options: FindOptions;
}

const STORAGE_KEY = "fEditor.findOptions";
/** 统计上限：超大文件里数到这么多就够了，避免每次输入都扫全文件 */
const COUNT_LIMIT = 9999;

let dialog: FindDialog | null = null;

function loadOptions(): FindOptions {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<FindOptions>;
      return {
        caseSensitive: parsed.caseSensitive === true,
        regexp: parsed.regexp === true,
        wholeWord: parsed.wholeWord === true,
      };
    }
  } catch {
    // 本地存储被清空或内容损坏时退回默认值，不影响查找功能
  }
  return { caseSensitive: false, regexp: false, wholeWord: false };
}

function saveOptions(options: FindOptions): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
}

/** 打开弹框；withReplace 为 false 时隐藏替换行，算是"只查找"模式 */
export function openFindDialog(view: EditorView, withReplace: boolean): void {
  const current = ensureDialog(view);
  const query = getSearchQuery(view.state);
  const selection = view.state.selection.main;
  const selected = view.state.sliceDoc(selection.from, selection.to);

  // 首次打开优先用当前选区作为关键字，和大多数编辑器一致
  if (!query.search && selected && !selected.includes("\n")) {
    current.searchInput.value = selected;
  } else if (!current.searchInput.value) {
    current.searchInput.value = query.search;
  }
  if (query.replace) current.replaceInput.value = query.replace;

  setReplaceMode(current, withReplace);
  current.backdrop.hidden = false;
  current.searchInput.focus();
  current.searchInput.select();
  refresh(current, false);
}

export function closeFindDialog(): void {
  if (!dialog) return;
  dialog.backdrop.hidden = true;
}

function setReplaceMode(current: FindDialog, withReplace: boolean): void {
  current.replaceRow.hidden = !withReplace;
  current.replaceButton.hidden = !withReplace;
  current.replaceAllButton.hidden = !withReplace;
}

function ensureDialog(view: EditorView): FindDialog {
  if (dialog) {
    dialog.view = view;
    return dialog;
  }

  const backdrop = document.createElement("div");
  backdrop.className = "find-backdrop";
  backdrop.hidden = true;

  const card = document.createElement("div");
  card.className = "find-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "查找替换");

  const title = document.createElement("div");
  title.className = "find-title";
  title.textContent = "查找与替换";

  const searchInput = inputRow(card, "查找", "输入要查找的内容");
  const replaceRow = document.createElement("label");
  replaceRow.className = "find-row";
  replaceRow.innerHTML = '<span>替换为</span>';
  const replaceInput = document.createElement("input");
  replaceInput.className = "find-input";
  replaceInput.placeholder = "替换后的内容，支持 $1 这类分组引用";
  replaceRow.appendChild(replaceInput);
  card.appendChild(replaceRow);

  const optionsRow = document.createElement("div");
  optionsRow.className = "find-options";
  const options = loadOptions();
  const chips: Array<[keyof FindOptions, string, string]> = [
    ["caseSensitive", "区分大小写", "Aa"],
    ["wholeWord", "整词匹配", "ab"],
    ["regexp", "正则表达式", ".*"],
  ];
  const chipButtons = new Map<keyof FindOptions, HTMLButtonElement>();
  for (const [key, label, icon] of chips) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "find-chip";
    button.dataset.on = options[key] ? "1" : "0";
    button.title = label;
    button.textContent = icon;
    button.addEventListener("click", () => {
      if (!dialog) return;
      dialog.options[key] = !dialog.options[key];
      button.dataset.on = dialog.options[key] ? "1" : "0";
      saveOptions(dialog.options);
      refresh(dialog, false);
    });
    chipButtons.set(key, button);
    optionsRow.appendChild(button);
  }
  const countLabel = document.createElement("span");
  countLabel.className = "find-count";
  countLabel.textContent = "—";
  optionsRow.appendChild(countLabel);
  card.appendChild(optionsRow);

  const actions = document.createElement("div");
  actions.className = "find-actions";
  const prevButton = actionButton(actions, "上一个", () => {
    if (dialog) step(dialog, -1);
  });
  const nextButton = actionButton(actions, "下一个", () => {
    if (dialog) step(dialog, 1);
  });
  const replaceButton = actionButton(actions, "替换", () => {
    if (!dialog) return;
    refresh(dialog, false);
    replaceNext(dialog.view);
    refresh(dialog, false);
    dialog.view.focus();
    dialog.searchInput.focus();
  });
  const replaceAllButton = actionButton(actions, "全部替换", () => {
    if (!dialog) return;
    refresh(dialog, false);
    replaceAll(dialog.view);
    refresh(dialog, false);
    dialog.view.focus();
    dialog.searchInput.focus();
  });
  const closeButton = actionButton(actions, "关闭", () => closeFindDialog());
  closeButton.classList.add("find-close");
  card.appendChild(actions);

  card.insertBefore(title, card.firstChild);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  const current: FindDialog = {
    view,
    card,
    backdrop,
    searchInput,
    replaceInput,
    replaceRow,
    countLabel,
    nextButton,
    prevButton,
    replaceButton,
    replaceAllButton,
    options,
  };

  // 点遮罩关闭；点卡片内部不关
  backdrop.addEventListener("pointerdown", (event) => {
    if (event.target === backdrop) closeFindDialog();
  });

  for (const input of [searchInput, replaceInput]) {
    // 输入过程中只做高亮与计数，不移动选区，避免边打字边被拉走视口
    input.addEventListener("input", () => refresh(current, false));
  }

  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      step(current, event.shiftKey ? -1 : 1);
    }
  });
  replaceInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      current.replaceButton.click();
    }
  });

  card.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    // Esc 只关弹框，不能继续冒泡去触发退出预览等全局行为
    event.preventDefault();
    event.stopPropagation();
    closeFindDialog();
    view.focus();
  });

  dialog = current;
  return current;
}

function inputRow(
  parent: HTMLElement,
  label: string,
  placeholder: string,
): HTMLInputElement {
  const row = document.createElement("label");
  row.className = "find-row";
  const span = document.createElement("span");
  span.textContent = label;
  const input = document.createElement("input");
  input.className = "find-input";
  input.placeholder = placeholder;
  input.spellcheck = false;
  row.append(span, input);
  parent.appendChild(row);
  return input;
}

function actionButton(
  parent: HTMLElement,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  parent.appendChild(button);
  return button;
}

/** 把输入框内容同步成 CM 的搜索状态；jump 为 true 时顺便跳到第一个匹配 */
function buildQuery(current: FindDialog): SearchQuery {
  return new SearchQuery({
    search: current.searchInput.value,
    replace: current.replaceInput.value,
    caseSensitive: current.options.caseSensitive,
    regexp: current.options.regexp,
    wholeWord: current.options.wholeWord,
  });
}

function applyQuery(current: FindDialog, jump: boolean): SearchQuery {
  const query = buildQuery(current);
  current.view.dispatch({ effects: setSearchQuery.of(query) });
  if (jump && query.valid) findNext(current.view);
  return query;
}

/** 重新统计匹配数量，并把"第几项"显示出来 */
function refresh(current: FindDialog, jump: boolean): void {
  const query = applyQuery(current, jump);
  const { nextButton, prevButton, replaceButton, replaceAllButton, countLabel } = current;

  if (!query.search) {
    countLabel.textContent = "—";
    countLabel.dataset.state = "empty";
    for (const button of [nextButton, prevButton, replaceButton, replaceAllButton]) {
      button.disabled = true;
    }
    return;
  }
  if (!query.valid) {
    countLabel.textContent = "无效表达式";
    countLabel.dataset.state = "error";
    for (const button of [nextButton, prevButton, replaceButton, replaceAllButton]) {
      button.disabled = true;
    }
    return;
  }

  // 超大文件里每次击键都全量扫描会明显卡顿，此时只保留跳转能力
  if (current.view.state.doc.length > 2_000_000) {
    countLabel.dataset.state = "ok";
    countLabel.textContent = "文件较大，已跳过计数";
    for (const button of [nextButton, prevButton, replaceButton, replaceAllButton]) {
      button.disabled = false;
    }
    return;
  }

  let total = 0;
  let index = 0;
  const head = current.view.state.selection.main.from;
  const cursor = query.getCursor(current.view.state);
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total += 1;
    if (total <= COUNT_LIMIT && next.value.from <= head && head < next.value.to) {
      index = total;
    }
    if (total >= COUNT_LIMIT) break;
  }

  countLabel.dataset.state = total === 0 ? "empty" : "ok";
  countLabel.textContent =
    total === 0
      ? "无匹配"
      : index > 0
        ? `${index} / ${total}`
        : `共 ${total} 项`;

  for (const button of [nextButton, prevButton, replaceButton, replaceAllButton]) {
    button.disabled = total === 0;
  }
}

/** 整文件查找事件：large-file 模块监听后执行流式搜索并展示结果 */
export const WHOLE_FILE_SEARCH_EVENT = "large-file-search";

/**
 * 大文件只读浏览的查找弹框：文件本身没有加载全文，
 * Ctrl+F 直接输入关键字搜整份文件，结果由侧栏列表展示。
 */
export function openWholeFileSearch(): void {
  let backdrop = document.getElementById("whole-find") as HTMLDivElement | null;
  if (!backdrop) {
    backdrop = buildWholeFileDialog();
  }
  backdrop.hidden = false;
  const input = backdrop.querySelector<HTMLInputElement>(".find-input");
  input?.focus();
  input?.select();
}

function buildWholeFileDialog(): HTMLDivElement {
  const backdrop = document.createElement("div");
  backdrop.id = "whole-find";
  backdrop.className = "find-backdrop";
  backdrop.hidden = true;

  const card = document.createElement("div");
  card.className = "find-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "整份文件查找");

  const title = document.createElement("div");
  title.className = "find-title";
  title.textContent = "在整份文件中查找";

  const row = document.createElement("label");
  row.className = "find-row";
  const label = document.createElement("span");
  label.textContent = "查找";
  const input = document.createElement("input");
  input.className = "find-input";
  input.type = "search";
  input.placeholder = "输入关键字，回车搜索整份文件";
  input.spellcheck = false;
  row.append(label, input);

  const hint = document.createElement("div");
  hint.className = "find-count";
  hint.textContent = "结果会显示在左侧栏，点击跳转到对应位置";
  hint.dataset.state = "empty";

  const actions = document.createElement("div");
  actions.className = "find-actions";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "关闭";
  close.className = "find-close";
  close.addEventListener("click", () => {
    backdrop.hidden = true;
  });
  actions.append(close);

  card.append(title, row, hint, actions);
  backdrop.append(card);
  document.body.append(backdrop);

  backdrop.addEventListener("pointerdown", (event) => {
    if (event.target === backdrop) backdrop.hidden = true;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      backdrop.hidden = true;
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const keyword = input.value.trim();
    if (!keyword) return;
    // 关掉弹框，结果直接出现在侧栏，避免两层窗口叠在一起
    backdrop.hidden = true;
    window.dispatchEvent(
      new CustomEvent(WHOLE_FILE_SEARCH_EVENT, { detail: keyword }),
    );
  });

  return backdrop;
}

function step(current: FindDialog, direction: 1 | -1): void {
  const query = buildQuery(current);
  current.view.dispatch({ effects: setSearchQuery.of(query) });
  if (!query.valid) {
    refresh(current, false);
    return;
  }
  if (direction === 1) findNext(current.view);
  else findPrevious(current.view);
  refresh(current, false);
  current.view.focus();
  current.searchInput.focus();
}
