import type { TabStore, Tab } from "./tabs";

const tabbar = document.getElementById("tabs") as HTMLDivElement;

interface TabDragState {
  id: string;
  startX: number;
  startY: number;
  active: boolean;
  targetId: string | null;
  after: boolean;
}

let store: TabStore | null = null;
/** 重排完成后由 main.ts 负责重绘标签栏并落盘会话 */
let afterReorder: (() => void) | null = null;
let tabDrag: TabDragState | null = null;

export function initTabDrag(deps: {
  store: TabStore;
  afterReorder: () => void;
}): void {
  store = deps.store;
  afterReorder = deps.afterReorder;
}

function clearTabDropMarks(): void {
  for (const item of tabbar.querySelectorAll(".tab")) {
    item.classList.remove("drop-left", "drop-right");
  }
}

function reorderTabs(fromId: string, toId: string, after: boolean): boolean {
  if (!store) return false;
  const from = store.tabs.findIndex((tab) => tab.id === fromId);
  const to = store.tabs.findIndex((tab) => tab.id === toId);
  if (from < 0 || to < 0 || from === to) return false;
  const [moved] = store.tabs.splice(from, 1);
  let insert = store.tabs.findIndex((tab) => tab.id === toId);
  if (after) insert += 1;
  store.tabs.splice(insert, 0, moved);
  afterReorder?.();
  return true;
}

function tabElement(id: string): HTMLDivElement | null {
  return tabbar.querySelector<HTMLDivElement>(`.tab[data-tab-id="${id}"]`);
}

function updateDropIndicator(clientX: number): void {
  if (!tabDrag) return;
  const items = Array.from(tabbar.querySelectorAll<HTMLDivElement>(".tab"));
  clearTabDropMarks();
  tabDrag.targetId = null;

  for (const item of items) {
    const id = item.dataset.tabId;
    if (!id) continue;
    const rect = item.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) {
      tabDrag.targetId = id;
      tabDrag.after = false;
      item.classList.add("drop-left");
      return;
    }
    tabDrag.targetId = id;
    tabDrag.after = true;
  }

  const last = items[items.length - 1];
  if (last) last.classList.add("drop-right");
}

function finishTabDrag(): void {
  if (!tabDrag) return;
  const active = tabDrag.active;
  const from = tabDrag.id;
  const targetId = tabDrag.targetId;
  const after = tabDrag.after;

  const dragging = tabElement(from);
  dragging?.classList.remove("dragging");
  clearTabDropMarks();
  document.body.classList.remove("tab-dragging");
  tabDrag = null;

  if (active && targetId) reorderTabs(from, targetId, after);
}

export function bindTabDrag(item: HTMLDivElement, tab: Tab): void {
  item.draggable = false;
  item.dataset.tabId = tab.id;

  item.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".tab-close")) return;
    tabDrag = {
      id: tab.id,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      targetId: null,
      after: false,
    };
  });
}

export function bindTabDragGlobal(): void {
  window.addEventListener("pointermove", (event) => {
    if (!tabDrag) return;
    if (!tabDrag.active) {
      const distance = Math.hypot(
        event.clientX - tabDrag.startX,
        event.clientY - tabDrag.startY,
      );
      if (distance < 4) return;
      tabDrag.active = true;
      document.body.classList.add("tab-dragging");
      tabElement(tabDrag.id)?.classList.add("dragging");
    }

    event.preventDefault();
    updateDropIndicator(event.clientX);
  });

  window.addEventListener("pointerup", () => {
    finishTabDrag();
  });

  window.addEventListener("pointercancel", () => {
    if (!tabDrag) return;
    tabDrag.active = false;
    finishTabDrag();
  });
}
