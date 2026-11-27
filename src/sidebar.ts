import { invoke } from "@tauri-apps/api/core";
import { app } from "./app-context";
import { ensureEditMode, openPath } from "./file-open";
import { splitPath } from "./paths";
import { showTransientStatus } from "./statusbar";
import { normalizePath } from "./tabs";

interface SidebarDeps {
  /** 标签栏的文件树按钮在无工作区时会直接打开选目录对话框 */
  openFolder(): Promise<void>;
}

let deps: SidebarDeps;

export function initSidebar(d: SidebarDeps): void {
  deps = d;
}

// 侧栏是否被用户手动收起；与“有没有打开文件夹”分开，避免收起后找不到入口
let treeCollapsed = false;

const sidebar = document.getElementById("sidebar") as HTMLElement;
const sidebarResizer = document.getElementById("sidebar-resizer") as HTMLDivElement;
const rootCrumbs = document.getElementById("root-crumbs") as HTMLDivElement;
const rootUpButton = document.getElementById("root-up") as HTMLButtonElement;
const fileTreeHost = document.getElementById("file-tree") as HTMLDivElement;

/* ---- 资源管理器搜索（文件名 / 全文） ---- */

interface SearchHit {
  path: string;
  name: string;
  depth: number;
}

/** 全文搜索命中的一行 */
interface ContentHit {
  path: string;
  name: string;
  line: number;
  text: string;
}

/** 搜索模式：名称只扫文件名，内容则逐行读文本 */
type SearchMode = "name" | "content";

/** 深度下拉：值是额外下探的子目录层数，0 表示只看起点这一层 */
const SEARCH_DEPTHS: Array<[value: string, label: string]> = [
  ["0", "1 层"],
  ["1", "2 层"],
  ["2", "3 层"],
  ["4", "5 层"],
  ["99999", "不限"],
];

const searchWrap = document.createElement("div");
searchWrap.className = "tree-search";

const searchTop = document.createElement("div");
searchTop.className = "tree-search-top";

// 模式按钮同时承担入口提示：名称 / 全文
const modeButton = document.createElement("button");
modeButton.type = "button";
modeButton.className = "tree-search-mode";
modeButton.title = "切换搜索模式：文件名 / 全文";

const searchInput = document.createElement("input");
searchInput.className = "tree-search-input";
searchInput.type = "search";

const searchOptions = document.createElement("div");
searchOptions.className = "tree-search-opts";

const depthSelect = document.createElement("select");
depthSelect.className = "tree-search-depth";
depthSelect.title = "搜索深度";
for (const [value, label] of SEARCH_DEPTHS) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  depthSelect.append(option);
}
depthSelect.value = "0";

// 全文搜索的两个开关，名称模式隐藏
const caseButton = document.createElement("button");
caseButton.type = "button";
caseButton.className = "tree-search-opt";
caseButton.textContent = "Aa";
caseButton.title = "区分大小写";

const regexButton = document.createElement("button");
regexButton.type = "button";
regexButton.className = "tree-search-opt";
regexButton.textContent = ".*";
regexButton.title = "使用正则表达式";

const searchResults = document.createElement("div");
searchResults.className = "tree-search-results";
searchResults.hidden = true;

searchTop.append(modeButton, searchInput);
searchOptions.append(depthSelect, caseButton, regexButton);
searchWrap.append(searchTop, searchOptions);
sidebar.insertBefore(searchWrap, fileTreeHost);
sidebar.insertBefore(searchResults, fileTreeHost);

let mode: SearchMode = "name";
let caseSensitive = false;
let useRegex = false;

/** 按当前模式切换占位符与可见选项 */
function syncSearchMode(): void {
  const content = mode === "content";
  modeButton.textContent = content ? "全文" : "名称";
  modeButton.classList.toggle("active", content);
  searchInput.placeholder = content ? "搜索文件内容" : "搜索文件名";
  depthSelect.hidden = content;
  caseButton.hidden = !content;
  regexButton.hidden = !content;
  caseButton.classList.toggle("active", caseSensitive);
  regexButton.classList.toggle("active", useRegex);
}

