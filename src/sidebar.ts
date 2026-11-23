import { invoke } from "@tauri-apps/api/core";
import { app } from "./app-context";
import { openPath } from "./file-open";
import { splitPath } from "./paths";
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

/* ---- 文件名搜索 ---- */

interface SearchHit {
  path: string;
  name: string;
  depth: number;
}

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

const searchInput = document.createElement("input");
searchInput.className = "tree-search-input";
searchInput.type = "search";
searchInput.placeholder = "搜索文件名";

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

const searchResults = document.createElement("div");
searchResults.className = "tree-search-results";
searchResults.hidden = true;

searchWrap.append(searchInput, depthSelect);
sidebar.insertBefore(searchWrap, fileTreeHost);
sidebar.insertBefore(searchResults, fileTreeHost);

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
  const base = app.tree.searchBase;
  const keyword = searchInput.value.trim();
  if (!base || !keyword) return;
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
    searchResults.querySelector<HTMLButtonElement>(".tree-search-row")?.click();
  }
});

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
