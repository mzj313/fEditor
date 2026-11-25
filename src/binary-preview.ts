import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { extractDocxHeadings } from "./docx-toc";
import { parseXmind } from "./mindmap";
import { disposeMindmap, renderMindmap } from "./mindmap-view";
import { basename, type BinaryKind } from "./tabs";
import { buildDocxToc, resetDocxToc, type TocItem } from "./toc";
import { getUiScale } from "./ui-zoom";

/** PDF / Word 通常比文本大得多，单独放宽到 100 MB */
const BINARY_LIMIT = 100 * 1024 * 1024;

interface PdfDocument {
  numPages: number;
  getPage(page: number): Promise<PdfPage>;
}

interface PdfPage {
  getViewport(params: { scale: number }): { width: number; height: number };
  render(params: {
    canvasContext: CanvasRenderingContext2D;
    canvas: HTMLCanvasElement;
    viewport: unknown;
  }): {
    promise: Promise<void>;
  };
}

/** pdf.js v6 起 PDFDocumentProxy 不再有 destroy()，释放要走 getDocument 返回的任务 */
interface PdfLoadingTask {
  destroy(): Promise<void>;
}

let pdfDocument: PdfDocument | null = null;
let pdfLoadingTask: PdfLoadingTask | null = null;
let pdfObserver: IntersectionObserver | null = null;
/** 每次渲染自增，异步结果回来时用来判断标签是否已经切走 */
let renderToken = 0;

/** base64 字符串按 8 KB 一批还原成字节，避免大文件一次性展开导致栈溢出 */
function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 8192) {
    const end = Math.min(i + 8192, binary.length);
    for (let j = i; j < end; j += 1) bytes[j] = binary.charCodeAt(j);
  }
  return bytes;
}

async function readBinary(path: string): Promise<Uint8Array<ArrayBuffer>> {
  const base64 = await invoke<string>("read_file_base64", {
    path,
    limit: BINARY_LIMIT,
  });
  return decodeBase64(base64);
}

function statusBlock(host: HTMLElement, text: string, kind: "loading" | "error"): void {
  const box = document.createElement("div");
  box.className = `binary-${kind}`;
  box.textContent = text;
  host.replaceChildren(box);
}

function teardownPdf(): void {
  pdfObserver?.disconnect();
  pdfObserver = null;
  pdfDocument = null;
  pdfPagesHost = null;
  const task = pdfLoadingTask;
  pdfLoadingTask = null;
  if (task) {
    void task.destroy().catch(() => undefined);
  }
}

/** 切走标签或关闭时调用，释放 pdf.js 的 worker 与画布；音视频继续播放 */
export function disposeBinaryPreview(): void {
  renderToken += 1;
  teardownPdf();
  disposeMindmap();
}

/** 关闭标签时停掉对应音视频，避免关掉页面后还在后台响 */
export function disposeBinaryTab(path: string | null): void {
  if (!path) return;
  const media = mediaCache.get(path);
  if (!media) return;
  // 先解绑监听再清 src：清空 src 会触发 onerror，旧代码会走 base64 兜底
  // 把整个文件重读一遍（大文件尤其慢），还会重设 src 干扰换歌
  media.onerror = null;
  media.onended = null;
  media.ontimeupdate = null;
  media.onloadedmetadata = null;
  media.pause();
  media.removeAttribute("src");
  mediaCache.delete(path);
  // 关闭/替换音频时同步清空桌面歌词，避免残留上一首
  publishLyrics("", "");
}

export async function renderBinaryPreview(
  host: HTMLElement,
  toolbar: HTMLElement,
  path: string,
  kind: BinaryKind,
): Promise<void> {
  const token = (renderToken += 1);
  try {
    await renderBinaryPreviewInner(host, toolbar, path, kind, token);
  } catch (error) {
    // 渲染中途抛错时把原因显示出来，避免面板停在半渲染的空白状态
    if (token === renderToken) {
      statusBlock(host, `预览失败：${String(error)}`, "error");
    }
  }
}

