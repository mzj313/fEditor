//! 正则测试器：实时高亮匹配、列出捕获组。
//! 匹配数量设上限，避免用户写出灾难性回溯的正则时把界面卡死。

import type { ToolPlugin } from "../types";
import "./regex.css";

interface Match {
  index: number;
  text: string;
  groups: string[];
}

const STORE_KEY = "fEditor.plugin.regex";
/** 单次最多收集的匹配数：高亮和列表都不至于撑爆 DOM */
const MAX_MATCHES = 500;

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

/** 收集所有匹配；空匹配手动推进 lastIndex，否则 exec 会原地打转 */
function collectMatches(regex: RegExp, text: string): Match[] {
  const matches: Match[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    matches.push({ index: match.index, text: match[0], groups: match.slice(1).map((g) => g ?? "") });
    if (match[0] === "") regex.lastIndex += 1;
    if (matches.length >= MAX_MATCHES) break;
  }
  return matches;
}

/** 用 mark 标出命中片段；全程 textContent，正则内容不会被当成 HTML */
function renderHighlight(container: HTMLElement, text: string, matches: Match[]): void {
  container.replaceChildren();
  let cursor = 0;
  for (const match of matches) {
    if (match.index > cursor) {
      container.append(document.createTextNode(text.slice(cursor, match.index)));
    }
    const mark = el("mark", "plugin-regex-mark");
    // 空匹配在视觉上不可见，用符号占位提示这里命中了
    mark.textContent = match.text || "∅";
    container.append(mark);
    cursor = match.index + match.text.length;
  }
  if (cursor < text.length) container.append(document.createTextNode(text.slice(cursor)));
}

function readState(): { pattern: string; flags: string } {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { pattern?: string; flags?: string };
      return {
        pattern: typeof parsed.pattern === "string" ? parsed.pattern : "",
        flags: typeof parsed.flags === "string" ? parsed.flags : "i",
      };
    }
  } catch {
    // 忽略损坏的存储
  }
  return { pattern: "", flags: "i" };
}

function mount(host: HTMLElement): void {
  const saved = readState();
  const root = el("div", "plugin-regex");

  /* ---------- 顶部：表达式与选项 ---------- */
  const bar = el("div", "plugin-regex-bar");
  const slash = el("span", "plugin-regex-slash", "/");
  const patternInput = el("input", "plugin-regex-pattern") as HTMLInputElement;
  patternInput.placeholder = "输入正则，如 \\b\\w+@\\w+\\.\\w+\\b";
  patternInput.value = saved.pattern;
  patternInput.spellcheck = false;
  const slashEnd = el("span", "plugin-regex-slash", "/g");

  const flagBoxes = new Map<string, HTMLInputElement>();
  for (const [flag, label] of [
    ["i", "忽略大小写"],
    ["m", "多行"],
    ["s", "点匹配换行"],
  ] as const) {
    const wrapper = el("label", "plugin-regex-flag");
    const box = el("input") as HTMLInputElement;
    box.type = "checkbox";
    box.checked = saved.flags.includes(flag);
    flagBoxes.set(flag, box);
    wrapper.append(box, el("span", undefined, label));
    bar.append(wrapper);
  }
  bar.prepend(slash, patternInput, slashEnd);

  /* ---------- 主体：文本 + 结果 ---------- */
  const panes = el("div", "plugin-regex-panes");

  const left = el("div", "plugin-regex-side");
  left.append(el("div", "plugin-regex-head", "测试文本"));
  const textArea = el("textarea", "plugin-regex-text") as HTMLTextAreaElement;
  textArea.placeholder = "粘贴要匹配的文本";
  textArea.spellcheck = false;
  textArea.value = [
    "示例：hello@example.com",
    "订单号 A-1024，金额 99.00",
    "第二行 another@test.org",
  ].join("\n");
  left.append(textArea);

  const right = el("div", "plugin-regex-side");
  const head = el("div", "plugin-regex-head");
  const countLabel = el("span", undefined, "结果");
  head.append(countLabel);

  const highlight = el("pre", "plugin-regex-highlight");
  const list = el("div", "plugin-regex-list");
  right.append(head, highlight, list);

  panes.append(left, right);
  root.append(bar, panes);
  host.append(root);

  const persist = (): void => {
    const flags = [...flagBoxes.entries()]
      .filter(([, box]) => box.checked)
      .map(([flag]) => flag)
      .join("");
    localStorage.setItem(STORE_KEY, JSON.stringify({ pattern: patternInput.value, flags }));
  };

  const run = (): void => {
    highlight.replaceChildren();
    list.replaceChildren();
    const text = textArea.value;
    // 表达式右侧实时显示当前生效的标志位，避免只看复选框猜
    const checkedFlags = [...flagBoxes.entries()]
      .filter(([, box]) => box.checked)
      .map(([flag]) => flag)
      .join("");
    slashEnd.textContent = `/${checkedFlags}g`;

    if (!patternInput.value) {
      highlight.textContent = text;
      countLabel.textContent = "结果";
      return;
    }

    let regex: RegExp;
    try {
      // 始终带 g：高亮和列表都需要遍历全部命中
      regex = new RegExp(patternInput.value, `${checkedFlags}g`);
    } catch (error) {
      countLabel.textContent = "表达式无效";
      list.append(el("div", "plugin-regex-error", String(error)));
      highlight.textContent = text;
      return;
    }

    const matches = collectMatches(regex, text);
    countLabel.textContent = `命中 ${matches.length} 处${matches.length >= MAX_MATCHES ? "（已达上限）" : ""}`;
    renderHighlight(highlight, text, matches);

    if (!matches.length) {
      list.append(el("div", "plugin-regex-empty", "没有匹配"));
      return;
    }
    matches.forEach((match, index) => {
      const row = el("div", "plugin-regex-item");
      const title = el("div", "plugin-regex-item-title");
      title.append(
        el("span", "plugin-regex-index", `#${index + 1}`),
        el("span", "plugin-regex-pos", `位置 ${match.index}`),
        el("code", "plugin-regex-value", match.text || "（空匹配）"),
      );
      row.append(title);
      if (match.groups.length) {
        const groups = el("div", "plugin-regex-groups", match.groups.map((g, i) => `$${i + 1}=${g}`).join("　"));
        row.append(groups);
      }
      list.append(row);
    });
  };

  // 输入与选项变化都重新匹配；正则极短，无需防抖
  patternInput.addEventListener("input", () => {
    persist();
    run();
  });
  for (const box of flagBoxes.values()) {
    box.addEventListener("change", () => {
      persist();
      run();
    });
  }
  textArea.addEventListener("input", run);

  patternInput.focus();
  run();
}

const plugin: ToolPlugin = {
  id: "regex",
  title: "正则测试器",
  menuId: "tools.regex",
  shortcut: "Ctrl+Shift+R",
  preferredHeight: 360,
  mount,
};

export default plugin;
