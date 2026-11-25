//! 设置面板：设置菜单 → 编辑器…
//! 两栏布局：左侧分类（外观 / 编辑器），右侧对应设置项，全部即时生效并存
//! localStorage。主题与界面缩放的独立入口（视图菜单 / Ctrl+滚轮）保持不变。

import { invoke } from "@tauri-apps/api/core";
import { getFontSize, onFontSizeChange, setFontSize } from "./font-size";
import { getUiFontSize, onUiFontSizeChange, setUiFontSize } from "./ui-font";
import { getUiScale, resetUiZoom } from "./ui-zoom";
import {
  ACTION_LABELS,
  comboFromEvent,
  DEFAULT_SHORTCUTS,
  getShortcut,
  isCustomized,
  setShortcutOverride,
} from "./shortcuts";
import { showTransientStatus } from "./statusbar";
import { isAutoSaveEnabled, setAutoSaveEnabled } from "./auto-save";
import {
  DEFAULT_HOVER_DELAY_MS,
  HOVER_DELAY_OPTIONS,
  getHoverDelayMs,
  getHoverRange,
  isHoverTranslateEnabled,
  isOnlineLookupEnabled,
  setHoverDelayMs,
  setHoverRange,
  setHoverTranslateEnabled,
  setOnlineLookupEnabled,
} from "./translate-tooltip";

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

  // 界面字号：只影响标签栏/资源管理器/状态栏/弹窗等 HTML 界面文字
  const uiFontStack = el("div", "settings-size-stack");
  const uiFontValue = el("span", "settings-size-value", `${getUiFontSize()}px`);
  const uiFontSlider = el("input", "settings-slider") as HTMLInputElement;
  uiFontSlider.type = "range";
  uiFontSlider.min = "10";
  uiFontSlider.max = "16";
  uiFontSlider.step = "0.5";
  uiFontSlider.value = String(getUiFontSize());
  uiFontSlider.addEventListener("input", () => {
    setUiFontSize(Number.parseFloat(uiFontSlider.value));
  });
  onUiFontSizeChange(() => {
    uiFontSlider.value = String(getUiFontSize());
    uiFontValue.textContent = `${getUiFontSize()}px`;
  });
  uiFontStack.append(uiFontSlider, uiFontValue);

  const uiFontHint = el(
    "p",
    "settings-hint",
    "影响标签栏、资源管理器、状态栏与提示弹窗；菜单栏是系统原生菜单，不受此项控制。",
  );

  registerCategory("appearance", "外观", [
    buildRow("主题", themeSelect),
    zoomRow,
    buildRow("界面字体", uiFontStack),
    uiFontHint,
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

  // 自动保存：停止输入后延时写回原文件，开关立即持久化
  const autoSaveToggle = el("input", "settings-toggle") as HTMLInputElement;
  autoSaveToggle.type = "checkbox";
  autoSaveToggle.checked = isAutoSaveEnabled();
  autoSaveToggle.addEventListener("change", () => {
    setAutoSaveEnabled(autoSaveToggle.checked);
  });

  registerCategory("editor", "编辑器", [
    buildRow("字体", familySelect),
    buildRow("字号", sizeStack),
    buildRow("行高", lineHeightSelect),
    buildRow("自动换行", wrapToggle),
    buildRow("自动保存", autoSaveToggle),
  ]);

  /* ---- 翻译 ---- */
  const translateToggle = el("input", "settings-toggle") as HTMLInputElement;
  translateToggle.type = "checkbox";
  translateToggle.checked = isHoverTranslateEnabled();
  translateToggle.addEventListener("change", () => {
    setHoverTranslateEnabled(translateToggle.checked);
    showTransientStatus(translateToggle.checked ? "悬停翻译已开启" : "悬停翻译已关闭");
  });

  // 弹出延迟：改下拉即时生效，编辑器侧通过事件重挂翻译扩展
  const delaySelect = el("select", "settings-control") as HTMLSelectElement;
  for (const seconds of HOVER_DELAY_OPTIONS) {
    const option = el("option", undefined, `${seconds}s`) as HTMLOptionElement;
    option.value = String(seconds * 1000);
    delaySelect.append(option);
  }
  delaySelect.value = String(getHoverDelayMs());
  if (delaySelect.selectedIndex === -1) delaySelect.value = String(DEFAULT_HOVER_DELAY_MS);
  delaySelect.addEventListener("change", () => {
    setHoverDelayMs(Number(delaySelect.value));
    window.dispatchEvent(new CustomEvent("set-translate-delay", { detail: Number(delaySelect.value) }));
    showTransientStatus(`弹出延迟已设为 ${Number(delaySelect.value) / 1000}s`);
  });

  // 悬停范围：决定必须先选中内容，还是任意单词都能悬停翻译
  const rangeSelect = el("select", "settings-control") as HTMLSelectElement;
  for (const [value, label] of [
    ["selection", "仅选中内容"],
    ["any", "任意单词"],
  ] as const) {
    const option = el("option", undefined, label) as HTMLOptionElement;
    option.value = value;
    rangeSelect.append(option);
  }
  rangeSelect.value = getHoverRange();
  rangeSelect.addEventListener("change", () => {
    setHoverRange(rangeSelect.value === "any" ? "any" : "selection");
    // 编辑器侧需要重挂扩展才会按新模式生成 tooltip
    window.dispatchEvent(new CustomEvent("set-translate-delay"));
    showTransientStatus(`悬停范围：${rangeSelect.value === "any" ? "任意单词" : "仅选中内容"}`);
  });

  // 在线兜底：本地词库查不到时才请求在线翻译，默认关闭
  const onlineToggle = el("input", "settings-toggle") as HTMLInputElement;
  onlineToggle.type = "checkbox";
  onlineToggle.checked = isOnlineLookupEnabled();
  onlineToggle.addEventListener("change", () => {
    setOnlineLookupEnabled(onlineToggle.checked);
    showTransientStatus(onlineToggle.checked ? "联网查询已开启" : "联网查询已关闭");
  });

  const translateHint = el(
    "p",
    "settings-hint",
    "选中文本后把鼠标停在选区上即可查看译文；词库与语音都走本机。开启联网查询后，本地查不到的内容会弹出翻译框，点「联网翻译」才请求 MyMemory 免费接口（中文自动中译英）。「悬停范围」选择「任意单词」时，不选中也能直接悬停翻译英文单词。",
  );

  registerCategory("translate", "翻译", [
    buildRow("悬停翻译", translateToggle),
    buildRow("悬停范围", rangeSelect),
    buildRow("弹出延迟", delaySelect),
    buildRow("联网查询", onlineToggle),
    translateHint,
  ]);

  /* ---- 快捷键 ---- */
  const shortcutRows: HTMLElement[] = [];

  /** 单个动作的行：名称 + 当前组合键 + 修改/取消 + 恢复默认 */
  const buildShortcutRow = (action: string): HTMLElement => {
    const row = el("div", "settings-shortcut-row");
    const label = el("span", "settings-label", ACTION_LABELS[action] ?? action);
    const combo = el("kbd", "settings-shortcut-combo", getShortcut(action));
    const editButton = el("button", "settings-control settings-reset", "修改");
    const resetButton = el("button", "settings-control settings-reset", "恢复默认");

    // 捕获下一个按键作为新组合键；单独按修饰键继续等待，Esc 取消
    const startCapture = (): void => {
      editButton.textContent = "按下新组合键…";
      editButton.classList.add("capturing");
      const endCapture = (): void => {
        window.removeEventListener("keydown", onCapture, true);
        editButton.textContent = "修改";
        editButton.classList.remove("capturing");
      };
      const onCapture = (event: KeyboardEvent): void => {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") {
          endCapture();
          return;
        }
        // 只按了修饰键不算组合键，等待继续按主键
        if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
        endCapture();
        const next = comboFromEvent(event);
        setShortcutOverride(action, next);
        refreshShortcutRows();
        showTransientStatus(`已将「${ACTION_LABELS[action] ?? action}」设为 ${next}`);
      };
      window.addEventListener("keydown", onCapture, true);
    };

    editButton.addEventListener("click", startCapture);
    resetButton.addEventListener("click", () => {
      setShortcutOverride(action, null);
      refreshShortcutRows();
    });
    resetButton.style.display = isCustomized(action) ? "" : "none";

    row.append(label, combo, editButton, resetButton);
    row.dataset.action = action;
    return row;
  };

  /** 自定义变化后刷新所有行的显示（组合键文本 + 恢复默认按钮可见性） */
  const refreshShortcutRows = (): void => {
    for (const row of shortcutRows) {
      const action = row.dataset.action as string;
      (row.querySelector(".settings-shortcut-combo") as HTMLElement).textContent =
        getShortcut(action);
      const resetButton = row.querySelectorAll("button")[1] as HTMLButtonElement;
      resetButton.style.display = isCustomized(action) ? "" : "none";
    }
  };

  for (const action of Object.keys(DEFAULT_SHORTCUTS)) {
    shortcutRows.push(buildShortcutRow(action));
  }

  const shortcutWrap = el("div", "settings-shortcut-list");
  for (const row of shortcutRows) shortcutWrap.append(row);

  const resetAllButton = el("button", "settings-control settings-reset", "全部恢复默认");
  resetAllButton.addEventListener("click", () => {
    for (const action of Object.keys(DEFAULT_SHORTCUTS)) setShortcutOverride(action, null);
    refreshShortcutRows();
  });
  const resetAllRow = buildRow("快捷键", resetAllButton);
  shortcutRows.push(resetAllRow);
  resetAllRow.dataset.action = "";

  registerCategory("shortcuts", "快捷键", [
    resetAllRow,
    shortcutWrap,
  ]);

  /* ---- 集成 ---- */
  const ctxToggle = el("input", "settings-toggle") as HTMLInputElement;
  ctxToggle.type = "checkbox";
  ctxToggle.checked = false;
  ctxToggle.disabled = true; // 状态读完前禁用，避免开关与实际注册表不一致
  const ctxHint = el("p", "settings-hint", "正在读取当前注册状态…");

  const renderContextMenu = (registered: boolean, exePath: string): void => {
    ctxToggle.checked = registered;
    ctxHint.textContent = registered
      ? `已添加到右键菜单，注册的程序：${exePath}`
      : "开启后资源管理器右键会出现「用 fEditor 打开」，只写入当前用户注册表，无需管理员权限。";
  };

  void invoke<{ registered: boolean; exe_path: string }>("context_menu_status")
    .then((status) => {
      renderContextMenu(status.registered, status.exe_path);
    })
    .catch((error) => {
      ctxHint.textContent = `读取注册状态失败：${error}`;
    })
    .finally(() => {
      ctxToggle.disabled = false;
    });

  ctxToggle.addEventListener("change", () => {
    const next = ctxToggle.checked;
    ctxToggle.disabled = true;
    void invoke<{ registered: boolean; exe_path: string }>("set_context_menu", {
      enabled: next,
    })
      .then((status) => {
        renderContextMenu(status.registered, status.exe_path);
        showTransientStatus(status.registered ? "已添加到右键菜单" : "已从右键菜单移除");
      })
      .catch((error) => {
        ctxToggle.checked = !next; // 失败回滚开关，保持与注册表一致
        ctxHint.textContent = String(error);
        showTransientStatus("右键菜单设置失败");
      })
      .finally(() => {
        ctxToggle.disabled = false;
      });
  });

  registerCategory("integration", "集成", [
    buildRow("资源管理器右键菜单", ctxToggle),
    ctxHint,
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
