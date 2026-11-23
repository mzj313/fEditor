import { isMarkdown, type TabStore } from "./tabs";

const previewWrap = document.getElementById("preview-wrap") as HTMLDivElement;
const previewHost = document.getElementById("preview-host") as HTMLDivElement;
const binaryWrap = document.getElementById("binary-wrap") as HTMLDivElement;
const previewToc = document.getElementById("preview-toc") as HTMLElement;
const previewResizer = document.getElementById("preview-resizer") as HTMLDivElement;

/** 目录条目统一模型：Markdown 从预览 DOM 扫出来，docx 由渲染层解析后传入 */
export interface TocItem {
  level: number;
  text: string;
  onClick: () => void;
}

/** 目录是否被手动隐藏；与"当前是否在预览"分开判断 */
let tocCollapsed = localStorage.getItem("fEditor.tocCollapsed") === "1";
let store: TabStore | null = null;

/** docx 目录数据：仅在渲染完成后由 binary-preview 填充，owner 用于校验归属标签 */
let docxTocItems: TocItem[] = [];
let docxTocOwner = "";

/** 依赖在 main.ts 里创建完成后注入，避免模块间循环 import */
export function initToc(deps: { store: TabStore }): void {
  store = deps.store;
}

/** 目录服务于 Markdown 预览与 Word 预览，其余类型没有标题结构 */
function tocSupported(): boolean {
  const tab = store?.active;
  if (!tab) return false;
  if (tab.binary === "docx") {
    // 只有当前标签渲染完成且有标题时才显示；渲染前 owner 不匹配会先隐藏
    return !binaryWrap.hidden && docxTocOwner === tab.path && docxTocItems.length > 0;
  }
  return isMarkdown(tab.title) && !previewWrap.hidden;
}

/** 目录在受支持的预览里出现，且未被手动隐藏 */
export function syncTocVisibility(): void {
  const visible = tocSupported() && !tocCollapsed;
  previewToc.hidden = !visible;
  previewResizer.hidden = !visible;
}

/** 由菜单调用；当前不是受支持的预览时没有可切换的目标 */
export function toggleToc(): void {
  if (!tocSupported()) return;
  tocCollapsed = !tocCollapsed;
  localStorage.setItem("fEditor.tocCollapsed", tocCollapsed ? "1" : "0");
  syncTocVisibility();
}

/** Markdown 临时目录：扫描预览区的 h1~h6 构建 */
export function buildToc(): void {
  const headings = Array.from(
    previewHost.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"),
  );
  const seen = new Map<string, number>();
  const items: TocItem[] = headings.map((heading) => {
    const text = heading.textContent?.trim() ?? "";
    const base =
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "") || "section";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    heading.id = count > 0 ? `${base}-${count}` : base;

    return {
      level: Number(heading.tagName.slice(1)),
      text: text || "（无标题）",
      onClick: () => heading.scrollIntoView({ block: "start", behavior: "smooth" }),
    };
  });
  renderTocDom(items);
}

/** docx 渲染完成时由 binary-preview 调用：items 可为空数组表示文档没有标题 */
export function buildDocxToc(ownerPath: string, items: TocItem[]): void {
  docxTocOwner = ownerPath;
  docxTocItems = items;
  // 目录面板 DOM 是与 Markdown 共用的：数据到位后必须重渲染，
  // 否则面板要么空白要么残留上一个文档的条目
  renderTocDom(items);
  syncTocVisibility();
}

/** docx 渲染开始/切走时清除数据，避免残留上一个文档的目录 */
export function resetDocxToc(): void {
  const hadData = docxTocOwner !== "";
  docxTocOwner = "";
  docxTocItems = [];
  if (hadData) syncTocVisibility();
}

/** 目录面板 DOM 渲染：空条目显示占位提示（仅 Markdown 分支会出现空目录） */
function renderTocDom(items: TocItem[]): void {
  previewToc.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "toc-empty";
    empty.textContent = "无标题";
    previewToc.appendChild(empty);
    return;
  }

  const head = document.createElement("div");
  head.className = "toc-head";
  head.textContent = "目录";
  previewToc.appendChild(head);

  for (const item of items) {
    const link = document.createElement("a");
    link.className = "toc-item";
    // href="#" 保持链接语义但阻止默认导航，跳转完全由 onClick 接管
    link.href = "#";
    link.style.paddingLeft = `${(item.level - 1) * 12}px`;
    link.textContent = item.text;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      item.onClick();
    });
    previewToc.appendChild(link);
  }
}