let searchTimer: number | undefined;
/** 请求令牌：连续输入时只认最后一次结果，避免旧结果覆盖新结果 */
let searchToken = 0;
let lastSearchRoot: string | null = null;

/** 退出搜索并恢复目录树 */
function resetSearch(): void {
  searchToken += 1;
  if (searchTimer !== undefined) {
    window.clearTimeout(searchTimer);
    searchTimer = undefined;
  }
  searchInput.value = "";
  searchResults.replaceChildren();
  searchResults.hidden = true;
  fileTreeHost.hidden = false;
}

function renderSearchEmpty(text: string): void {
  searchResults.replaceChildren();
  const tip = document.createElement("div");
  tip.className = "tree-search-empty";
  tip.textContent = text;
  searchResults.append(tip);
  searchResults.hidden = false;
  fileTreeHost.hidden = true;
}

async function runSearch(): Promise<void> {
  const keyword = searchInput.value.trim();
  if (!keyword) return;
  if (mode === "content") await runContentSearch(keyword);
  else await runNameSearch(keyword);
}

async function runNameSearch(keyword: string): Promise<void> {
  const base = app.tree.searchBase;
  if (!base) return;
  const token = ++searchToken;
  try {
    const hits = await invoke<SearchHit[]>("search_files", {
      root: base,
      keyword,
      maxDepth: Number(depthSelect.value),
    });
    if (token !== searchToken) return;
    renderSearchResults(hits);
  } catch (error) {
    if (token !== searchToken) return;
    renderSearchEmpty(`搜索失败：${error}`);
  }
}

async function runContentSearch(keyword: string): Promise<void> {
  // 全文搜索面向整个工作区，避免只在当前文件所在子目录里找
  const root = app.tree.currentRoot;
  if (!root) return;
  const token = ++searchToken;
  renderSearchEmpty("正在搜索…");
  try {
    const hits = await invoke<ContentHit[]>("search_content", {
      root,
      query: keyword,
      caseSensitive,
      useRegex,
    });
    if (token !== searchToken) return;
    renderContentResults(hits);
  } catch (error) {
    if (token !== searchToken) return;
    renderSearchEmpty(`搜索失败：${error}`);
  }
}

function renderSearchResults(hits: SearchHit[]): void {
  searchResults.replaceChildren();
  const head = document.createElement("div");
  head.className = "tree-search-count";
  head.textContent = hits.length > 0 ? `找到 ${hits.length} 个文件` : "没有匹配的文件";
  searchResults.append(head);

  for (const hit of hits) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "tree-search-row";
    row.title = hit.path;

    const name = document.createElement("span");
    name.className = "tree-search-name";
    name.textContent = hit.name;

    const dir = document.createElement("span");
    dir.className = "tree-search-dir";
    // 展示结果所在目录，便于区分同名文件
    const parent = hit.path.slice(0, hit.path.length - hit.name.length);
    dir.textContent = parent.replace(/[\\/]+$/, "") || ".";

    row.append(name, dir);
    row.addEventListener("click", () => {
      // 打开后收起搜索，让目录树恢复并定位到该文件
      resetSearch();
      void openPath(hit.path).then(() => app.tree.markActive(hit.path));
    });
    searchResults.append(row);
  }
  searchResults.hidden = false;
  fileTreeHost.hidden = true;
}