async function renderBinaryPreviewInner(
  host: HTMLElement,
  toolbar: HTMLElement,
  path: string,
  kind: BinaryKind,
  token: number,
): Promise<void> {
  teardownPdf();
  toolbar.hidden = true;
  toolbar.replaceChildren();

  // 音频不读进内存：交给 asset 协议流式读取，切标签时播放也不会中断
  if (kind === "audio") {
    renderAudio(host, toolbar, path);
    return;
  }

  // 图片同样交给自定义协议直接解码，避免 base64 把大图放大三分之一
  if (kind === "image") {
    renderImage(host, toolbar, path);
    return;
  }

  // 视频和音频一样走流式协议，服务端按 4 MB 分片返回
  if (kind === "video") {
    renderVideo(host, toolbar, path);
    return;
  }

  // PDF 交给 pdf.js 自己按 Range 请求分片，不必把整个文件 base64 进内存
  if (kind === "pdf") {
    statusBlock(host, "正在加载 PDF…", "loading");
    await renderPdf(host, toolbar, path, token);
    return;
  }

  // docx-preview 需要完整 ArrayBuffer，只能整读
  statusBlock(host, "正在读取文件…", "loading");

  let bytes: Uint8Array;
  try {
    bytes = await readBinary(path);
  } catch (error) {
    if (token !== renderToken) return;
    statusBlock(host, `无法打开文件：${String(error)}`, "error");
    return;
  }
  if (token !== renderToken) return;

  if (kind === "mind") {
    // XMind 本质是 ZIP：解包 content.json 后转成统一树模型再交给渲染层
    try {
      const root = parseXmind(bytes);
      if (token !== renderToken) return;
      host.replaceChildren();
      renderMindmap(host, root);
    } catch (error) {
      if (token !== renderToken) return;
      statusBlock(host, `思维导图解析失败：${String(error)}`, "error");
    }
    return;
  }

  await renderDocx(host, bytes, token, path);
}

/* ---------------- PDF ---------------- */

async function renderPdf(
  host: HTMLElement,
  toolbar: HTMLElement,
  path: string,
  token: number,
): Promise<void> {
  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  let workerSrc: string;
  try {
    // 用 legacy 构建：它自带老 API 的 polyfill，macOS 较旧的 WKWebView
    // 缺少 Map.getOrInsertComputed 等新方法，标准构建会直接报错
    [pdfjs, workerSrc] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url").then((mod) => mod.default),
    ]);
  } catch (error) {
    statusBlock(host, `PDF 渲染组件加载失败：${String(error)}`, "error");
    return;
  }
  if (token !== renderToken) return;

  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

  const failure = await loadPdfDocument(host, pdfjs, path, token);
  if (token !== renderToken) return;
  if (failure) {
    statusBlock(host, failure, "error");
    return;
  }
  if (!pdfDocument) return;

  const pagesHost = document.createElement("div");
  pagesHost.className = "pdf-pages";
  host.replaceChildren(pagesHost);
  const updatePage = buildPdfToolbar(toolbar, host, pagesHost);
  await layoutPdfPages(host, pagesHost, token);
  // 懒渲染是排版完成后才建页面占位，工具栏初建时页数还是 0，这里补一次刷新
  updatePage();
}

/**
 * 优先流式加载：pdf.js 通过 Range 请求按需取分片。
 * 自定义协议在某些环境下可能不可用，此时回退到整读，保证 PDF 至少能打开。
 * 返回 null 表示成功，否则是要显示在面板上的错误文本。
 */
async function loadPdfDocument(
  host: HTMLElement,
  pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs"),
  path: string,
  token: number,
): Promise<string | null> {
  try {
    const task = pdfjs.getDocument({ url: convertFileSrc(path, "feditor-media") });
    pdfLoadingTask = task as unknown as PdfLoadingTask;
    pdfDocument = (await task.promise) as unknown as PdfDocument;
    return null;
  } catch (error) {
    // 已经切走标签时失败属正常，不再浪费一次整读
    if (token !== renderToken) return null;
    console.warn("PDF 流式加载失败，回退到整读", error);
  }

  if (token !== renderToken) return null;
  statusBlock(host, "正在读取文件…", "loading");

  try {
    const bytes = await readBinary(path);
    if (token !== renderToken) return null;
    const task = pdfjs.getDocument({ data: bytes });
    pdfLoadingTask = task as unknown as PdfLoadingTask;
    pdfDocument = (await task.promise) as unknown as PdfDocument;
    return null;
  } catch (error) {
    return `PDF 解析失败：${String(error)}`;
  }
}

let pdfScale = 1;
/** 当前 PDF 容器；界面缩放变化时按它找到已渲染页面去重绘 */
let pdfPagesHost: HTMLElement | null = null;
let pdfCurrentPage = 1;

