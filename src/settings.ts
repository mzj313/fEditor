//! 设置面板：设置菜单 → 编辑器…
//! 两栏布局：左侧分类（外观 / 编辑器），右侧对应设置项，全部即时生效并存
//! localStorage。主题与界面缩放的独立入口（视图菜单 / Ctrl+滚轮）保持不变。

import { getFontSize, onFontSizeChange, setFontSize } from "./font-size";
import { getUiScale, resetUiZoom } from "./ui-zoom";

const FAMILY_KEY = "fEditor.editorFontFamily";
const LINE_HEIGHT_KEY = "fEditor.editorLineHeight";
const TERMINAL_SIZE_KEY = "fEditor.terminalFontSize";
const DEFAULT_FAMILY = '"SFMono-Regular", Menlo, Consolas, "Courier New", monospace';

/** 常见等宽字体；前一项不存在时浏览器会自动落到后面的兜底 */
const FAMILIES: Array<{ label: string; value: string }> = [
  { label: "默认等宽", value: DEFAULT_FAMILY },
  { label: "Consolas", value: "Consolas, monospace" },
  { label: "Cascadia Mono", value: '"Cascadia Mono", Consolas, monospace' },
  { label: "JetBrains Mono", value: '"JetBrains Mono", Consolas, monospace' },
  { label: "Courier New", value: '"Courier New", monospace' },
];

const LINE_HEIGHTS = ["1.4", "1.55", "1.7", "1.9"];

export function getEditorFontFamily(): string {
  return localStorage.getItem(FAMILY_KEY) || DEFAULT_FAMILY;
}

export function getEditorLineHeight(): string {
  return localStorage.getItem(LINE_HEIGHT_KEY) || "1.55";
}

export function getTerminalFontSize(): number {
  const raw = Number.parseFloat(localStorage.getItem(TERMINAL_SIZE_KEY) ?? "");
  return Number.isFinite(raw) ? Math.min(20, Math.max(10, raw)) : 13;
}

function applyFamily(family: string): void {
  document.documentElement.style.setProperty("--editor-font-family", family);
}

function applyLineHeight(height: string): void {
  document.documentElement.style.setProperty("--editor-line-height", height);
}

/** 启动时把存储的字体偏好落到 CSS 变量上（须赶在首帧之前） */
export function initEditorAppearance(): void {
  applyFamily(getEditorFontFamily());
  applyLineHeight(getEditorLineHeight());
}

/* ---------------- 面板 UI ---------------- */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildRow(label: string, control: HTMLElement): HTMLElement {
  const row = el("div", "settings-row");
  row.append(el("span", "settings-label", label));
  row.append(control);
  return row;
}

let backdrop: HTMLDivElement | null = null;