/** 全文搜索结果按文件分组：同一文件只显示一次文件名，下面跟各行命中 */
function renderContentResults(hits: ContentHit[]): void {
  if (hits.length === 0) {
    renderSearchEmpty(`没有找到包含“${searchInput.value.trim()}”的内容`);
    return;
  }
  searchResults.replaceChildren();
  const fileCount = new Set(hits.map((hit) => hit.path)).size;
  const head = document.createElement("div");
  head.className = "tree-search-count";
  head.textContent = `${hits.length} 处匹配，${fileCount} 个文件`;
  searchResults.append(head);

  let lastPath = "";
  for (const hit of hits) {
    if (hit.path !== lastPath) {
      lastPath = hit.path;
      const fileRow = document.createElement("button");
      fileRow.type = "button";
      fileRow.className = "tree-search-file";
      fileRow.title = hit.path;
      fileRow.textContent = hit.name;
      fileRow.addEventListener("click", () => void openContentHit(hit));
      searchResults.append(fileRow);
    }

    const row = document.createElement("button");
    row.type = "button";
    row.className = "tree-search-hit";
    row.title = `${hit.path}:${hit.line}`;

    const lineNo = document.createElement("span");
    lineNo.className = "tree-search-line";
    lineNo.textContent = String(hit.line);

    const text = document.createElement("span");
    text.className = "tree-search-text";
    text.textContent = hit.text || "（空行）";

    row.append(lineNo, text);
    row.addEventListener("click", () => void openContentHit(hit));
    searchResults.append(row);
  }
  searchResults.hidden = false;
  fileTreeHost.hidden = true;
}

/** 侧栏命中行：label 用于大文件当前块的「块N」标记，缺省显示行号数字 */
export interface LineSearchHit {
  line: number;
  offset: number;
  text: string;
  label?: string;
}

/** 供大文件浏览复用：把整文件搜索命中渲染到侧栏，点击回调行号与行首偏移 */
export function showLineSearchResults(
  title: string,
  hits: LineSearchHit[],
  onPick: (hit: LineSearchHit) => void,
): void {
  // 外部结果优先，作废侧栏进行中的搜索请求，避免旧结果把它覆盖掉
  searchToken += 1;
  if (hits.length === 0) {
    renderSearchEmpty(title);
    expandSidebar();
    return;
  }
  searchResults.replaceChildren();
  const head = document.createElement("div");
  head.className = "tree-search-count";
  head.textContent = title;
  searchResults.append(head);

  for (const hit of hits) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "tree-search-hit";
    row.title = `第 ${hit.line} 行`;

    const lineNo = document.createElement("span");
    lineNo.className = "tree-search-line";
    lineNo.textContent = hit.label ?? String(hit.line);

    const text = document.createElement("span");
    text.className = "tree-search-text";
    text.textContent = hit.text || "（空行）";

    row.append(lineNo, text);
    row.addEventListener("click", () => onPick(hit));
    searchResults.append(row);
  }
  searchResults.hidden = false;
  fileTreeHost.hidden = true;
  expandSidebar();
}

/** 打开命中文件并跳到对应行；全文搜索结果保留，方便连续查看多处命中 */
async function openContentHit(hit: ContentHit): Promise<void> {
  await openPath(hit.path);
  // 预览型/二进制标签先切回编辑模式，否则跳行后看不到光标
  if (!ensureEditMode()) return;
  app.editor.gotoLine(hit.line);
  app.tree.markActive(hit.path);
}

function scheduleSearch(): void {
  if (searchTimer !== undefined) window.clearTimeout(searchTimer);
  if (!searchInput.value.trim()) {
    resetSearch();
    return;
  }
  searchTimer = window.setTimeout(() => {
    searchTimer = undefined;
    void runSearch();
  }, 250);
}

/** 切换模式后旧结果不再适用：清空并按当前关键字重搜 */
function switchMode(next: SearchMode): void {
  if (mode === next) return;
  mode = next;
  syncSearchMode();
  const keyword = searchInput.value.trim();
  searchToken += 1;
  searchResults.replaceChildren();
  searchResults.hidden = true;
  fileTreeHost.hidden = false;
  if (keyword) void runSearch();
}

