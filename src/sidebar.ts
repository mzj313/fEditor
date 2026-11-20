import { app } from "./app-context";
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