export function openSettingsDialog(): void {
  if (backdrop) return; // 已打开时不重复创建

  backdrop = el("div", "settings-backdrop");
  const card = el("div", "settings-card");
  const sidebar = el("div", "settings-sidebar");
  const main = el("div", "settings-main");

  const pages = new Map<string, HTMLElement>();

  /** 注册一个分类：侧栏按钮 + 右侧页面，点击切换 */
  const registerCategory = (key: string, label: string, rows: HTMLElement[]): void => {
    const page = el("div", "settings-page");
    const head = el("div", "settings-page-head");
    head.append(el("span", "settings-page-title", label));
    const closeButton = el("button", "settings-close", "×");
    closeButton.title = "关闭（Esc）";
    closeButton.addEventListener("click", () => closeSettingsDialog());
    head.append(closeButton);
    page.append(head);
    for (const row of rows) page.append(row);
    pages.set(key, page);

    const nav = el("button", "settings-nav", label);
    nav.addEventListener("click", () => {
      for (const [k, p] of pages) p.classList.toggle("active", k === key);
      for (const n of sidebar.querySelectorAll(".settings-nav")) {
        n.classList.toggle("active", n === nav);
      }
    });
    sidebar.append(nav);
    main.append(page);
  };

  /* ---- 外观 ---- */
  const themeSelect = el("select", "settings-control") as HTMLSelectElement;
  for (const item of [
    { label: "浅色", value: "light" },
    { label: "深色", value: "dark" },
  ]) {
    const option = el("option", undefined, item.label) as HTMLOptionElement;
    option.value = item.value;
    themeSelect.append(option);
  }
  themeSelect.value = localStorage.getItem("fEditor.theme") === "dark" ? "dark" : "light";
  themeSelect.addEventListener("change", () => {
    // 主题状态由 main.ts 持有（含编辑器/终端联动），通过事件通知
    window.dispatchEvent(
      new CustomEvent("set-theme", { detail: themeSelect.value as "light" | "dark" }),
    );
  });

  const zoomValue = el("span", "settings-zoom-value", `${Math.round(getUiScale() * 100)}%`);
  const zoomReset = el("button", "settings-control settings-reset", "重置为 100%");
  zoomReset.addEventListener("click", () => resetUiZoom());
  // 界面缩放在别处变化时（手势/快捷键）同步这里的显示
  window.addEventListener("ui-scale-changed", () => {
    zoomValue.textContent = `${Math.round(getUiScale() * 100)}%`;
  });
  const zoomRow = el("div", "settings-row");
  zoomRow.append(el("span", "settings-label", "界面缩放"));
  const zoomStack = el("div", "settings-zoom-stack");
  zoomStack.append(zoomValue, zoomReset);
  zoomRow.append(zoomStack);

  registerCategory("appearance", "外观", [
    buildRow("主题", themeSelect),
    zoomRow,
  ]);

  /* ---- 编辑器 ---- */
  const familySelect = el("select", "settings-control") as HTMLSelectElement;
  for (const item of FAMILIES) {
    const option = el("option", undefined, item.label) as HTMLOptionElement;
    option.value = item.value;
    familySelect.append(option);
  }
  familySelect.value = getEditorFontFamily();
  familySelect.addEventListener("change", () => {
    localStorage.setItem(FAMILY_KEY, familySelect.value);
    applyFamily(familySelect.value);
  });

  // 字号滑块：与状态栏滚轮、菜单等入口实时互相同步
  const sizeStack = el("div", "settings-size-stack");
  const sizeValue = el("span", "settings-size-value", `${getFontSize()}px`);
  const sizeSlider = el("input", "settings-slider") as HTMLInputElement;
  sizeSlider.type = "range";
  sizeSlider.min = "10";
  sizeSlider.max = "24";
  sizeSlider.step = "0.5";
  sizeSlider.value = String(getFontSize());
  sizeSlider.addEventListener("input", () => {
    setFontSize(Number.parseFloat(sizeSlider.value));
  });
  onFontSizeChange(() => {
    sizeSlider.value = String(getFontSize());
    sizeValue.textContent = `${getFontSize()}px`;
  });
  sizeStack.append(sizeSlider, sizeValue);

  const lineHeightSelect = el("select", "settings-control") as HTMLSelectElement;
  for (const height of LINE_HEIGHTS) {
    const option = el("option", undefined, height) as HTMLOptionElement;
    option.value = height;
    lineHeightSelect.append(option);
  }
  lineHeightSelect.value = getEditorLineHeight();
  lineHeightSelect.addEventListener("change", () => {
    localStorage.setItem(LINE_HEIGHT_KEY, lineHeightSelect.value);
    applyLineHeight(lineHeightSelect.value);
  });

  // 自动换行：开关状态由 main.ts 持有并持久化，这里只发事件
  const wrapToggle = el("input", "settings-toggle") as HTMLInputElement;
  wrapToggle.type = "checkbox";
  wrapToggle.checked = localStorage.getItem("fEditor.wrap") !== "0";
  wrapToggle.addEventListener("change", () => {
    window.dispatchEvent(new CustomEvent("set-wrap", { detail: wrapToggle.checked }));
  });

  registerCategory("editor", "编辑器", [
    buildRow("字体", familySelect),
    buildRow("字号", sizeStack),
    buildRow("行高", lineHeightSelect),
    buildRow("自动换行", wrapToggle),
  ]);

  // 默认显示第一个分类
  pages.get("appearance")?.classList.add("active");
  sidebar.querySelector(".settings-nav")?.classList.add("active");

  card.append(sidebar, main);
  backdrop.append(card);
  document.body.append(backdrop);

  // 点击遮罩空白处或按 Esc 关闭
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) closeSettingsDialog();
  });
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeSettingsDialog();
  };
  window.addEventListener("keydown", onKey, { capture: true, once: true });
  (backdrop as unknown as { _onKey: (event: KeyboardEvent) => void })._onKey = onKey;

  themeSelect.focus();
}

export function closeSettingsDialog(): void {
  if (!backdrop) return;
  const node = backdrop as HTMLDivElement & { _onKey?: (event: KeyboardEvent) => void };
  if (node._onKey) window.removeEventListener("keydown", node._onKey, { capture: true });
  node.remove();
  backdrop = null;
}
