import { invoke } from "@tauri-apps/api/core";
import { normalizePath } from "./tabs";

export interface TreeEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
}

interface RootInfo {
  path: string;
  name: string;
}

/** 单击复用当前标签，双击新开标签 */
export type OpenMode = "reuse" | "newTab";

export interface TreeOptions {
  /** 打开文件时回调，由主界面决定复用哪个标签 */
  onOpenFile: (path: string, mode: OpenMode) => void;
  /** 右键节点时回调；空白处右键传 null，由主界面决定菜单内容 */
  onContextMenu: (entry: TreeEntry | null, event: MouseEvent) => void;
  /** 双击目录时回调，把该目录提升为工作区根 */
  onSetRoot: (path: string) => void;
  /** 根目录或展开状态变化时通知主界面保存会话 */
  onStateChange: () => void;
  onError: (message: string) => void;
}

/**
 * 目录树：只负责渲染与懒加载，标签切换、脏文件确认都交给主界面。
 * 展开集合与根目录暴露给主界面，用于写入会话。
 */
export class FileTree {
  private host: HTMLElement;
  private options: TreeOptions;
  private root: string | null = null;
  private rootName = "";
  private expanded = new Set<string>();
  private loading = new Set<string>();
  private cache = new Map<string, TreeEntry[]>();
  private activePath = "";
  /** 键盘当前所在行；每次渲染后按路径重新定位 */
  private focusPath = "";
  /** 当前显示顺序（含层级），键盘上下移动只在这份列表里走 */
  private visibleRows: Array<{ entry: TreeEntry; depth: number }> = [];
  private rowByPath = new Map<string, HTMLElement>();
  private focusedRow: HTMLElement | null = null;

  constructor(host: HTMLElement, options: TreeOptions) {
    this.host = host;
    this.options = options;

    // 空白区域右键：菜单作用于当前根目录
    this.host.addEventListener("contextmenu", (event) => {
      if ((event.target as HTMLElement).closest(".tree-row")) return;
      event.preventDefault();
      this.options.onContextMenu(null, event);
    });

    // 宿主本身 tabindex=0，焦点在树里时接管方向键，鼠标点击会自动聚焦
    this.host.addEventListener("keydown", (event) => this.handleKeydown(event));
  }

  get currentRoot(): string | null {
    return this.root;
  }

  get currentRootName(): string {
    return this.rootName;
  }

  get expandedDirs(): string[] {
    return Array.from(this.expanded);
  }

  /** 打开文件夹；silent 用于会话恢复，目录已不存在时不弹窗打扰用户 */
  async setRoot(path: string, silent = false): Promise<boolean> {
    try {
      const info = await invoke<RootInfo>("set_root", { path });
      this.root = info.path;
      this.rootName = info.name;
      this.expanded.clear();
      this.cache.clear();
      this.activePath = "";
      this.focusPath = "";
      await this.loadDir(info.path);
      this.render();
      this.options.onStateChange();
      return true;
    } catch (error) {
      if (!silent) this.options.onError(`无法打开文件夹：\n${path}\n\n${error}`);
      return false;
    }
  }

  /** 恢复上次会话里展开过的目录，并发的读目录后只渲染一次 */
  async restoreExpanded(paths: string[]): Promise<void> {
    if (!this.root || paths.length === 0) return;
    const rootPrefix = normalizePath(this.root);
    for (const path of paths) {
      // 根目录在会话之间可能被移动，只恢复仍在当前根目录内的路径
      if (normalizePath(path).startsWith(rootPrefix)) this.expanded.add(path);
    }
    // 目录之间互不依赖，并发加载后再统一渲染，避免启动时逐个目录串行等待
    await Promise.all(Array.from(this.expanded).map((dir) => this.loadDir(dir)));
    this.render();
  }

  /** 重新读取根目录与已展开目录，用于外部新增/删除文件后手动刷新 */
  async refresh(): Promise<void> {
    const root = this.root;
    if (!root) return;
    this.cache.clear();
    // 已展开目录可能已在外部被删除，只刷新仍存在的，避免逐个弹错误框
    const dirs = [root, ...this.expanded];
    const alive = await Promise.all(
      dirs.map(async (dir) => {
        const exists = await invoke<boolean>("path_exists", { path: dir }).catch(() => false);
        return exists ? dir : null;
      }),
    );
    this.expanded = new Set(
      alive.filter((dir): dir is string => dir !== null && dir !== root),
    );
    await Promise.all(alive.filter((dir): dir is string => dir !== null).map((dir) => this.loadDir(dir)));
    this.render();
  }