function buildPdfToolbar(
  toolbar: HTMLElement,
  host: HTMLElement,
  pagesHost: HTMLElement,
): () => void {
  toolbar.hidden = false;
  const zoomOut = document.createElement("button");
  zoomOut.textContent = "−";
  zoomOut.title = "缩小";
  const zoomText = document.createElement("span");
  zoomText.className = "pdf-zoom";
  const zoomIn = document.createElement("button");
  zoomIn.textContent = "＋";
  zoomIn.title = "放大";
  const pageText = document.createElement("span");
  pageText.className = "pdf-page-num";
  const first = document.createElement("button");
  first.textContent = "⤒";
  first.title = "回到第一页";
  first.addEventListener("click", () => host.scrollTo({ top: 0, behavior: "smooth" }));

  const applyZoom = async (next: number): Promise<void> => {
    pdfScale = Math.min(3, Math.max(0.4, next));
    zoomText.textContent = `${Math.round(pdfScale * 100)}%`;
    const token = renderToken;
    await layoutPdfPages(host, pagesHost, token);
    updatePage();
  };
  zoomOut.addEventListener("click", () => void applyZoom(pdfScale - 0.2));
  zoomIn.addEventListener("click", () => void applyZoom(pdfScale + 0.2));

  const updatePage = (): void => {
    const pages = Array.from(pagesHost.children) as HTMLElement[];
    const mid = host.scrollTop + host.clientHeight / 2;
    let current = 1;
    for (const page of pages) {
      if (page.offsetTop <= mid) current = Number(page.dataset.page ?? current);
    }
    pdfCurrentPage = current;
    pageText.textContent = `第 ${current} / ${pages.length} 页`;
  };
  host.onscroll = updatePage;

  pdfScale = 1;
  zoomText.textContent = "100%";
  toolbar.replaceChildren(first, zoomOut, zoomText, zoomIn, pageText);
  updatePage();
  return updatePage;
}

async function layoutPdfPages(
  host: HTMLElement,
  pagesHost: HTMLElement,
  token: number,
): Promise<void> {
  if (!pdfDocument) return;
  pdfObserver?.disconnect();
  pdfObserver = null;
  pagesHost.replaceChildren();
  pdfPagesHost = pagesHost;

  const width = Math.max(320, host.clientWidth - 48);
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const holder = entry.target as HTMLElement;
        observer.unobserve(holder);
        void paintPdfPage(holder, token);
      }
    },
    { root: host, rootMargin: "300px 0px" },
  );
  pdfObserver = observer;

  for (let number = 1; number <= pdfDocument.numPages; number += 1) {
    const page = await pdfDocument.getPage(number);
    if (token !== renderToken) return;
    // 先按 100% 的页面宽度算出占位高度，避免滚动时页面高度跳动
    const base = page.getViewport({ scale: 1 });
    const scale = (width / base.width) * pdfScale;
    const viewport = page.getViewport({ scale });
    const holder = document.createElement("div");
    holder.className = "pdf-page";
    holder.dataset.page = String(number);
    holder.style.width = `${viewport.width}px`;
    holder.style.height = `${viewport.height}px`;
    pagesHost.appendChild(holder);
    observer.observe(holder);
  }
}

async function paintPdfPage(holder: HTMLElement, token: number): Promise<void> {
  if (!pdfDocument || token !== renderToken) return;
  const number = Number(holder.dataset.page ?? 1);
  const page = await pdfDocument.getPage(number);
  if (token !== renderToken) return;
  const width = parseFloat(holder.style.width);
  const base = page.getViewport({ scale: 1 });
  // 界面用 transform 缩放，不会重排重绘：画布必须按「屏幕像素比 × 界面缩放」
  // 栅格化，否则非 100% 时位图被拉伸而发糊。上限 3 防止高倍率下画布过大爆内存。
  const uiScale = Math.max(1, getUiScale());
  const ratio = Math.min((window.devicePixelRatio || 1) * uiScale, 3);
  const viewport = page.getViewport({ scale: (width / base.width) * ratio });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  const context = canvas.getContext("2d");
  if (!context) return;
  await page.render({ canvasContext: context, canvas, viewport }).promise;
  if (token !== renderToken) return;
  holder.replaceChildren(canvas);
  holder.dataset.painted = "1";
}

/** 界面缩放变化后重绘已渲染的 PDF 页（防抖合并连续手势），未渲染的页交给懒加载 */
let pdfRepaintTimer: number | null = null;

function schedulePdfRepaint(): void {
  if (!pdfPagesHost) return;
  if (pdfRepaintTimer !== null) window.clearTimeout(pdfRepaintTimer);
  pdfRepaintTimer = window.setTimeout(() => {
    pdfRepaintTimer = null;
    if (!pdfPagesHost) return;
    const holders = pdfPagesHost.querySelectorAll<HTMLElement>(".pdf-page[data-painted]");
    holders.forEach((holder) => void paintPdfPage(holder, renderToken));
  }, 250);
}

window.addEventListener("ui-scale-changed", schedulePdfRepaint);

/* ---------------- DOCX ---------------- */

