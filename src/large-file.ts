//! 超大文本只读浏览：主编辑器只装载一个分块窗口，通过底部工具条翻页，
//! 避免把 GB 级文件整份读进内存和 IPC 导致界面卡死。

import { invoke } from "@tauri-apps/api/core";
import { app } from "./app-context";
import { promptText } from "./dialogs";
import { WHOLE_FILE_SEARCH_EVENT } from "./find-dialog";
import { showLineSearchResults, type LineSearchHit } from "./sidebar";
import { showTransientStatus, updateStatus } from "./statusbar";
import { formatBytes, type Tab } from "./tabs";

interface ChunkPayload {
  content: string;
  start: number;
  end: number;
  total: number;
  encoding: string;
  eof: boolean;
}

/** 向前翻页的回退字节数，与 Rust 默认块大小保持一致 */
const STEP = 512 * 1024;

const bar = document.getElementById("large-bar") as HTMLElement;
const infoEl = document.getElementById("large-info") as HTMLElement;
const prevButton = document.getElementById("large-prev") as HTMLButtonElement;
const nextButton = document.getElementById("large-next") as HTMLButtonElement;
const jumpButton = document.getElementById("large-jump") as HTMLButtonElement;

/** 当前展示块的信息，翻页按钮据此判断边界 */
let current: {
  tabId: string;
  start: number;
  end: number;
  total: number;
  eof: boolean;
} | null = null;

function updateBar(): void {
  if (!current) return;
  // 已经在最后一块时直接显示 100%，否则以块首位置估算
  const percent = current.eof
    ? 100
    : current.total > 0
      ? (current.start / current.total) * 100
      : 0;
  infoEl.textContent = `只读大文件 · ${formatBytes(current.total)} · ${percent.toFixed(1)}%`;
  prevButton.disabled = current.start <= 0;
  nextButton.disabled = current.eof;
}

/** 切到普通标签时隐藏翻页条 */
export function hideLargeBar(): void {
  bar.hidden = true;
}

/** 把编辑器滚动到当前块的指定比例位置（0 = 块首，1 = 块尾） */
function scrollToRatio(ratio: number): void {
  const clamped = Math.min(1, Math.max(0, ratio));
  requestAnimationFrame(() => {
    const scroller = app.editor.view.scrollDOM;
    const max = scroller.scrollHeight - scroller.clientHeight;
    if (max > 0) scroller.scrollTop = max * clamped;
  });
}

/**
 * 读取并显示大文件的某一块。offset 由翻页 / 百分比跳转给出，
 * Rust 会把它对齐到行首并返回真实的 start/end。
 */
export async function showLargeChunk(tab: Tab, offset: number): Promise<void> {
  if (!tab.path) return;

  // 切回同一标签且块没变时直接复用编辑器状态，省一次读盘
  if (tab.state && tab.large && offset >= tab.large.start && offset < tab.large.end) {
    app.editor.setState(tab.state);
    current = {
      tabId: tab.id,
      start: tab.large.start,
      end: tab.large.end,
      total: tab.large.total,
      eof: tab.large.end >= tab.large.total,
    };
    bar.hidden = false;
    updateBar();
    updateStatus();
    // 同块内跳转也要有反馈：按目标位置在块内的比例滚动
    const span = Math.max(1, tab.large.end - tab.large.start);
    scrollToRatio((offset - tab.large.start) / span);
    return;
  }

  const payload = await invoke<ChunkPayload>("read_file_chunk", { path: tab.path, offset });
  tab.large = {
    total: payload.total,
    start: payload.start,
    end: payload.end,
    encoding: payload.encoding,
  };
  tab.size = payload.total;
  tab.encoding = payload.encoding;
  // 大文件不持有全文：savedText 留空，保存与会话逻辑据此跳过
  tab.savedText = "";
  tab.state = app.editor.createState(payload.content, { readOnly: true });
  // 大块不做语法高亮，避免每次翻页都重新解析
  tab.langApplied = true;
  app.editor.setState(tab.state);
  current = {
    tabId: tab.id,
    start: payload.start,
    end: payload.end,
    total: payload.total,
    eof: payload.eof,
  };
  bar.hidden = false;
  updateBar();
  updateStatus();
  // 换块后从块首开始看，避免被上一块的滚动位置带偏
  scrollToRatio(0);
}

async function step(direction: -1 | 1): Promise<void> {
  const tab = app.store.active;
  if (!tab?.large || !current || current.tabId !== tab.id) return;
  if (direction === 1) {
    if (current.eof) return;
    await showLargeChunk(tab, current.end);
    return;
  }
  if (current.start <= 0) return;
  await showLargeChunk(tab, Math.max(0, current.start - STEP));
}

interface FileSearchHit {
  line: number;
  offset: number;
  text: string;
}

interface FileSearchRange {
  hits: FileSearchHit[];
  nextOffset: number;
  lineCount: number;
  eof: boolean;
}

/** 整次搜索最多收集的命中数，避免超大日志把侧栏撑爆 */
const SEARCH_LIMIT = 1000;
/** 后台分段扫描的段大小 */
const SEARCH_BYTES = 8 * 1024 * 1024;
/** 当前块内最多列出的命中数 */
const BLOCK_HIT_LIMIT = 200;

/** 搜索代数：新搜索或切换文件后，旧任务据此丢弃过期批次 */
let searchRun = 0;