  /** 高亮当前文件并自动展开它的父目录 */
  markActive(path: string): void {
    this.activePath = path;
    void this.reveal(path);
  }

  /** 搜索起点：当前文件所在目录；没有打开文件时退回工作区根 */
  get searchBase(): string | null {
    if (!this.root) return null;
    if (this.activePath) {
      const cut = Math.max(
        this.activePath.lastIndexOf("/"),
        this.activePath.lastIndexOf("\\"),
      );
      if (cut > 0) return this.activePath.slice(0, cut);
    }
    return this.root;
  }

  private async loadDir(path: string): Promise<TreeEntry[]> {
    const cached = this.cache.get(path);
    if (cached) return cached;
    if (this.loading.has(path)) return [];

    this.loading.add(path);
    try {
      const entries = await invoke<TreeEntry[]>("read_tree", { path });
      this.cache.set(path, entries);
      return entries;
    } catch (error) {
      this.cache.set(path, []);
      this.options.onError(`读取目录失败：\n${path}\n\n${error}`);
      return [];
    } finally {
      this.loading.delete(path);
    }
  }

  private async toggleDir(path: string): Promise<void> {
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
    } else {
      this.expanded.add(path);
      await this.loadDir(path);
    }
    this.render();
    this.options.onStateChange();
  }

  private async reveal(path: string): Promise<void> {
    const root = this.root;
    if (!root) return;
    const rootTrim = root.replace(/\/+$/, "");
    if (!path.startsWith(rootTrim)) return;

    const segments = path.slice(rootTrim.length).replace(/^\/+/, "").split("/");
    if (segments.length <= 1) {
      this.render();
      return;
    }

    let current = rootTrim;
    let changed = false;
    for (const segment of segments.slice(0, -1)) {
      current = `${current}/${segment}`;
      if (!this.expanded.has(current)) {
        this.expanded.add(current);
        changed = true;
      }
      await this.loadDir(current);
    }
    this.render();
    // 展开状态没变化时不必再写一次会话，避免每次切标签都触发保存
    if (changed) this.options.onStateChange();
  }

  /** 展开全部（限制层级与目录数，避免在超大目录里长时间扫描） */
  async expandAll(maxDepth = 3, maxDirs = 200): Promise<void> {
    const root = this.root;
    if (!root) return;
    const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
    let loaded = 0;
    while (queue.length > 0 && loaded < maxDirs) {
      const item = queue.shift() as { path: string; depth: number };
      const entries = await this.loadDir(item.path);
      loaded += 1;
      // 达到层数上限就不再往下走，只保留已读到的这一层
      if (item.depth >= maxDepth) continue;
      for (const entry of entries) {
        if (!entry.isDir) continue;
        this.expanded.add(entry.path);
        queue.push({ path: entry.path, depth: item.depth + 1 });
      }
    }
    this.render();
    this.options.onStateChange();
  }

  /** 折叠全部：只保留根目录这一层 */
  collapseAll(): void {
    if (this.expanded.size === 0) return;
    this.expanded.clear();
    this.render();
    this.options.onStateChange();
  }

  /** 键盘位置与高亮；不在可见列表里的行（被折叠）不会显示出来 */
  private setFocus(path: string): void {
    this.focusPath = path;
    this.applyFocusClass();
    this.rowByPath.get(path)?.scrollIntoView({ block: "nearest" });
  }

  private applyFocusClass(): void {
    this.focusedRow?.classList.remove("focused");
    this.focusedRow = this.rowByPath.get(this.focusPath) ?? null;
    this.focusedRow?.classList.add("focused");
  }

  private moveFocusTo(index: number): void {
    if (this.visibleRows.length === 0) return;
    const clamped = Math.max(0, Math.min(this.visibleRows.length - 1, index));
    this.setFocus(this.visibleRows[clamped].entry.path);
  }

  /** 方向键在可见行里移动，Enter 打开文件或展开目录 */
  private handleKeydown(event: KeyboardEvent): void {
    if (this.visibleRows.length === 0) return;
    const index = this.visibleRows.findIndex((item) => item.entry.path === this.focusPath);
    const current = index >= 0 ? this.visibleRows[index] : null;

    switch (event.key) {
      case "ArrowDown":
        this.moveFocusTo(index < 0 ? 0 : index + 1);
        break;
      case "ArrowUp":
        this.moveFocusTo(index < 0 ? 0 : index - 1);
        break;
      case "Home":
        this.moveFocusTo(0);
        break;
      case "End":
        this.moveFocusTo(this.visibleRows.length - 1);
        break;
      case "ArrowRight":
        if (!current?.entry.isDir) return;
        if (!this.expanded.has(current.entry.path)) {
          void this.toggleDir(current.entry.path);
        } else {
          // 已展开：进入第一个子项
          this.moveFocusTo(index + 1);
        }
        break;
      case "ArrowLeft": {
        if (!current) return;
        if (current.entry.isDir && this.expanded.has(current.entry.path)) {
          void this.toggleDir(current.entry.path);
          break;
        }
        // 折叠的目录或文件行：回到父目录所在行
        const parent = parentOf(current.entry.path);
        const parentIndex = this.visibleRows.findIndex((item) => item.entry.path === parent);
        if (parentIndex >= 0) this.moveFocusTo(parentIndex);
        break;
      }
      case "Enter":
        if (!current) return;
        if (current.entry.isDir) void this.toggleDir(current.entry.path);
        else this.options.onOpenFile(current.entry.path, "reuse");
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  private render(): void {
    this.visibleRows = [];
    this.rowByPath.clear();
    this.focusedRow = null;
    if (!this.root) {
      this.host.replaceChildren();
      return;
    }
    const fragment = document.createDocumentFragment();
    this.appendChildren(fragment, this.root, 0);
    this.host.replaceChildren(fragment);
    this.applyFocusClass();
  }

  private appendChildren(container: Node, dirPath: string, depth: number): void {
    const entries = this.cache.get(dirPath);
    if (!entries) return;
    for (const entry of entries) {
      container.appendChild(this.buildRow(entry, depth));
      if (entry.isDir && this.expanded.has(entry.path)) {
        this.appendChildren(container, entry.path, depth + 1);
      }
    }
  }

  private buildRow(entry: TreeEntry, depth: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "tree-row";
    row.title = entry.path;
    row.style.paddingLeft = `${6 + depth * 12}px`;
    if (entry.isDir) row.classList.add("dir");
    if (!entry.isDir && normalizePath(entry.path) === normalizePath(this.activePath)) {
      row.classList.add("active");
    }
    // 记录显示顺序与 DOM 映射，键盘导航与高亮都依赖这两份数据
    this.visibleRows.push({ entry, depth });
    this.rowByPath.set(entry.path, row);

    const twisty = document.createElement("span");
    twisty.className = "tree-twisty";
    // 目录用三角提示展开状态，文件位留空以保持列对齐
    if (entry.isDir) twisty.textContent = this.expanded.has(entry.path) ? "▾" : "▸";
    row.appendChild(twisty);

    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = entry.name;
    row.appendChild(name);

    // 右键交给主界面弹自定义菜单，屏蔽 WebView 默认菜单
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.options.onContextMenu(entry, event);
    });

    if (entry.isDir) {
      row.addEventListener("click", () => {
        this.setFocus(entry.path);
        void this.toggleDir(entry.path);
      });
      // 双击目录把它提升为工作区根，方便在上层/下层目录之间跳转
      row.addEventListener("dblclick", () => this.options.onSetRoot(entry.path));
      return row;
    }

    // 单击只挪焦点，不打开文件：避免浏览时误触把当前标签覆盖掉。
    // 打开或切换文件统一用双击。
    row.addEventListener("click", () => {
      this.setFocus(entry.path);
    });
    row.addEventListener("dblclick", () => {
      this.options.onOpenFile(entry.path, "reuse");
    });
    return row;
  }
}

/** 取出父目录；保留原路径的分隔符风格，与树里存的路径字符串保持一致 */
function parentOf(path: string): string {
  const match = /[\\/][^\\/]+$/.exec(path);
  if (!match) return path;
  const parent = path.slice(0, match.index);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}