async function renderDocx(
  host: HTMLElement,
  bytes: Uint8Array,
  token: number,
  path: string | null,
): Promise<void> {
  // 旧目录立即失效：重复打开同一文件或渲染失败时都不会残留上一个文档的目录
  resetDocxToc();
  let renderAsync: typeof import("docx-preview").renderAsync;
  try {
    ({ renderAsync } = await import("docx-preview"));
  } catch (error) {
    statusBlock(host, `Word 渲染组件加载失败：${String(error)}`, "error");
    return;
  }
  if (token !== renderToken) return;

  const body = document.createElement("div");
  body.className = "docx-body";
  // docx-preview 把页面样式写进这个容器，必须真的挂到 DOM 上样式才生效
  const styleHost = document.createElement("div");
  styleHost.className = "docx-style";
  body.appendChild(styleHost);
  const pages = document.createElement("div");
  pages.className = "docx-pages";
  body.appendChild(pages);
  host.replaceChildren(body);

  try {
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    await renderAsync(buffer, pages, styleHost, {
      className: "docx",
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      renderHeaders: true,
      renderFooters: true,
      useBase64URL: true,
    });
  } catch (error) {
    if (token !== renderToken) return;
    statusBlock(host, `Word 解析失败：${String(error)}`, "error");
    return;
  }
  if (token !== renderToken) return;

  sanitizeDocx(pages);
  holdDocxLinks(pages);
  buildDocxTocPanel(path, bytes, pages);
}

/**
 * Word 目录：从 docx 的 XML 解析标题，再映射回 docx-preview 渲染出的段落元素。
 * 解析与 DOM 映射都在渲染完成后进行，失败或无标题时目录面板保持隐藏。
 */
function buildDocxTocPanel(
  path: string | null,
  bytes: Uint8Array,
  pages: HTMLElement,
): void {
  if (!path) return;
  let entries: ReturnType<typeof extractDocxHeadings> = [];
  try {
    entries = extractDocxHeadings(bytes);
  } catch {
    return;
  }
  if (entries.length === 0) {
    buildDocxToc(path, []);
    return;
  }

  // docx-preview 每个正文 w:p 渲染一个 <p>；页眉页脚是 <header>/<footer> 标签容器，
  // 其中的段落不计入正文序号，必须排除否则标题映射整体错位
  const paragraphs = Array.from(pages.querySelectorAll("p")).filter(
    (p) => !p.closest("header, footer"),
  );
  const items: TocItem[] = [];
  for (const entry of entries) {
    let target: HTMLParagraphElement | undefined = paragraphs[entry.paraIndex];
    // 序号对应可能因渲染差异错位，文本不一致时按精确文本全量匹配兜底
    if (!target || (target.textContent ?? "").trim() !== entry.text) {
      target = paragraphs.find((p) => (p.textContent ?? "").trim() === entry.text);
    }
    if (!target) continue;
    items.push({
      level: entry.level,
      text: entry.text,
      onClick: () => target?.scrollIntoView({ block: "start", behavior: "smooth" }),
    });
  }
  buildDocxToc(path, items);
}

/** docx 是外部文件，渲染出来的 HTML 不能带脚本和远程资源 */
function sanitizeDocx(root: HTMLElement): void {
  root.querySelectorAll("script, iframe, object, embed").forEach((node) => node.remove());
  root.querySelectorAll<HTMLElement>("*").forEach((node) => {
    for (const attr of Array.from(node.attributes)) {
      if (/^on/i.test(attr.name) || attr.value.trim().toLowerCase().startsWith("javascript:")) {
        node.removeAttribute(attr.name);
      }
    }
    if (node instanceof HTMLImageElement && /^https?:/i.test(node.src)) {
      // 远程图片会泄露打开行为，直接移除，避免打开文档就发网络请求
      node.removeAttribute("src");
    }
  });
}

