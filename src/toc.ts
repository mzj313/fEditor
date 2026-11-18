import { isMarkdown, type TabStore } from "./tabs";

const previewWrap = document.getElementById("preview-wrap") as HTMLDivElement;
const previewHost = document.getElementById("preview-host") as HTMLDivElement;
const previewToc = document.getElementById("preview-toc") as HTMLElement;
const previewResizer = document.getElementById("preview-resizer") as HTMLDivElement;

// Markdown 目录是否被手动隐藏；与"当前是否在预览"分开判断
let tocCollapsed = localStorage.getItem("fEditor.tocCollapsed") === "1";
let store: TabStore | null = null;

/** 依赖在 main.ts 里创建完成后注入，避免模块间循环 import */
export function initToc(deps: { store: TabStore }): void {
  store = deps.store;
}

/** 目录只服务于 Markdown 预览：SVG 等图形预览没有标题结构，默认不展示 */
function tocSupported(): boolean {
  const tab = store?.active;
  return !!tab && isMarkdown(tab.title) && !previewWrap.hidden;
}

/** 目录只在 Markdown 预览里出现，且未被手动隐藏 */
export function syncTocVisibility(): void {
  const visible = tocSupported() && !tocCollapsed;
  previewToc.hidden = !visible;
  previewResizer.hidden = !visible;
}

/** 由菜单「Markdown 目录」调用；当前不是 Markdown 预览时没有可切换的目标 */
export function toggleToc(): void {
  if (!tocSupported()) return;
  tocCollapsed = !tocCollapsed;
  localStorage.setItem("fEditor.tocCollapsed", tocCollapsed ? "1" : "0");
  syncTocVisibility();
}

export function buildToc(): void {
  const headings = Array.from(
    previewHost.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"),
  );
  previewToc.replaceChildren();
  if (headings.length === 0) {
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

  const seen = new Map<string, number>();
  for (const heading of headings) {
    const text = heading.textContent?.trim() ?? "";
    const base =
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "") || "section";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    heading.id = count > 0 ? `${base}-${count}` : base;

    const level = Number(heading.tagName.slice(1));
    const link = document.createElement("a");
    link.className = "toc-item";
    link.href = `#${heading.id}`;
    link.style.paddingLeft = `${(level - 1) * 12}px`;
    link.textContent = text || "（无标题）";
    link.addEventListener("click", (event) => {
      event.preventDefault();
      heading.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    previewToc.appendChild(link);
  }
}
