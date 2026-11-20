import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { disposeBinaryPreview, renderBinaryPreview } from "./binary-preview";
import { message } from "./dialogs";
import type { EditorController } from "./editor";
import { renderMarkdown, renderMermaidDiagrams, resolveLocalImages } from "./preview";
import { isMindText, parseFreemind, parseOpml } from "./mindmap";
import { disposeMindmap, renderMindmap } from "./mindmap-view";
import { activeText } from "./session-state";
import { showTransientStatus, updateStatus } from "./statusbar";
import { isMarkdown, isSvg, type Tab, type TabStore } from "./tabs";
import { buildToc, syncTocVisibility } from "./toc";

const editorHost = document.getElementById("editor-host") as HTMLDivElement;
const previewWrap = document.getElementById("preview-wrap") as HTMLDivElement;
const previewHost = document.getElementById("preview-host") as HTMLDivElement;
const binaryWrap = document.getElementById("binary-wrap") as HTMLDivElement;
const binaryHost = document.getElementById("binary-host") as HTMLDivElement;
const binaryToolbar = document.getElementById("binary-toolbar") as HTMLDivElement;

let store: TabStore | null = null;
let editor: EditorController | null = null;
let openPath: ((path: string) => Promise<void>) | null = null;

/** 依赖在 main.ts 里创建完成后注入，避免模块间循环 import */
export function initPreviewPanel(deps: {
  store: TabStore;
  editor: EditorController;
  openPath: (path: string) => Promise<void>;
}): void {
  store = deps.store;
  editor = deps.editor;
  openPath = deps.openPath;
}

export function hidePreview(): void {
  previewWrap.hidden = true;
  editorHost.hidden = false;
  // 文本类思维导图预览的缩放/拖动监听也一并释放
  disposeMindmap();
  if (!binaryWrap.hidden) {
    binaryWrap.hidden = true;
    binaryToolbar.hidden = true;
    // 切回文本标签时释放 pdf.js 的 worker 和画布，避免大文件常驻内存
    disposeBinaryPreview();
  }
  syncTocVisibility();
}

/** 二进制标签展示：隐藏编辑器与 Markdown 预览，显示二进制面板（由 activate 调用） */
export function showBinaryPanel(): void {
  editorHost.hidden = true;
  previewWrap.hidden = true;
  binaryWrap.hidden = false;
}

/**
 * 预览型标签切换时先占位：立刻切到预览面板并显示加载提示，
 * 避免 Markdown 渲染完成前编辑器原文先闪现出来
 */
export function stagePreviewPanel(): void {
  const hint = document.createElement("div");
  hint.className = "binary-loading";
  hint.textContent = "正在渲染预览…";
  previewHost.replaceChildren(hint);
  previewWrap.hidden = false;
  editorHost.hidden = true;
}

export async function showBinary(tab: Tab): Promise<void> {
  if (!tab.binary || !tab.path) return;
  // 可见性只由 activate 同步决定：这里再改一次会让旧的异步渲染
  // 在切走之后把预览面板重新翻出来
  await renderBinaryPreview(binaryHost, binaryToolbar, tab.path, tab.binary);
}

export async function showPreview(tab: Tab): Promise<void> {
  if (!isMarkdown(tab.title) && !isSvg(tab.title) && !isMindText(tab.title)) return;

  // .mm / .opml 是纯文本 XML：保留编辑能力，预览时按当前编辑器内容解析
  if (isMindText(tab.title)) {
    const text = activeText(tab);
    try {
      const root = tab.title.toLowerCase().endsWith(".mm")
        ? parseFreemind(text)
        : parseOpml(text);
      previewHost.replaceChildren();
      renderMindmap(previewHost, root);
    } catch (error) {
      const box = document.createElement("div");
      box.className = "binary-error";
      box.textContent = `思维导图解析失败：${String(error)}`;
      previewHost.replaceChildren(box);
    }
    previewWrap.hidden = false;
    editorHost.hidden = true;
    // 导图没有标题层级，左侧 Markdown 目录一并隐藏
    syncTocVisibility();
    updateStatus();
    return;
  }

  if (isSvg(tab.title)) {
    const text = activeText(tab);
    // 带脚本或内联事件（如 data-open 弹窗交互）的图必须真正执行脚本，
    // img 上下文一律不执行，因此改用沙箱 iframe；纯静态图继续走 img，
    // 既快又不引入任何脚本执行面
    // 交互文档由媒体协议按磁盘路径提供，未保存的草稿没有路径，只能用 img 兜底
    const interactive = hasScripts(text) && Boolean(tab.path);
    previewHost.replaceChildren(
      interactive ? createInteractiveSvgFrame(tab) : createStaticSvgImage(text, tab.title),
    );
    // SVG 没有标题结构，不构建目录；syncTocVisibility 会把左侧目录一起隐藏
    previewWrap.hidden = false;
    editorHost.hidden = true;
    syncTocVisibility();
    updateStatus();
    return;
  }

  const text = activeText(tab);
  const html = await renderMarkdown(text);
  if (store && store.activeId !== tab.id) return;

  // mermaid 是异步渲染，先在游离容器里完成再整体换入，避免渲染期间污染可见预览
  const staging = document.createElement("div");
  staging.innerHTML = html;
  await renderMermaidDiagrams(staging);
  if (store && store.activeId !== tab.id) return;

  // 相对路径图片需要以当前文档目录为基准转成本地 data URI
  await resolveLocalImages(staging, tab.path);
  if (store && store.activeId !== tab.id) return;

  previewHost.replaceChildren(...Array.from(staging.childNodes));
  buildToc();
  previewWrap.hidden = false;
  editorHost.hidden = true;
  // markdown 分支也要同步目录显隐，否则左侧目录永远不会出现
  syncTocVisibility();
  updateStatus();
}