/** 文档里的外链交给系统浏览器，避免把 WebView 本身导航走 */
function holdDocxLinks(root: HTMLElement): void {
  root.addEventListener("click", (event) => {
    const anchor = (event.target as HTMLElement | null)?.closest("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (!/^(https?:|mailto:)/i.test(href)) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    window.open(href, "_blank");
  });
}

/* ---------------- 图片 ---------------- */

/** 图片优先走自定义协议；协议被拦截时才退回 base64，体积上限更保守 */
const IMAGE_FALLBACK_LIMIT = 40 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

function renderImage(host: HTMLElement, toolbar: HTMLElement, path: string): void {
  toolbar.hidden = false;

  const stage = document.createElement("div");
  stage.className = "image-stage";
  const image = document.createElement("img");
  image.className = "image-preview";
  image.alt = basename(path);
  const meta = document.createElement("div");
  meta.className = "image-meta";
  meta.textContent = "正在读取图片…";
  stage.append(image, meta);
  host.replaceChildren(stage);

  let naturalWidth = 0;
  let naturalHeight = 0;
  let scale = 1;

  const zoomText = document.createElement("span");
  zoomText.className = "image-zoom";
  zoomText.textContent = "—";

  const applyScale = (next: number): void => {
    if (!naturalWidth) return;
    // 按原始像素换算宽度，反复缩放不会累积误差
    scale = Math.min(4, Math.max(0.05, next));
    image.style.width = `${Math.round(naturalWidth * scale)}px`;
    image.style.height = "auto";
    zoomText.textContent = `${Math.round(scale * 100)}%`;
  };

  const zoomOut = document.createElement("button");
  zoomOut.textContent = "−";
  zoomOut.title = "缩小";
  zoomOut.addEventListener("click", () => applyScale(scale / 1.25));

  const zoomIn = document.createElement("button");
  zoomIn.textContent = "＋";
  zoomIn.title = "放大";
  zoomIn.addEventListener("click", () => applyScale(scale * 1.25));

  const actual = document.createElement("button");
  actual.textContent = "1:1";
  actual.title = "按原始尺寸显示";
  actual.addEventListener("click", () => applyScale(1));

  toolbar.replaceChildren(zoomOut, zoomText, zoomIn, actual);

  image.addEventListener("load", () => {
    naturalWidth = image.naturalWidth;
    naturalHeight = image.naturalHeight;
    // 默认缩放到容器内完整可见，小图保持原尺寸不放大
    const availWidth = Math.max(120, (host.clientWidth || window.innerWidth) - 36);
    const availHeight = Math.max(
      120,
      (host.clientHeight || window.innerHeight - 220) - 36,
    );
    const fit = Math.min(1, availWidth / naturalWidth, availHeight / naturalHeight);
    applyScale(fit);
    meta.textContent = `${naturalWidth} × ${naturalHeight} px`;
  });

  let fellBack = false;
  image.addEventListener("error", () => {
    if (!fellBack) {
      fellBack = true;
      void fallbackToDataUri(image, path, meta);
      return;
    }
    meta.textContent = "无法显示图片：文件可能已损坏，或系统不支持该格式。";
    meta.classList.add("image-error");
  });

  image.src = convertFileSrc(path, "feditor-media");
}

async function fallbackToDataUri(
  image: HTMLImageElement,
  path: string,
  meta: HTMLElement,
): Promise<void> {
  try {
    const base64 = await invoke<string>("read_file_base64", {
      path,
      limit: IMAGE_FALLBACK_LIMIT,
    });
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    image.src = `data:${IMAGE_MIME[ext] ?? "application/octet-stream"};base64,${base64}`;
  } catch {
    meta.textContent = "无法显示图片：读取文件失败，文件可能超过 40 MB。";
    meta.classList.add("image-error");
  }
}

/* ---------------- 音频 / 视频 ---------------- */

/**
 * 按路径缓存媒体元素：切标签只是把它摘下再挂回，播放不中断。
 * src 走自定义协议，服务端按 Range 分片返回；视频单次最多 4 MB。
 */
const mediaCache = new Map<string, HTMLMediaElement>();
const PLAY_RATES = [0.75, 1, 1.25, 1.5];
/** 倍速全局生效：换歌后沿用同一速度，不必每次重选 */
const RATE_KEY = "fEditor.mediaPlaybackRate";

function getPlaybackRate(): number {
  const raw = Number.parseFloat(localStorage.getItem(RATE_KEY) ?? "");
  return PLAY_RATES.includes(raw) ? raw : 1;
}

function savePlaybackRate(rate: number): void {
  localStorage.setItem(RATE_KEY, String(rate));
}

/* ---- 歌词 ---- */

interface LyricLine {
  /** 秒；-1 表示没有时间轴的静态歌词 */
  time: number;
  text: string;
}

/** 按音频路径缓存解析结果：目录扫描 + 读文件只用做一次 */
const lyricCache = new Map<string, LyricLine[]>();
const LRC_TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/** 当前展示的歌词行与高亮状态；换歌或重渲染时重置 */
let lyricView: {
  box: HTMLElement;
  nodes: HTMLElement[];
  times: number[];
  active: number;
} | null = null;

/** 解析 LRC：支持一行多个时间标签；纯文本歌词退化为静态展示 */
function parseLrc(raw: string): LyricLine[] {
  const timed: LyricLine[] = [];
  const plain: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // [ar:歌手] / [ti:歌名] 之类的元信息不显示
    if (/^\[(ar|ti|al|by|offset|re|ve|length|au|kana):/i.test(trimmed)) continue;

    LRC_TIME_TAG.lastIndex = 0;
    const times: number[] = [];
    let end = 0;
    let match: RegExpExecArray | null;
    while ((match = LRC_TIME_TAG.exec(trimmed))) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
      times.push(minutes * 60 + seconds + fraction);
      end = LRC_TIME_TAG.lastIndex;
    }
    const text = trimmed.slice(end).trim();
    if (!times.length) {
      if (text) plain.push(text);
      continue;
    }
    for (const time of times) timed.push({ time, text });
  }

  timed.sort((a, b) => a.time - b.time);
  if (timed.length === 0) return plain.map((text) => ({ time: -1, text }));
  return timed;
}

