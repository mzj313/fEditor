export type MenuEntry =
  | { type: "item"; label: string; action: () => void }
  | { type: "separator" }
  | { type: "submenu"; label: string; entries: MenuEntry[] };

let active: HTMLDivElement | null = null;
let submenu: HTMLDivElement | null = null;

export function closeContextMenu(): void {
  submenu?.remove();
  submenu = null;
  active?.remove();
  active = null;
}

function closeSubmenu(): void {
  submenu?.remove();
  submenu = null;
}

/**
 * 构建一层菜单；子菜单项在悬停时再展开。
 * isRoot 用来区分层级：只有根菜单的项会在悬停时收起子菜单，
 * 否则子菜单自己弹到光标下面时，它内部第一项的 mouseenter 会立刻把自己关掉。
 */
function createMenu(entries: MenuEntry[], isRoot: boolean): HTMLDivElement {
  const menu = document.createElement("div");
  menu.className = "ctx-menu";

  for (const entry of entries) {
    if (entry.type === "separator") {
      const line = document.createElement("div");
      line.className = "ctx-separator";
      menu.appendChild(line);
      continue;
    }

    const item = document.createElement("button");
    item.className = "ctx-item";
    item.textContent = entry.label;

    if (entry.type === "item") {
      if (isRoot) item.addEventListener("mouseenter", closeSubmenu);
      item.addEventListener("click", () => {
        closeContextMenu();
        entry.action();
      });
    } else {
      // 子菜单：悬停或点击都展开，向左翻转由 openSubmenu 决定
      item.classList.add("has-submenu");
      item.addEventListener("mouseenter", () => openSubmenu(entry.entries, item));
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        openSubmenu(entry.entries, item);
      });
    }

    menu.appendChild(item);
  }

  return menu;
}

function openSubmenu(entries: MenuEntry[], anchor: HTMLElement): void {
  closeSubmenu();
  const menu = createMenu(entries, false);
  menu.classList.add("ctx-submenu");
  document.body.appendChild(menu);

  const anchorRect = anchor.getBoundingClientRect();
  const rect = menu.getBoundingClientRect();
  // 与父项重叠几个像素，鼠标横向移动时不会经过空隙而丢失
  let left = anchorRect.right - 4;
  // 右侧空间不足时改为向左展开
  if (left + rect.width > window.innerWidth - 4) {
    left = Math.max(4, anchorRect.left - rect.width + 4);
  }
  let top = anchorRect.top - 4;
  if (top + rect.height > window.innerHeight - 4) {
    top = Math.max(4, window.innerHeight - rect.height - 4);
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  submenu = menu;
}

/** 在鼠标位置弹出右键菜单，超出窗口边界时自动翻转 */
export function showContextMenu(x: number, y: number, entries: MenuEntry[]): void {
  closeContextMenu();
  if (entries.length === 0) return;

  const menu = createMenu(entries, true);
  menu.style.left = "0px";
  menu.style.top = "0px";
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  active = menu;

  const dismiss = () => {
    closeContextMenu();
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("blur", dismiss);
  };
  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as Node;
    // 子菜单是独立节点，必须一起判断，否则点它会被当成"点击外部"而先被移除
    if (menu.contains(target) || submenu?.contains(target)) return;
    dismiss();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") dismiss();
  };

  // 延后一帧绑定，否则本次 contextmenu 之后紧跟的 pointerdown 会立刻关掉菜单
  requestAnimationFrame(() => {
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", dismiss);
  });
}
