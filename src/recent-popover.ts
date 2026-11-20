import { basename } from "./tabs";
import { clearRecent, getRecent, removeRecent } from "./session-state";
import { openRecentEntry } from "./file-open";
import { showTransientStatus } from "./statusbar";

let panel: HTMLDivElement | null = null;

/** 「最近」面板锚定在窗口左上角、菜单栏下方，与原生菜单展开位置接近 */
const POPOVER_LEFT = 8;
const POPOVER_TOP = 40;

/** 最后一段目录名，用于「文件名（所在目录）」的副标题 */
function parentName(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.length >= 2 ? segments[segments.length - 2] : "";
}

/** 同步推断图标：末段带扩展名点号的按文件处理，否则视为文件夹 */
function isLikelyDir(path: string): boolean {
  const name = basename(path);
  return !name.includes(".");
}

/**
 * 「文件 → 最近…」的网页下拉面板。
 * 原生菜单项只是文本标签，做不了悬停删除按钮，所以最近记录改由 WebView 渲染：
 * 悬停行尾出现 ×，可删除单条；底部提供清空按钮。
 */
export function showRecentPopover(): void {
  closeRecentPopover();
  const entries = getRecent();

  panel = document.createElement("div");
  // 局部别名：TS 无法跟踪模块级变量在异步回调间不会被置空
  const root = panel;
  root.className = "recent-popover";
  root.style.left = `${POPOVER_LEFT}px`;
  root.style.top = `${POPOVER_TOP}px`;

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "recent-empty";
    empty.textContent = "（暂无记录）";
    root.appendChild(empty);
  }

  entries.forEach((path, index) => {
    const row = document.createElement("div");
    row.className = "recent-row";

    const main = document.createElement("div");
    main.className = "recent-main";
    const icon = document.createElement("span");
    icon.className = "recent-icon";
    icon.textContent = isLikelyDir(path) ? "📁" : "📄";
    const name = document.createElement("span");
    name.className = "recent-name";
    name.textContent = basename(path);
    main.append(icon, name);
    const dir = parentName(path);
    if (dir) {
      const dirLabel = document.createElement("span");
      dirLabel.className = "recent-dir";
      dirLabel.textContent = `（${dir}）`;
      main.appendChild(dirLabel);
    }
    main.title = path;
    main.addEventListener("click", () => {
      closeRecentPopover();
      void openRecentEntry(path);
    });
    row.appendChild(main);

    const remove = document.createElement("button");
    remove.className = "recent-remove";
    remove.textContent = "×";
    remove.title = "删除这条记录";
    remove.addEventListener("click", (event) => {
      // 阻止冒泡，避免删除的同时触发行的打开动作
      event.stopPropagation();
      removeRecent(index);
      if (getRecent().length === 0) {
        showRecentPopover();
      } else {
        row.remove();
      }
      showTransientStatus("已删除该条最近记录");
    });
    row.appendChild(remove);

    root.appendChild(row);
  });

  if (entries.length > 0) {
    const footer = document.createElement("div");
    footer.className = "recent-footer";
    const clear = document.createElement("button");
    clear.className = "recent-clear";
    clear.textContent = "清空最近记录";
    clear.addEventListener("click", () => {
      clearRecent();
      showRecentPopover();
    });
    footer.appendChild(clear);
    root.appendChild(footer);
  }

  document.body.appendChild(root);
  // 点击面板外部或按 Esc 关闭；下一次 show 前要先解绑，避免监听器堆积
  const onOutside = (event: MouseEvent): void => {
    if (root.isConnected && !root.contains(event.target as Node)) closeRecentPopover();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") closeRecentPopover();
  };
  window.setTimeout(() => {
    window.addEventListener("mousedown", onOutside);
    window.addEventListener("keydown", onKey);
  }, 0);
  cleanupOutside = () => {
    window.removeEventListener("mousedown", onOutside);
    window.removeEventListener("keydown", onKey);
  };
}

let cleanupOutside: (() => void) | null = null;

export function closeRecentPopover(): void {
  cleanupOutside?.();
  cleanupOutside = null;
  panel?.remove();
  panel = null;
}