/** 把当前歌词推到桌面歌词窗口；空串表示无歌词，窗口随之清空 */
function publishLyrics(current: string, next: string): void {
  void emit("desktop-lyric", { current, next }).catch(() => {
    // 桌面歌词未开启时没有接收方，忽略即可
  });
}

async function attachLyrics(
  media: HTMLMediaElement,
  box: HTMLElement,
  path: string,
): Promise<void> {
  let lines = lyricCache.get(path);
  if (!lines) {
    try {
      const payload = await invoke<{ path: string; content: string } | null>("find_lyrics", {
        path,
      });
      lines = payload ? parseLrc(payload.content) : [];
    } catch {
      // 查找失败按「没有歌词」处理，不影响播放
      lines = [];
    }
    lyricCache.set(path, lines);
  }
  // 异步返回时可能已换歌：旧卡片已移出文档就不再渲染
  if (!box.isConnected) return;
  if (lines.length === 0) {
    publishLyrics("", "");
    return;
  }

  const nodes: HTMLElement[] = [];
  box.replaceChildren();
  for (const line of lines) {
    const item = document.createElement("div");
    item.className = "lyric-line";
    // 间奏行经常是空文本，用音符占位而不是留白
    item.textContent = line.text || "♪";
    box.append(item);
    nodes.push(item);
  }
  box.hidden = false;

  if (lines[0].time < 0) {
    lyricView = null;
    // 纯文本歌词没有时间轴，桌面歌词只静态显示前两句
    publishLyrics(nodes[0]?.textContent ?? "", nodes[1]?.textContent ?? "");
    return;
  }
  lyricView = { box, nodes, times: lines.map((line) => line.time), active: -1 };
  syncLyrics(media.currentTime);
}

/** 按当前播放时间切换高亮行，并让该行停在歌词框中间 */
function syncLyrics(currentTime: number): void {
  const view = lyricView;
  if (!view) return;
  let index = -1;
  for (let i = 0; i < view.times.length; i += 1) {
    if (view.times[i] > currentTime + 0.15) break;
    index = i;
  }
  if (index === view.active) return;
  if (view.active >= 0) view.nodes[view.active]?.classList.remove("active");
  view.active = index;
  if (index < 0) {
    publishLyrics("", view.nodes[0]?.textContent ?? "");
    return;
  }
  const node = view.nodes[index];
  node.classList.add("active");
  publishLyrics(node.textContent ?? "", view.nodes[index + 1]?.textContent ?? "");
  // 用相对矩形计算偏移：offsetTop 依赖 offsetParent，歌词框不是定位元素时
  // 会指向更外层容器，导致滚动位置整体跑偏、高亮行滚出可视区
  const boxRect = view.box.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  const delta = nodeRect.top - boxRect.top;
  view.box.scrollTop += delta - view.box.clientHeight / 2 + nodeRect.height / 2;
}
/** 兜底方案会把文件读进内存，超过这个体积就不再尝试 */
const MEDIA_FALLBACK_LIMIT = 100 * 1024 * 1024;

/**
 * 常驻媒体容器：面板隐藏（display:none）或元素被移出文档时，
 * WebView2 会中止媒体网络请求并抛 MEDIA_ERR_ABORTED，播放随之中断。
 * 切标签时先把元素迁移到这里，元素始终留在文档里，只做位置搬家。
 */
const mediaSink = (() => {
  const sink = document.createElement("div");
  sink.id = "media-sink";
  document.body.append(sink);
  return sink;
})();

/** 把缓存的音视频元素挪进常驻容器，保证切标签时不被断流 */
export function parkActiveMedia(): void {
  for (const media of mediaCache.values()) {
    if (media.parentElement !== mediaSink) mediaSink.append(media);
  }
}

/* ---- 播放模式 ---- */

export type PlayMode = "once" | "repeat-one" | "sequential" | "repeat-all";

const PLAY_MODE_KEY = "fEditor.mediaPlayMode";
const PLAY_MODES: PlayMode[] = ["once", "repeat-one", "sequential", "repeat-all"];
const PLAY_MODE_LABELS: Record<PlayMode, string> = {
  once: "单曲播放",
  "repeat-one": "单曲循环",
  sequential: "顺序播放",
  "repeat-all": "列表循环",
};

