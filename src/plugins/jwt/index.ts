//! JWT 解码：拆开 Header/Payload 并格式化展示，只做查看，不校验签名。
//! 不保存 token，避免把凭据留在本地存储里。

import type { PluginContext, ToolPlugin } from "../types";
import "../ui.css";

interface DecodedJwt {
  header: string;
  payload: string;
  payloadValue: Record<string, unknown>;
}

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

function base64UrlDecode(segment: string): string {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function decodeJwt(token: string): DecodedJwt {
  const parts = token.split(".");
  if (parts.length === 5) throw new Error("这是 JWE（加密令牌），这里只支持普通 JWT");
  if (parts.length !== 3) throw new Error("JWT 应该由 Header.Payload.Signature 三段组成");

  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(base64UrlDecode(parts[0]));
  } catch {
    throw new Error("Header 不是合法的 Base64URL JSON");
  }
  try {
    payload = JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    throw new Error("Payload 不是合法的 Base64URL JSON");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Payload 不是 JSON 对象");
  }

  return {
    header: JSON.stringify(header, null, 2),
    payload: JSON.stringify(payload, null, 2),
    payloadValue: payload as Record<string, unknown>,
  };
}

function formatTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString("zh-CN", { hour12: false });
}

function describeExpiry(payload: Record<string, unknown>): string {
  const exp = payload.exp;
  if (typeof exp !== "number") return "签名未校验";
  const expired = exp * 1000 <= Date.now();
  return `签名未校验 · ${expired ? "已于" : "将于"} ${formatTime(exp)} 过期`;
}

function mount(host: HTMLElement, ctx: PluginContext): void {
  const root = el("div", "plugin-ui");

  const bar = el("div", "plugin-ui-bar");
  bar.append(el("span", "plugin-ui-label", "JWT"));
  const copyButton = el("button", "plugin-ui-button", "复制 Payload");
  const clearButton = el("button", "plugin-ui-button", "清空");
  bar.append(copyButton, clearButton);

  const panes = el("div", "plugin-ui-panes");

  const left = el("div", "plugin-ui-side");
  const leftHead = el("div", "plugin-ui-head");
  leftHead.append(el("span", undefined, "Token"));
  const input = el("textarea", "plugin-ui-text") as HTMLTextAreaElement;
  input.placeholder = "粘贴 JWT，输入即解析";
  input.spellcheck = false;
  left.append(leftHead, input);

  const right = el("div", "plugin-ui-side");

  const headerBlock = el("div", "plugin-ui-block");
  const headerHead = el("div", "plugin-ui-head");
  headerHead.append(el("span", undefined, "Header"));
  const headerPre = el("pre", "plugin-ui-pre");
  headerBlock.append(headerHead, headerPre);

  const payloadBlock = el("div", "plugin-ui-block");
  const payloadHead = el("div", "plugin-ui-head");
  payloadHead.append(el("span", undefined, "Payload"));
  const payloadPre = el("pre", "plugin-ui-pre");
  payloadBlock.append(payloadHead, payloadPre);

  right.append(headerBlock, payloadBlock);
  panes.append(left, right);

  const status = el("div", "plugin-ui-status");
  root.append(bar, panes, status);
  host.append(root);

  let lastPayload = "";

  const render = (): void => {
    const token = input.value.trim();
    if (!token) {
      headerPre.textContent = "";
      payloadPre.textContent = "";
      lastPayload = "";
      status.textContent = "粘贴 JWT 后自动解析，内容不会保存";
      status.classList.remove("error");
      return;
    }
    try {
      const decoded = decodeJwt(token);
      headerPre.textContent = decoded.header;
      payloadPre.textContent = decoded.payload;
      lastPayload = decoded.payload;
      status.textContent = describeExpiry(decoded.payloadValue);
      status.classList.remove("error");
    } catch (error) {
      headerPre.textContent = "";
      payloadPre.textContent = "";
      lastPayload = "";
      status.textContent = error instanceof Error ? error.message : String(error);
      status.classList.add("error");
    }
  };

  input.addEventListener("input", render);
  clearButton.addEventListener("click", () => {
    input.value = "";
    render();
    input.focus();
  });
  copyButton.addEventListener("click", () => {
    if (!lastPayload) {
      ctx.showStatus("没有可复制的 Payload");
      return;
    }
    void navigator.clipboard.writeText(lastPayload).then(
      () => ctx.showStatus("Payload 已复制"),
      () => ctx.showStatus("复制失败，请检查剪贴板权限"),
    );
  });

  input.focus();
  render();
}

const plugin: ToolPlugin = {
  id: "jwt",
  title: "JWT 解码",
  menuId: "tools.jwt",
  shortcut: "Ctrl+Shift+J",
  preferredHeight: 340,
  mount,
};

export default plugin;
