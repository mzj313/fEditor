import type { EditorState } from "@codemirror/state";

export type BinaryKind = "pdf" | "docx" | "audio" | "video" | "image" | "mind";

/** 超大文本只读浏览状态：记录当前块范围与文件总大小 */
export interface LargeFileInfo {
  total: number;
  /** 当前块起始字节，已对齐到行首 */
  start: number;
  /** 当前块结束字节（不含） */
  end: number;
  encoding: string;
}

export interface Tab {
  id: string;
  path: string | null;
  title: string;
  dirty: boolean;
  encoding: string;
  eol: "LF" | "CRLF";
  hasBom: boolean;
  mtime: number;
  size: number;
  savedText: string;
  state: EditorState | null;
  loaded: boolean;
  scrollTop: number;
  /** 预览面板的滚动位置：切换标签与关闭后重开时恢复 */
  previewScrollTop: number;
  preview: boolean;
  error: string | null;
  langApplied: boolean;
  pendingCursor: number | null;
  /** 二进制只读预览类型；为空表示普通文本标签 */
  binary?: BinaryKind;
  /** 超过 100 MB 的文本走只读分块浏览，此时不持有全文 */
  large?: LargeFileInfo;
  /** 画板标签：SVG 文本 + 可视化手绘画布 */
  canvas?: boolean;
  /** Markdown 预览缓存：内容与路径都没变时直接复用，跳过整页重渲染 */
  previewCacheHtml?: string;
  previewCacheText?: string;
  previewCachePath?: string | null;
}

let seq = 0;
let untitled = 0;

export function tabId(): string {
  seq += 1;
  return `t${seq}`;
}

export function nextUntitledTitle(): string {
  untitled += 1;
  return `未命名-${untitled}`;
}

/** 恢复会话时同步计数器，避免新标签与已有「未命名-N」重名 */
export function noteUntitledTitle(title: string): void {
  // 画板等带扩展名的草稿（未命名-3.svg）同样要占号，否则重启后会重名
  const matched = /^未命名-(\d+)(\.[^.]+)?$/.exec(title);
  if (matched) untitled = Math.max(untitled, Number(matched[1]));
}

export function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

export function isMarkdown(title: string): boolean {
  const lower = title.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

/** 直接打开 .svg 时按图形预览处理，扩展名大小写不敏感。 */
export function isSvg(title: string): boolean {
  return title.toLowerCase().endsWith(".svg");
}

/** JSON 文件需要语法高亮与格式化入口，扩展名大小写不敏感。 */
export function isJson(title: string): boolean {
  return title.toLowerCase().endsWith(".json");
}

/** YAML 既需要语法高亮，也需要缩进错误的友好提示。 */
export function isYaml(title: string): boolean {
  const lower = title.toLowerCase();
  return lower.endsWith(".yaml") || lower.endsWith(".yml");
}

/** TOML 常见于 Cargo.toml、pyproject.toml 等配置文件。 */
export function isToml(title: string): boolean {
  return title.toLowerCase().endsWith(".toml");
}

/** CSV/TSV 保留文本编辑能力，同时支持表格预览，扩展名大小写不敏感。 */
export function isCsv(title: string): boolean {
  const lower = title.toLowerCase();
  return lower.endsWith(".csv") || lower.endsWith(".tsv");
}

/** PDF / Word / 图片 / 音视频 / XMind 走只读预览，不进入文本编辑器。 */
export function binaryKindOf(title: string): BinaryKind | null {
  const lower = title.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  // .xmind 是 ZIP 压缩包，只能解包后渲染，无法当文本编辑
  if (lower.endsWith(".xmind")) return "mind";
  if (/\.(png|jpe?g|gif|webp|bmp|ico)$/.test(lower)) return "image";
  if (/\.(mp3|m4a|wav|aac|flac)$/.test(lower)) return "audio";
  if (/\.(mp4|webm)$/.test(lower)) return "video";
  return null;
}

export function languageOf(title: string): string {
  if (isMarkdown(title)) return "Markdown";
  if (isJson(title)) return "JSON";
  if (isYaml(title)) return "YAML";
  if (isToml(title)) return "TOML";
  const binary = binaryKindOf(title);
  if (binary === "pdf") return "PDF 预览";
  if (binary === "docx") return "Word 预览";
  if (binary === "image") return "图片预览";
  if (binary === "audio") return "音频";
  if (binary === "video") return "视频";
  if (binary === "mind") return "思维导图";
  return "纯文本";
}

export function normalizePath(path: string): string {
  const unified = path.replace(/\\/g, "/");
  return /^[A-Za-z]:/.test(unified) ? unified.toLowerCase() : unified;
}

/** 文件大小展示：大文件状态栏与翻页条共用 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function createTab(partial: Partial<Tab> = {}): Tab {
  return {
    id: partial.id ?? tabId(),
    path: partial.path ?? null,
    title: partial.title ?? nextUntitledTitle(),
    dirty: partial.dirty ?? false,
    encoding: partial.encoding ?? "UTF-8",
    eol: partial.eol ?? "LF",
    hasBom: partial.hasBom ?? false,
    mtime: partial.mtime ?? 0,
    size: partial.size ?? 0,
    savedText: partial.savedText ?? "",
    state: partial.state ?? null,
    loaded: partial.loaded ?? false,
    scrollTop: partial.scrollTop ?? 0,
    previewScrollTop: partial.previewScrollTop ?? 0,
    preview: partial.preview ?? false,
    error: partial.error ?? null,
    langApplied: partial.langApplied ?? false,
    pendingCursor: partial.pendingCursor ?? null,
    binary: partial.binary,
    large: partial.large,
    canvas: partial.canvas,
  };
}

export class TabStore {
  tabs: Tab[] = [];
  activeId: string | null = null;

  add(tab: Tab): void {
    // 会话恢复会沿用上次的 id（t1、t2…），而 tabId() 的计数每次启动从 0 开始，
    // 重名会让 get() 命中旧标签，导致切换标签时显示成另一个文件的内容
    let guard = 0;
    while (this.get(tab.id) && guard < 1000) {
      tab.id = tabId();
      guard += 1;
    }
    this.tabs.push(tab);
  }

  get(id: string | null): Tab | null {
    if (!id) return null;
    return this.tabs.find((tab) => tab.id === id) ?? null;
  }

  get active(): Tab | null {
    return this.get(this.activeId);
  }

  setActive(id: string): void {
    if (this.get(id)) this.activeId = id;
  }

  remove(id: string): void {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;
    this.tabs.splice(index, 1);
    if (this.activeId === id) {
      const next = this.tabs[index] ?? this.tabs[index - 1] ?? null;
      this.activeId = next ? next.id : null;
    }
  }
}
