//! 配置格式互转：JSON / YAML / TOML / Properties 之间即时转换。
//! Properties 只表示扁平键值，嵌套对象导出时会用点号展开。

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { PluginContext, ToolPlugin } from "../types";
import "../ui.css";

type Format = "json" | "yaml" | "toml" | "properties";

const STORE_KEY = "fEditor.plugin.convert";

const FORMATS: Array<{ value: Format; label: string }> = [
  { value: "json", label: "JSON" },
  { value: "yaml", label: "YAML" },
  { value: "toml", label: "TOML" },
  { value: "properties", label: "Properties" },
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

function splitProperty(line: string): [string, string] | null {
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "=" || char === ":") {
      return [line.slice(0, i), line.slice(i + 1)];
    }
  }
  return null;
}

function unescapeProperty(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_whole, escape: string) => {
    if (escape.startsWith("u")) {
      return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    }
    if (escape === "n") return "\n";
    if (escape === "t") return "\t";
    if (escape === "r") return "\r";
    if (escape === "f") return "\f";
    return escape;
  });
}

function escapeProperty(text: string, isKey: boolean): string {
  let result = text
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  if (isKey) result = result.replace(/([=: ])/g, "\\$1");
  return result;
}

function parseProperties(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const pair = splitProperty(line);
    if (!pair) continue;
    const key = unescapeProperty(pair[0].trim());
    if (!key) continue;
    result[key] = unescapeProperty(pair[1].trim());
  }
  return result;
}

function flattenProperties(
  value: unknown,
  prefix: string,
  out: Array<[string, string]>,
): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flattenProperties(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  if (Array.isArray(value)) {
    out.push([
      prefix,
      value.map((item) => (item === null || item === undefined ? "" : String(item))).join(","),
    ]);
    return;
  }
  out.push([prefix, value === null || value === undefined ? "" : String(value)]);
}

function serializeProperties(data: unknown): string {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Properties 顶层必须是键值对象");
  }
  const entries: Array<[string, string]> = [];
  flattenProperties(data, "", entries);
  return entries
    .map(([key, value]) => `${escapeProperty(key, true)}=${escapeProperty(value, false)}`)
    .join("\n");
}

function parseData(text: string, format: Format): unknown {
  if (format === "json") return JSON.parse(text);
  if (format === "yaml") return parseYaml(text);
  if (format === "toml") return parseToml(text);
  return parseProperties(text);
}

function serializeData(data: unknown, format: Format): string {
  if (format === "json") return JSON.stringify(data, null, 2);
  if (format === "yaml") return stringifyYaml(data);
  if (format === "toml") {
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("TOML 顶层必须是键值对象");
    }
    return stringifyToml(data);
  }
  return serializeProperties(data);
}

function readFormats(): { from: Format; to: Format } {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<{ from: Format; to: Format }>;
      const valid = (value: unknown): value is Format =>
        FORMATS.some((item) => item.value === value);
      if (valid(parsed.from) && valid(parsed.to)) {
        return { from: parsed.from, to: parsed.to };
      }
    }
  } catch {
    // 存储损坏时退回默认格式
  }
  return { from: "json", to: "yaml" };
}

function mount(host: HTMLElement, ctx: PluginContext): void {
  const state = readFormats();

  const root = el("div", "plugin-ui");

  const bar = el("div", "plugin-ui-bar");
  const fromSelect = el("select", "plugin-ui-select") as HTMLSelectElement;
  const toSelect = el("select", "plugin-ui-select") as HTMLSelectElement;
  for (const item of FORMATS) {
    for (const select of [fromSelect, toSelect]) {
      const option = el("option", undefined, item.label) as HTMLOptionElement;
      option.value = item.value;
      select.append(option);
    }
  }
  fromSelect.value = state.from;
  toSelect.value = state.to;

  const swapButton = el("button", "plugin-ui-button", "交换");
  const copyButton = el("button", "plugin-ui-button", "复制结果");
  bar.append(fromSelect, el("span", "plugin-ui-label", "→"), toSelect, swapButton, copyButton);

  const panes = el("div", "plugin-ui-panes");
  const left = el("div", "plugin-ui-side");
  const leftHead = el("div", "plugin-ui-head");
  leftHead.append(el("span", undefined, "输入"));
  const input = el("textarea", "plugin-ui-text") as HTMLTextAreaElement;
  input.placeholder = "粘贴要转换的内容";
  input.spellcheck = false;

  const right = el("div", "plugin-ui-side");
  const rightHead = el("div", "plugin-ui-head");
  rightHead.append(el("span", undefined, "结果"));
  const output = el("textarea", "plugin-ui-text") as HTMLTextAreaElement;
  output.readOnly = true;
  output.spellcheck = false;

  left.append(leftHead, input);
  right.append(rightHead, output);
  panes.append(left, right);

  const status = el("div", "plugin-ui-status");
  root.append(bar, panes, status);
  host.append(root);

  const persist = (): void => {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ from: fromSelect.value, to: toSelect.value }),
    );
  };

  const run = (): void => {
    const text = input.value;
    if (!text.trim()) {
      output.value = "";
      status.textContent = "等待输入";
      status.classList.remove("error");
      return;
    }
    try {
      const data = parseData(text, fromSelect.value as Format);
      output.value = serializeData(data, toSelect.value as Format);
      status.textContent = `${output.value.length} 个字符`;
      status.classList.remove("error");
    } catch (error) {
      output.value = "";
      status.textContent = `转换失败：${error instanceof Error ? error.message : String(error)}`;
      status.classList.add("error");
    }
  };

  input.addEventListener("input", run);
  fromSelect.addEventListener("change", () => {
    persist();
    run();
  });
  toSelect.addEventListener("change", () => {
    persist();
    run();
  });

  swapButton.addEventListener("click", () => {
    const from = fromSelect.value;
    const to = toSelect.value;
    fromSelect.value = to;
    toSelect.value = from;
    input.value = output.value;
    persist();
    run();
    input.focus();
  });

  copyButton.addEventListener("click", () => {
    if (!output.value) {
      ctx.showStatus("没有可复制的结果");
      return;
    }
    void navigator.clipboard.writeText(output.value).then(
      () => ctx.showStatus("结果已复制"),
      () => ctx.showStatus("复制失败，请检查剪贴板权限"),
    );
  });

  input.focus();
  run();
}

const plugin: ToolPlugin = {
  id: "convert",
  title: "格式互转",
  menuId: "tools.convert",
  shortcut: "Ctrl+Shift+Y",
  preferredHeight: 340,
  mount,
};

export default plugin;
