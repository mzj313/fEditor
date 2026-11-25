//! 取色器：系统调色板 + 屏幕吸色（浏览器支持时）+ 多格式色值复制 + 最近使用颜色。
//! 颜色只在本地 localStorage 记录最近 8 个，不上传任何数据。

import type { PluginContext, ToolPlugin } from "../types";
import "./color.css";

const STORE_COLOR = "fEditor.plugin.color.current";
const STORE_RECENT = "fEditor.plugin.color.recent";
const MAX_RECENT = 8;

/** EyeDropper 尚未进入 TS 标准库，这里按最小接口声明 */
interface EyeDropperApi {
  open(): Promise<{ sRGBHex: string }>;
}
type EyeDropperConstructor = new () => EyeDropperApi;

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

/** 支持 #rgb / #rrggbb（可省略 #）；不合法返回 null */
function parseHex(raw: string): string | null {
  const text = raw.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(text)) {
    return `#${text
      .split("")
      .map((ch) => ch + ch)
      .join("")}`.toLowerCase();
  }
  return /^[0-9a-f]{6}$/i.test(text) ? `#${text}`.toLowerCase() : null;
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/** RGB → HSL；h 取整到度，s/l 取整到百分比，方便直接贴进 CSS */
function rgbToHsl(red: number, green: number, blue: number): [number, number, number] {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;

  if (max === min) return [0, 0, Math.round(lightness * 100)];

  const delta = max - min;
  const saturation =
    lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue: number;
  if (max === r) hue = (g - b) / delta + (g < b ? 6 : 0);
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;

  return [Math.round(hue * 60), Math.round(saturation * 100), Math.round(lightness * 100)];
}

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(STORE_RECENT);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list)
      ? list.filter((item): item is string => typeof item === "string" && Boolean(parseHex(item))).slice(0, MAX_RECENT)
      : [];
  } catch {
    return [];
  }
}

function mount(host: HTMLElement, ctx: PluginContext): void {
  let current = parseHex(localStorage.getItem(STORE_COLOR) ?? "") ?? "#3a86ff";
  let recent = readRecent();

  const root = el("div", "plugin-color");

  /* ---------- 顶部选择区 ---------- */
  const bar = el("div", "plugin-color-bar");
  const picker = el("input", "plugin-color-picker") as HTMLInputElement;
  picker.type = "color";
  picker.value = current;
  picker.title = "打开系统调色板";

  const hexInput = el("input", "plugin-color-hex") as HTMLInputElement;
  hexInput.value = current;
  hexInput.spellcheck = false;
  hexInput.placeholder = "#rrggbb";

  const copyButton = el("button", "plugin-color-button", "复制 HEX");
  bar.append(picker, hexInput, copyButton);

  const EyeDropperClass = (window as unknown as { EyeDropper?: EyeDropperConstructor }).EyeDropper;
  if (EyeDropperClass) {
    const screenButton = el("button", "plugin-color-button", "拾取屏幕颜色");
    screenButton.addEventListener("click", () => {
      new EyeDropperClass()
        .open()
        .then((result) => apply(result.sRGBHex))
        .catch(() => {
          // 用户按 Esc 取消，不当作错误提示
        });
    });
    bar.append(screenButton);
  }

  /* ---------- 预览与色值 ---------- */
  const preview = el("div", "plugin-color-preview");
  const previewLabel = el("span", "plugin-color-preview-label");
  preview.append(previewLabel);

  const rows = el("div", "plugin-color-rows");
  const valueRows: Array<{ label: string; value: HTMLElement; copy: HTMLButtonElement }> = [];
  for (const label of ["HEX", "RGB", "HSL"]) {
    const row = el("div", "plugin-color-row");
    row.append(el("span", "plugin-color-label", label));
    const value = el("code", "plugin-color-value");
    const copy = el("button", "plugin-color-copy", "复制");
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(value.textContent ?? "").then(
        () => ctx.showStatus(`${label} 已复制`),
        () => ctx.showStatus("复制失败，请检查剪贴板权限"),
      );
    });
    row.append(value, copy);
    rows.append(row);
    valueRows.push({ label, value, copy });
  }

  /* ---------- 最近使用 ---------- */
  const recentHead = el("div", "plugin-color-head", "最近使用");
  const recentBox = el("div", "plugin-color-recent");

  root.append(bar, preview, rows, recentHead, recentBox);
  host.append(root);

  const persistRecent = (): void => {
    localStorage.setItem(STORE_RECENT, JSON.stringify(recent));
  };

  const renderRecent = (): void => {
    recentBox.replaceChildren();
    if (!recent.length) {
      recentBox.append(el("span", "plugin-color-empty", "还没有记录，选几个颜色试试"));
      return;
    }
    for (const color of recent) {
      const chip = el("button", "plugin-color-chip") as HTMLButtonElement;
      chip.style.backgroundColor = color;
      chip.title = color;
      chip.addEventListener("click", () => apply(color));
      recentBox.append(chip);
    }
  };

  /** 应用一个颜色：同步所有控件并把色值写进 localStorage */
  function apply(raw: string): void {
    const hex = parseHex(raw);
    if (!hex) return;
    current = hex;
    localStorage.setItem(STORE_COLOR, hex);
    picker.value = hex;
    hexInput.value = hex;
    hexInput.classList.remove("invalid");

    const [red, green, blue] = hexToRgb(hex);
    const [hue, saturation, lightness] = rgbToHsl(red, green, blue);
    preview.style.backgroundColor = hex;
    // 根据亮度切换预览上的文字颜色，保证浅色/深色都看得清
    preview.style.color = lightness > 55 ? "#1f2328" : "#ffffff";
    previewLabel.textContent = hex.toUpperCase();

    const values = [`${hex.toUpperCase()}`, `rgb(${red}, ${green}, ${blue})`, `hsl(${hue}, ${saturation}%, ${lightness}%)`];
    valueRows.forEach((row, index) => {
      row.value.textContent = values[index];
    });

    recent = [hex, ...recent.filter((item) => item !== hex)].slice(0, MAX_RECENT);
    persistRecent();
    renderRecent();
  }

  picker.addEventListener("input", () => apply(picker.value));

  // 手输色值：回车或失焦时校验，非法时只标红不改变当前颜色
  const commitInput = (): void => {
    const hex = parseHex(hexInput.value);
    if (hex) {
      apply(hex);
    } else {
      hexInput.classList.add("invalid");
    }
  };
  hexInput.addEventListener("change", commitInput);
  hexInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitInput();
    }
  });

  copyButton.addEventListener("click", () => {
    void navigator.clipboard.writeText(picker.value.toUpperCase()).then(
      () => ctx.showStatus("HEX 已复制"),
      () => ctx.showStatus("复制失败，请检查剪贴板权限"),
    );
  });

  apply(current);
}

const plugin: ToolPlugin = {
  id: "color",
  title: "取色器",
  menuId: "tools.color",
  shortcut: "Ctrl+Shift+K",
  preferredHeight: 300,
  mount,
};

export default plugin;