modeButton.addEventListener("click", () =>
  switchMode(mode === "name" ? "content" : "name"),
);
caseButton.addEventListener("click", () => {
  caseSensitive = !caseSensitive;
  syncSearchMode();
  if (searchInput.value.trim()) void runSearch();
});
regexButton.addEventListener("click", () => {
  useRegex = !useRegex;
  syncSearchMode();
  if (searchInput.value.trim()) void runSearch();
});
searchInput.addEventListener("input", scheduleSearch);
depthSelect.addEventListener("change", () => {
  if (searchInput.value.trim()) void runSearch();
});
searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    resetSearch();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    searchResults
      .querySelector<HTMLButtonElement>(".tree-search-hit, .tree-search-row")
      ?.click();
  }
});

syncSearchMode();

/** Ctrl+Shift+H：打开侧栏并聚焦全文搜索 */
export function focusContentSearch(): void {
  if (!app.tree.currentRoot) {
    showTransientStatus("请先打开文件夹，再进行全文搜索");
    return;
  }
  expandSidebar();
  if (mode !== "content") switchMode("content");
  searchInput.focus();
  searchInput.select();
}

/** 展开侧栏并刷新面包屑（打开文件夹、切换工作区时用） */
export function expandSidebar(): void {
  treeCollapsed = false;
  syncSidebar();
}

/** 只收起侧栏、保留工作区，随时可通过标签栏的 ☰ 或 Ctrl+Shift+E 唤回 */
export function collapseSidebar(): void {
  treeCollapsed = true;
  syncSidebar();
}

/** 侧栏只在打开文件夹后显示，顶部面包屑展示当前根的路径 */
export function syncSidebar(): void {
  const { tree } = app;
  const root = tree.currentRoot;
  // 工作区切换后，上一次的搜索结果已经没有意义
  if (root !== lastSearchRoot) {
    lastSearchRoot = root;
    resetSearch();
  }
  const visible = root !== null && !treeCollapsed;
  sidebar.hidden = !visible;
  // 拖动条与侧栏同进同退，放在 JS 里控制避免依赖 DOM 相邻顺序
  sidebarResizer.hidden = !visible;
  renderCrumbs();
}

function renderCrumbs(): void {
  const { tree } = app;
  const root = tree.currentRoot;
  rootCrumbs.replaceChildren();
  rootUpButton.disabled = true;
  if (!root) return;

  const parts = splitPath(root);
  parts.forEach((part, index) => {
    if (index > 0) {
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.textContent = "›";
      rootCrumbs.appendChild(sep);
    }
    const crumb = document.createElement("button");
    crumb.className = "crumb";
    crumb.textContent = part.label;
    crumb.title = part.path;
    if (index === parts.length - 1) {
      crumb.classList.add("current");
    } else {
      crumb.addEventListener("click", () => void changeRoot(part.path));
    }
    rootCrumbs.appendChild(crumb);
  });
  rootUpButton.disabled = parts.length <= 1;
}

/** 切换工作区根：保留当前文件定位，往上走时不会丢失位置 */
export async function changeRoot(path: string): Promise<void> {
  const { tree, store } = app;
  if (normalizePath(path) === normalizePath(tree.currentRoot ?? "")) return;
  const activePath = store.active?.path ?? "";
  if (!(await tree.setRoot(path))) return;
  expandSidebar();
  // 文件仍在新的根之下时会自动展开到它，相当于「记住我刚才在哪」
  if (activePath) tree.markActive(activePath);
}

/** ↑ 按钮：切到当前根目录的上一级 */
export function goUpOneLevel(): void {
  const { tree } = app;
  const root = tree.currentRoot;
  if (!root) return;
  const parts = splitPath(root);
  if (parts.length <= 1) return;
  void changeRoot(parts[parts.length - 2].path);
}

/** 标签栏的文件树按钮：没打开文件夹时直接选目录，否则显示/收起侧栏 */
export async function toggleTree(): Promise<void> {
  const { tree } = app;
  if (!tree.currentRoot) {
    await deps.openFolder();
    return;
  }
  treeCollapsed = !treeCollapsed;
  syncSidebar();
}