/** 当前块已在内存里，直接逐行匹配，几十毫秒内就能出结果 */
function searchInBlock(tab: Tab, keyword: string, blockStart: number): LineSearchHit[] {
  const state = tab.state;
  if (!state) return [];
  const needle = keyword.toLowerCase();
  const rows: LineSearchHit[] = [];
  const doc = state.doc;
  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text;
    if (!text.toLowerCase().includes(needle)) continue;
    rows.push({
      line: i,
      offset: blockStart,
      text: text.trim().slice(0, 240),
      // 块内行号与整份文件的绝对行号不是一套，用「块N」区分
      label: `块${i}`,
    });
    if (rows.length >= BLOCK_HIT_LIMIT) break;
  }
  return rows;
}

function progressTitle(
  keyword: string,
  blockCount: number,
  found: number,
  scanned: number,
  total: number,
): string {
  const percent = total > 0 ? Math.min(100, Math.round((scanned / total) * 100)) : 0;
  return `“${keyword}” · 当前块 ${blockCount} 处 · 已扫描 ${percent}% · 找到 ${found} 处`;
}

/**
 * 整份文件查找（懒加载）：先用内存里的当前块秒出结果，
 * 再按 8 MB 分段扫描整份文件逐批追加，扫描期间界面不被阻塞。
 */
async function searchWholeFile(keyword: string): Promise<void> {
  const tab = app.store.active;
  if (!tab?.large || !tab.path) return;
  const info = tab.large;
  const run = ++searchRun;
  const total = info.total;
  const blockStart = info.start;
  const blockEnd = info.end;

  // 1. 当前块：直接扫内存文本，先让用户看到结果
  const rows: LineSearchHit[] = searchInBlock(tab, keyword, blockStart);
  const blockCount = rows.length;

  const render = (title: string): void => {
    showLineSearchResults(title, rows, (hit) => {
      if (hit.label) {
        // 当前块命中：内容已在编辑器里，确认块没被翻走再跳行
        if (tab.large?.start === blockStart) app.editor.gotoLine(hit.line);
        return;
      }
      void showLargeChunk(tab, hit.offset).then(() => app.editor.gotoLine(1));
    });
  };
  render(`“${keyword}” · 当前块 ${blockCount} 处 · 正在扫描其余部分…`);
  showTransientStatus(`当前块找到 ${blockCount} 处，正在扫描整份文件…`);

  // 2. 后台分段扫描，边扫边追加
  let offset = 0;
  let lineStart = 0;
  let lastRender = Date.now();
  while (offset < total && rows.length < SEARCH_LIMIT) {
    const range = await invoke<FileSearchRange>("search_in_file_range", {
      path: tab.path,
      query: keyword,
      offset,
      lineStart,
      maxBytes: SEARCH_BYTES,
      maxHits: SEARCH_LIMIT - rows.length,
    });
    // 新搜索已开始或用户已切走，丢弃这一批结果
    if (run !== searchRun || app.store.active?.id !== tab.id) return;

    for (const hit of range.hits) {
      // 当前块区间已经列过，跳过避免重复
      if (hit.offset >= blockStart && hit.offset < blockEnd) continue;
      rows.push(hit);
      if (rows.length >= SEARCH_LIMIT) break;
    }
    lineStart += range.lineCount;
    offset = range.nextOffset;
    if (range.eof) break;

    // 扫描很快时限流渲染，避免列表被高频重建
    if (Date.now() - lastRender >= 150) {
      render(progressTitle(keyword, blockCount, rows.length, offset, total));
      lastRender = Date.now();
    }
  }

  const percent = total > 0 ? Math.min(100, Math.round((offset / total) * 100)) : 100;
  const capped = rows.length >= SEARCH_LIMIT ? `，已达 ${SEARCH_LIMIT} 条上限` : "";
  render(
    `“${keyword}” · 当前块 ${blockCount} 处 · 整份文件 ${rows.length} 处${capped} · 已扫描 ${percent}%`,
  );
  showTransientStatus(`“${keyword}”共找到 ${rows.length} 处`);
}

export function initLargeFile(): void {
  // 文件可能在浏览期间被删除或移动，翻页失败时给一次可见提示
  const guarded = (task: () => Promise<void>) =>
    void task().catch((error) => showTransientStatus(`读取文件块失败：${error}`));

  prevButton.addEventListener("click", () => guarded(() => step(-1)));
  nextButton.addEventListener("click", () => guarded(() => step(1)));
  // Ctrl+F 在大文件模式下由查找弹框派发整文件搜索事件
  window.addEventListener(WHOLE_FILE_SEARCH_EVENT, (event) => {
    const keyword = String((event as CustomEvent<string>).detail ?? "").trim();
    if (!keyword) return;
    void searchWholeFile(keyword).catch((error) =>
      showTransientStatus(`搜索失败：${error}`),
    );
  });
  jumpButton.addEventListener("click", async () => {
    const tab = app.store.active;
    if (!tab?.large) return;
    const input = await promptText("跳到文件百分比（0-100）");
    if (input === null) return;
    const percent = Number(input.replace("%", "").trim());
    if (!Number.isFinite(percent)) {
      showTransientStatus("请输入 0-100 之间的数字");
      return;
    }
    const clamped = Math.min(100, Math.max(0, percent));
    const total = tab.large.total;
    // 100% 若用 total-1，往往正好落在文件末尾的空行上，只会看到空白；
    // 改为回退一个块，保证能看到文件最后一段内容
    const offset =
      clamped >= 100
        ? Math.max(0, total - STEP)
        : Math.min(Math.max(0, total - 1), Math.floor((total * clamped) / 100));
    try {
      await showLargeChunk(tab, offset);
      // 跳到 100% 时再滚到块尾，直接看到文件最后一行
      if (clamped >= 100) scrollToRatio(1);
    } catch (error) {
      showTransientStatus(`读取文件块失败：${error}`);
    }
  });
}