/** 播放模式全局生效并持久化：切换标签后新播放的媒体沿用同一模式 */
function getPlayMode(): PlayMode {
  const saved = localStorage.getItem(PLAY_MODE_KEY) as PlayMode | null;
  return saved && PLAY_MODES.includes(saved) ? saved : "once";
}

function setPlayMode(mode: PlayMode): void {
  localStorage.setItem(PLAY_MODE_KEY, mode);
}

/** 顺序/列表循环需要打开下一个文件，由 preview-panel 注入 openPath */
let navigateTo: ((path: string) => Promise<void>) | null = null;
/** 自动切歌后待播放的路径：渲染到该文件时自动开始播放 */
let autoplayPath: string | null = null;

/** 双击文件树中的音频：提前标记自动播放目标，渲染完成后立刻开始播放 */
export function setAutoplay(path: string): void {
  autoplayPath = path;
}

export function setMediaNavigator(fn: (path: string) => Promise<void>): void {
  navigateTo = fn;
}

/** 统一路径比较口径：不同来源的路径斜杠与大小写可能不一致 */
function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
}

/** 播放结束：按模式决定重播、切下一首还是停下 */
async function handleMediaEnded(media: HTMLMediaElement, path: string): Promise<void> {
  const mode = getPlayMode();
  if (mode === "repeat-one") {
    // 原生 loop 在个别 WebView 的分片流上不生效，这里显式重播兜底
    media.currentTime = 0;
    void media.play().catch(() => undefined);
    return;
  }
  if (mode === "once" || !navigateTo) return;
  try {
    const files = await invoke<string[]>("list_audio_siblings", { path });
    if (files.length === 0) return;
    const index = files.findIndex((item) => samePath(item, path));
    if (index < 0) return;
    const next =
      mode === "repeat-all"
        ? files[(index + 1) % files.length]
        : files[index + 1];
    if (!next || samePath(next, path)) return;
    autoplayPath = next;
    await navigateTo(next);
  } catch {
    // 目录读不到时静默停止，不影响当前播放器状态
  }
}

function mediaMime(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".aac")) return "audio/aac";
  if (lower.endsWith(".flac")) return "audio/flac";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  return "audio/mpeg";
}

