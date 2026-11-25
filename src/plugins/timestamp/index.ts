//! 时间戳转换：Unix 秒/毫秒与本地时间、UTC、ISO 互转。
//! 自动识别 10 位秒和 13 位毫秒，也可以直接粘贴日期字符串。

import type { PluginContext, ToolPlugin } from "../types";
import "../ui.css";

type Unit = "auto" | "s" | "ms";

const STORE_KEY = "fEditor.plugin.timestamp";

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

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocal(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function formatUtc(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** 返回毫秒时间戳；输入为空返回 null，格式不对抛错 */
function parseInput(raw: string, unit: Unit): number | null {
  const text = raw.trim();
  if (!text) return null;

  if (/^-?\d+$/.test(text)) {
    const value = Number(text);
    if (!Number.isFinite(value)) throw new Error("时间戳超出可表示范围");
    const asMs = unit === "ms" || (unit === "auto" && Math.abs(value) >= 1e12);
    return asMs ? value : value * 1000;
  }

  // WKWebView 对「2026-11-25 10:00:00」这种带空格的写法解析不稳定，统一换成 T
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)
    ? text.replace(" ", "T")
    : text;
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) throw new Error("无法识别，请输入时间戳或日期");
  return ms;
}

function readUnit(): Unit {
  try {
    const stored = localStorage.getItem(STORE_KEY);
    if (stored === "s" || stored === "ms" || stored === "auto") return stored;
  } catch {
    // 存储不可用时用默认值
  }
  return "auto";
}

function mount(host: HTMLElement, ctx: PluginContext): void {
  const root = el("div", "plugin-ui");

  const bar = el("div", "plugin-ui-bar");
  bar.append(el("span", "plugin-ui-label", "时间戳或日期"));
  const input = el("input", "plugin-ui-input") as HTMLInputElement;
  input.placeholder = "例如 1764000000、1764000000000 或 2026-11-25 10:00:00";
  input.spellcheck = false;

  const unitSelect = el("select", "plugin-ui-select") as HTMLSelectElement;
  for (const [value, label] of [
    ["auto", "自动"],
    ["s", "秒"],
    ["ms", "毫秒"],
  ] as const) {
    const option = el("option", undefined, label) as HTMLOptionElement;
    option.value = value;
    unitSelect.append(option);
  }
  unitSelect.value = readUnit();

  const nowButton = el("button", "plugin-ui-button", "现在");
  bar.append(input, unitSelect, nowButton);

  const rows = el("div", "plugin-ui-rows");
  const status = el("div", "plugin-ui-status");
  root.append(bar, rows, status);
  host.append(root);

  const copy = (text: string, label: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => ctx.showStatus(`${label}已复制`),
      () => ctx.showStatus("复制失败，请检查剪贴板权限"),
    );
  };

  const render = (): void => {
    rows.replaceChildren();
    try {
      const ms = parseInput(input.value, unitSelect.value as Unit);
      if (ms === null) {
        status.textContent = "输入时间戳或日期，点击任意一行可复制";
        status.classList.remove("error");
        return;
      }

      const date = new Date(ms);
      if (Number.isNaN(date.getTime())) throw new Error("时间戳超出可表示范围");

      const items: Array<[string, string]> = [
        ["本地时间", formatLocal(date)],
        ["UTC 时间", formatUtc(date)],
        ["ISO 8601", date.toISOString()],
        ["Unix 秒", String(Math.floor(ms / 1000))],
        ["Unix 毫秒", String(Math.trunc(ms))],
      ];
      for (const [label, value] of items) {
        const row = el("div", "plugin-ui-row");
        row.title = "点击复制";
        row.append(el("span", "plugin-ui-key", label), el("span", "plugin-ui-value", value));
        row.addEventListener("click", () => copy(value, label));
        rows.append(row);
      }
      status.textContent = "点击任意一行可复制";
      status.classList.remove("error");
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      status.classList.add("error");
    }
  };

  input.addEventListener("input", render);
  unitSelect.addEventListener("change", () => {
    localStorage.setItem(STORE_KEY, unitSelect.value);
    render();
  });
  nowButton.addEventListener("click", () => {
    input.value = String(Date.now());
    unitSelect.value = "ms";
    localStorage.setItem(STORE_KEY, "ms");
    render();
    input.select();
  });

  input.focus();
  render();
}

const plugin: ToolPlugin = {
  id: "timestamp",
  title: "时间戳转换",
  menuId: "tools.timestamp",
  shortcut: "Ctrl+Shift+U",
  preferredHeight: 280,
  mount,
};

export default plugin;
