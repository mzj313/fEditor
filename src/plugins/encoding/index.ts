//! 编码转换箱：Base64 / URL / HTML 实体 / Unicode 转义 / 十六进制 双向转换。
//! 输入即转换，结果可一键复制；只记住模式和方向，不保存输入内容。

import type { PluginContext, ToolPlugin } from "../types";
import "./encoding.css";

type Mode = "base64" | "url" | "html" | "unicode" | "hex";
type Direction = "encode" | "decode";

interface EncState {
  mode: Mode;
  direction: Direction;
}

const STORE_KEY = "fEditor.plugin.encoding";

const MODES: Array<{ value: Mode; label: string }> = [
  { value: "base64", label: "Base64" },
  { value: "url", label: "URL 转义" },
  { value: "html", label: "HTML 实体" },
  { value: "unicode", label: "Unicode 转义" },
  { value: "hex", label: "十六进制" },
];

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

/** UTF-8 文本 → Base64；不用 btoa(text) 以免中文直接报错 */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): string {
  const binary = atob(text.replace(/\s+/g, ""));
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function unescapeHtml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (whole, name: string) => {
    const lower = name.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    const code = lower.startsWith("#x")
      ? Number.parseInt(lower.slice(2), 16)
      : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
  });
}

/** 逐个码点转义；非 BMP 字符拆成代理对，保证结果能直接放回 JS 字符串 */
function escapeUnicode(text: string): string {
  return Array.from(text)
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      if (code <= 0xffff) return `\\u${code.toString(16).padStart(4, "0")}`;
      return Array.from(char)
        .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
        .join("");
    })
    .join("");
}

function unescapeUnicode(text: string): string {
  return text.replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g, (whole, braced, hex) => {
    const code = Number.parseInt(braced ?? hex, 16);
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
  });
}

function toHex(text: string): string {
  return Array.from(new TextEncoder().encode(text))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
}

function fromHex(text: string): string {
  const clean = text.replace(/0x/gi, "").replace(/[\s,]+/g, "");
  if (!/^[0-9a-f]*$/i.test(clean) || clean.length % 2 !== 0) {
    throw new Error("十六进制格式不正确（需要偶数个 0-9/a-f 字符）");
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

function convert(text: string, mode: Mode, direction: Direction): string {
  if (direction === "encode") {
    if (mode === "base64") return toBase64(text);
    if (mode === "url") return encodeURIComponent(text);
    if (mode === "html") return escapeHtml(text);
    if (mode === "unicode") return escapeUnicode(text);
    return toHex(text);
  }
  if (mode === "base64") return fromBase64(text);
  if (mode === "url") return decodeURIComponent(text);
  if (mode === "html") return unescapeHtml(text);
  if (mode === "unicode") return unescapeUnicode(text);
  return fromHex(text);
}

function readState(): EncState {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<EncState>;
      return {
        mode: MODES.some((item) => item.value === parsed.mode) ? parsed.mode! : "base64",
        direction: parsed.direction === "decode" ? "decode" : "encode",
      };
    }
  } catch {
    // 存储损坏时退回默认值
  }
  return { mode: "base64", direction: "encode" };
}

function mount(host: HTMLElement, ctx: PluginContext): void {
  const state = readState();

  const root = el("div", "plugin-enc");

  const bar = el("div", "plugin-enc-bar");
  const modeSelect = el("select", "plugin-enc-select") as HTMLSelectElement;
  for (const item of MODES) {
    const option = el("option", undefined, item.label) as HTMLOptionElement;
    option.value = item.value;
    modeSelect.append(option);
  }
  modeSelect.value = state.mode;

  const directionSelect = el("select", "plugin-enc-select") as HTMLSelectElement;
  for (const [value, label] of [
    ["encode", "编码 →"],
    ["decode", "← 解码"],
  ] as const) {
    const option = el("option", undefined, label) as HTMLOptionElement;
    option.value = value;
    directionSelect.append(option);
  }
  directionSelect.value = state.direction;

  const swapButton = el("button", "plugin-enc-button", "交换结果到输入");
  const barCopy = el("button", "plugin-enc-button", "复制结果");
  bar.append(modeSelect, directionSelect, swapButton, barCopy);

  const panes = el("div", "plugin-enc-panes");
  const left = el("div", "plugin-enc-side");
  const right = el("div", "plugin-enc-side");
  const leftHead = el("div", "plugin-enc-head");
  leftHead.append(el("span", undefined, "输入"));
  const rightHead = el("div", "plugin-enc-head");
  rightHead.append(el("span", undefined, "结果"));

  const input = el("textarea", "plugin-enc-text") as HTMLTextAreaElement;
  input.placeholder = "在这里输入内容，边输入边转换";
  input.spellcheck = false;
  const output = el("textarea", "plugin-enc-text") as HTMLTextAreaElement;
  output.readOnly = true;
  output.spellcheck = false;

  left.append(leftHead, input);
  right.append(rightHead, output);
  panes.append(left, right);

  const status = el("div", "plugin-enc-status");
  root.append(bar, panes, status);
  host.append(root);

  const persist = (): void => {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  };

  const run = (): void => {
    const text = input.value;
    if (!text) {
      output.value = "";
      status.textContent = "等待输入";
      status.classList.remove("error");
      return;
    }
    try {
      output.value = convert(text, state.mode, state.direction);
      status.textContent = `${output.value.length} 个字符`;
      status.classList.remove("error");
    } catch (error) {
      output.value = "";
      status.textContent = `转换失败：${error instanceof Error ? error.message : String(error)}`;
      status.classList.add("error");
    }
  };

  modeSelect.addEventListener("change", () => {
    state.mode = modeSelect.value as Mode;
    persist();
    run();
  });
  directionSelect.addEventListener("change", () => {
    state.direction = directionSelect.value as Direction;
    persist();
    run();
  });
  input.addEventListener("input", run);

  swapButton.addEventListener("click", () => {
    input.value = output.value;
    run();
    input.focus();
  });

  const copyResult = (): void => {
    if (!output.value) {
      ctx.showStatus("没有可复制的结果");
      return;
    }
    void navigator.clipboard.writeText(output.value).then(
      () => ctx.showStatus("结果已复制"),
      () => ctx.showStatus("复制失败，请检查剪贴板权限"),
    );
  };
  barCopy.addEventListener("click", copyResult);

  input.focus();
  run();
}

const plugin: ToolPlugin = {
  id: "encoding",
  title: "编码转换箱",
  menuId: "tools.encoding",
  shortcut: "Ctrl+Shift+G",
  preferredHeight: 320,
  mount,
};

export default plugin;