async function fallbackToBlob(
  media: HTMLMediaElement,
  path: string,
  meta: HTMLElement,
): Promise<void> {
  // 兜底会重建 src 并 load()，必须记录播放状态，否则会从头开始
  const wasPlaying = !media.paused;
  const position = media.currentTime;
  try {
    const base64 = await invoke<string>("read_file_base64", {
      path,
      limit: MEDIA_FALLBACK_LIMIT,
    });
    const bytes = decodeBase64(base64);
    const blob = new Blob([bytes], { type: mediaMime(path) });
    media.src = URL.createObjectURL(blob);
    media.load();
    media.addEventListener(
      "loadedmetadata",
      () => {
        media.currentTime = position;
        if (wasPlaying) void media.play().catch(() => undefined);
      },
      { once: true },
    );
  } catch {
    meta.textContent = "无法播放：读取文件失败，文件可能超过 100 MB。";
    meta.classList.add("media-error");
  }
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function mediaErrorReason(code: number): string {
  if (code === 1) return "播放被中断";
  if (code === 2) return "读取文件失败";
  if (code === 3) return "解码失败";
  if (code === 4) return "系统不支持这个音视频编码";
  return "未知错误";
}

function renderAudio(host: HTMLElement, toolbar: HTMLElement, path: string): void {
  lyricView = null;
  let audio = mediaCache.get(path);
  if (!audio) {
    // 用自带协议的流式地址：asset:// 在部分 WKWebView 上播不了媒体
    audio = new Audio(convertFileSrc(path, "feditor-media"));
    audio.preload = "metadata";
    audio.controls = true;
    mediaCache.set(path, audio);
  }
  // 重新挂回 DOM 时保留 src，避免每次切标签都从头加载
  audio.style.width = "100%";
  audio.loop = getPlayMode() === "repeat-one";
  audio.playbackRate = getPlaybackRate();

  const card = document.createElement("div");
  card.className = "audio-card";

  const title = document.createElement("div");
  title.className = "media-title";
  title.textContent = basename(path);

  const meta = document.createElement("div");
  meta.className = "media-meta";
  meta.textContent = "本地文件，切换标签不会中断播放";

  const player = document.createElement("div");
  player.className = "audio-player";
  player.appendChild(audio);

  // 歌词区域默认隐藏，找到同名 .lrc 后再显示
  const lyrics = document.createElement("div");
  lyrics.className = "media-lyrics";
  lyrics.hidden = true;

  card.append(title, meta, player, lyrics);
  host.replaceChildren(card);

  let fellBack = false;
  audio.onerror = () => {
    const code = audio.error?.code ?? 0;
    // 错误码 1 是「播放被中止」：切标签迁移元素时可能触发，
    // 属预期中断，不能走 base64 兜底（那会整篇重读并从头播放）
    if (code === 1) return;
    // 自定义协议在个别 WebView 上会被拦，退一步用 base64 + blob 兜底
    if (!fellBack) {
      fellBack = true;
      void fallbackToBlob(audio, path, meta);
      return;
    }
    meta.textContent = `无法播放：${mediaErrorReason(code)}（错误码 ${code}）。建议转成 mp3 或 m4a。`;
    meta.classList.add("media-error");
  };

  buildMediaToolbar(toolbar, audio, path);

  // 歌词异步查找，不阻塞播放器出现
  void attachLyrics(audio, lyrics, path);

  // 顺序/列表循环自动切过来的文件：渲染完成即开始播放
  if (autoplayPath && samePath(autoplayPath, path)) {
    autoplayPath = null;
    void audio.play().catch(() => undefined);
  }
}

function renderVideo(host: HTMLElement, toolbar: HTMLElement, path: string): void {
  let video = mediaCache.get(path) as HTMLVideoElement | undefined;
  if (!video) {
    video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    video.src = convertFileSrc(path, "feditor-media");
    mediaCache.set(path, video);
  }
  video.style.width = "100%";
  video.loop = getPlayMode() === "repeat-one";
  video.playbackRate = getPlaybackRate();

  const card = document.createElement("div");
  card.className = "video-card";

  const title = document.createElement("div");
  title.className = "media-title";
  title.textContent = basename(path);

  const meta = document.createElement("div");
  meta.className = "media-meta";
  meta.textContent = "支持 MP4（H.264/AAC）与 WebM，切换标签不会中断播放";

  const player = document.createElement("div");
  player.className = "video-player";
  player.appendChild(video);

  card.append(title, meta, player);
  host.replaceChildren(card);

  let fellBack = false;
  video.onerror = () => {
    const code = video?.error?.code ?? 0;
    // 同音频：错误码 1 是元素迁移引起的预期中止，不触发兜底
    if (code === 1) return;
    if (!fellBack) {
      fellBack = true;
      void fallbackToBlob(video as HTMLVideoElement, path, meta);
      return;
    }
    meta.textContent = `无法播放：${mediaErrorReason(code)}（错误码 ${code}）。建议使用 MP4（H.264/AAC）或 WebM。`;
    meta.classList.add("media-error");
  };

  buildMediaToolbar(toolbar, video, path);
}

function buildMediaToolbar(toolbar: HTMLElement, media: HTMLMediaElement, path: string): void {
  toolbar.hidden = false;

  const rateLabel = document.createElement("span");
  rateLabel.className = "media-label";
  rateLabel.textContent = "倍速";

  const rateButtons = PLAY_RATES.map((rate) => {
    const button = document.createElement("button");
    button.textContent = `${rate}×`;
    button.title = `播放速度 ${rate} 倍`;
    button.classList.toggle("on", Math.abs(media.playbackRate - rate) < 0.01);
    button.addEventListener("click", () => {
      media.playbackRate = rate;
      media.defaultPlaybackRate = rate;
      savePlaybackRate(rate);
      rateButtons.forEach((item) =>
        item.classList.toggle("on", Math.abs(media.playbackRate - rate) < 0.01),
      );
    });
    return button;
  });

  // 播放模式按钮：点一次切到下一种，全局持久化，后续打开的媒体沿用
  const modeButton = document.createElement("button");
  modeButton.className = "media-mode";
  modeButton.textContent = PLAY_MODE_LABELS[getPlayMode()];
  modeButton.title = "播放模式：单曲播放 / 单曲循环 / 顺序播放 / 列表循环";
  modeButton.addEventListener("click", () => {
    const current = getPlayMode();
    const nextMode = PLAY_MODES[(PLAY_MODES.indexOf(current) + 1) % PLAY_MODES.length];
    setPlayMode(nextMode);
    media.loop = nextMode === "repeat-one";
    modeButton.textContent = PLAY_MODE_LABELS[nextMode];
  });

  const time = document.createElement("span");
  time.className = "media-time";
  const updateTime = (): void => {
    time.textContent = `${formatTime(media.currentTime)} / ${formatTime(media.duration)}`;
    syncLyrics(media.currentTime);
  };
  updateTime();
  // 用 on* 赋值而不是 addEventListener，重复渲染时不会叠加监听
  media.ontimeupdate = updateTime;
  media.onloadedmetadata = updateTime;
  media.onended = () => {
    void handleMediaEnded(media, path);
  };

  toolbar.replaceChildren(rateLabel, ...rateButtons, modeButton, time);
}