/** 图内带脚本或内联事件处理器时需要真正执行，只有 iframe 能做这件事 */
function hasScripts(text: string): boolean {
  return /<script[\s>]/i.test(text) || /\son[a-z]+\s*=/i.test(text);
}

/** 静态 SVG：img + data URI，浏览器不会执行任何脚本 */
function createStaticSvgImage(text: string, title: string): HTMLImageElement {
  const image = document.createElement("img");
  image.className = "svg-preview";
  image.alt = title;
  image.src = `data:image/svg+xml;base64,${utf8Base64(text)}`;
  return image;
}

/**
 * 交互 SVG：交给媒体协议的独立文档渲染。
 * 主文档 CSP 为 script-src 'self' + frame-src 'none'，srcdoc / data: 里的内联脚本
 * 都会被拦；改用 feditor-media 的独立文档，脚本可执行且与主文档不同源，
 * 拿不到应用页面与 Tauri 的 IPC。
 */
function createInteractiveSvgFrame(tab: Tab): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.className = "svg-interactive";
  frame.setAttribute("sandbox", "allow-scripts");
  // 带版本参数，文件改动后不会命中旧缓存
  frame.src = `${convertFileSrc(tab.path as string, "feditor-media")}?wrap=1&v=${tab.mtime}`;
  // 加载失败时给出可见提示，否则打包环境里只会看到一块空白
  frame.addEventListener("error", () =>
    showTransientStatus("SVG 交互预览加载失败"),
  );
  return frame;
}

export async function togglePreview(): Promise<void> {
  if (!store || !editor) return;
  const tab = store.active;
  if (!tab || !(isMarkdown(tab.title) || isSvg(tab.title) || isMindText(tab.title)))
    return;
  tab.preview = !tab.preview;
  if (tab.preview) {
    await showPreview(tab);
  } else {
    hidePreview();
    editor.focus();
  }
  updateStatus();
}

// btoa 只接受 Latin-1，直接传中文会报错，因此先按字节拼成二进制字符串
function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunk = 8192; // 分批展开，避免一次性铺开海量参数导致调用栈溢出
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * 预览区链接：本页锚点原地滚动，外链交给系统浏览器，
 * 其余按当前文档目录解析成本地路径后打开（面包屑、文内互链都走这条）。
 */
async function handlePreviewLink(event: MouseEvent): Promise<void> {
  const anchor = (event.target as HTMLElement | null)?.closest("a");
  if (!anchor) return;
  const href = anchor.getAttribute("href") ?? "";
  if (!href) return;

  if (href.startsWith("#")) {
    event.preventDefault();
    const id = decodeURIComponent(href.slice(1));
    const heading = previewHost.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    heading?.scrollIntoView({ block: "start", behavior: "smooth" });
    return;
  }
  if (/^(https?:|mailto:)/i.test(href)) {
    event.preventDefault();
    window.open(href, "_blank");
    return;
  }

  const tab = store?.active;
  if (!tab?.path) return;
  event.preventDefault();
  // 去锚点/查询串并还原百分号编码，再按文档所在目录拼绝对路径
  const clean = decodeURI(href.split("#")[0].split("?")[0]);
  if (!clean) return;
  const sep = tab.path.includes("\\") ? "\\" : "/";
  const dir = tab.path.slice(0, Math.max(tab.path.lastIndexOf("/"), tab.path.lastIndexOf("\\")));
  const joined = /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(clean)
    ? clean
    : `${dir}${sep}${clean.replace(/[/\\]+/g, sep)}`;
  await openPath?.(joined);
}

previewHost.addEventListener("click", (event) => {
  void handlePreviewLink(event);
});

/** 把当前 Markdown 文档渲染成与预览一致的 HTML，交给打印窗口生成 PDF */
export async function printActiveMarkdown(): Promise<void> {
  const tab = store?.active;
  if (!tab || !isMarkdown(tab.title)) {
    showTransientStatus("打印预览目前只支持 Markdown 文件");
    return;
  }
  // 与 showPreview 同一条渲染管线：mermaid 图和本地图片都要转成可独立展示的内容
  const staging = document.createElement("div");
  staging.innerHTML = await renderMarkdown(activeText(tab));
  await renderMermaidDiagrams(staging);
  if (tab.path) await resolveLocalImages(staging, tab.path);

  try {
    await invoke("print_markdown", { html: staging.innerHTML, title: tab.title });
    showTransientStatus("正在生成打印预览…");
  } catch (error) {
    await message(`生成打印预览失败：\n${error}`);
  }
}
