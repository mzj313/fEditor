import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { parseXmind } from "./mindmap";
import { disposeMindmap, renderMindmap } from "./mindmap-view";
import { basename, type BinaryKind } from "./tabs";
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
  media.pause();
  media.removeAttribute("src");
  mediaCache.delete(path);
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

  await renderDocx(host, bytes, token);
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

async function renderDocx(host: HTMLElement, bytes: Uint8Array, token: number): Promise<void> {
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
/** 兜底方案会把文件读进内存，超过这个体积就不再尝试 */
const MEDIA_FALLBACK_LIMIT = 100 * 1024 * 1024;

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
  try {
    const base64 = await invoke<string>("read_file_base64", {
      path,
      limit: MEDIA_FALLBACK_LIMIT,
    });
    const bytes = decodeBase64(base64);
    const blob = new Blob([bytes], { type: mediaMime(path) });
    media.src = URL.createObjectURL(blob);
    media.load();
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

  card.append(title, meta, player);
  host.replaceChildren(card);

  let fellBack = false;
  audio.onerror = () => {
    // 自定义协议在个别 WebView 上会被拦，退一步用 base64 + blob 兜底
    if (!fellBack) {
      fellBack = true;
      void fallbackToBlob(audio, path, meta);
      return;
    }
    const code = audio.error?.code ?? 0;
    meta.textContent = `无法播放：${mediaErrorReason(code)}（错误码 ${code}）。建议转成 mp3 或 m4a。`;
    meta.classList.add("media-error");
  };

  buildMediaToolbar(toolbar, audio);
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
    if (!fellBack) {
      fellBack = true;
      void fallbackToBlob(video as HTMLVideoElement, path, meta);
      return;
    }
    const code = video?.error?.code ?? 0;
    meta.textContent = `无法播放：${mediaErrorReason(code)}（错误码 ${code}）。建议使用 MP4（H.264/AAC）或 WebM。`;
    meta.classList.add("media-error");
  };

  buildMediaToolbar(toolbar, video);
}

function buildMediaToolbar(toolbar: HTMLElement, media: HTMLMediaElement): void {
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
      rateButtons.forEach((item) =>
        item.classList.toggle("on", Math.abs(media.playbackRate - rate) < 0.01),
      );
    });
    return button;
  });

  const loop = document.createElement("button");
  loop.textContent = "⟲ 循环";
  loop.title = "循环播放";
  loop.classList.toggle("on", media.loop);
  loop.addEventListener("click", () => {
    media.loop = !media.loop;
    loop.classList.toggle("on", media.loop);
  });

  const time = document.createElement("span");
  time.className = "media-time";
  const updateTime = (): void => {
    time.textContent = `${formatTime(media.currentTime)} / ${formatTime(media.duration)}`;
  };
  updateTime();
  // 用 on* 赋值而不是 addEventListener，重复渲染时不会叠加监听
  media.ontimeupdate = updateTime;
  media.onloadedmetadata = updateTime;

  toolbar.replaceChildren(rateLabel, ...rateButtons, loop, time);
}
