import type { Window } from "@tauri-apps/api/window";
import { showContextMenu } from "./context-menu";
import type { EditorController } from "./editor";
import { changeFontSize, getFontSize, onFontSizeChange, resetFontSize } from "./font-size";
import { formatBytes, languageOf, type TabStore } from "./tabs";

const stPos = document.getElementById("st-pos") as HTMLSpanElement;
const stCount = document.getElementById("st-count") as HTMLSpanElement;
const stEncoding = document.getElementById("st-encoding") as HTMLSpanElement;
const stEol = document.getElementById("st-eol") as HTMLSpanElement;
const stLang = document.getElementById("st-lang") as HTMLSpanElement;
const stCursors = document.getElementById("st-cursors") as HTMLSpanElement;
const stFont = document.getElementById("st-font") as HTMLSpanElement;
const stState = document.getElementById("st-state") as HTMLSpanElement;

let store: TabStore | null = null;
let editor: EditorController | null = null;
let appWindow: Window | null = null;
let lastWindowTitle = "";

/** 依赖在 main.ts 里创建完成后注入，避免模块间循环 import */
export function initStatusBar(deps: {
  store: TabStore;
  editor: EditorController;
  appWindow: Window;
}): void {
  store = deps.store;
  editor = deps.editor;
  appWindow = deps.appWindow;

  // 字号指示器：滚轮上下调节、单击恢复默认，改动实时反映到编辑器与预览
  const renderFont = () => {
    stFont.textContent = `${getFontSize()}px`;
  };
  renderFont();
  onFontSizeChange(renderFont);
  stFont.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      changeFontSize(event.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );
  stFont.addEventListener("click", () => resetFontSize());

  // 编码 / 换行做成可点击项：具体动作交给 tab-encoding 模块，这里只负责弹菜单
  const dispatch = (name: string, detail?: string) =>
    window.dispatchEvent(new CustomEvent(name, { detail }));

  stEncoding.title = "点击切换编码（按新编码重新读取文件）";
  stEol.title = "点击切换换行风格（保存时生效）";
  stEncoding.classList.add("status-clickable");
  stEol.classList.add("status-clickable");

  stEncoding.addEventListener("click", (event) => {
    const tab = store?.active;
    if (!tab || tab.binary || !tab.path) return;
    const tick = (value: string) => (tab.encoding === value ? " ✓" : "");
    showContextMenu(event.clientX, event.clientY, [
      {
        type: "item",
        label: `UTF-8${tick("UTF-8")}`,
        action: () => dispatch("set-tab-encoding", "UTF-8"),
      },
      {
        type: "item",
        label: `GBK${tick("GBK")}`,
        action: () => dispatch("set-tab-encoding", "GBK"),
      },
      {
        type: "item",
        label: `GB18030${tick("GB18030")}`,
        action: () => dispatch("set-tab-encoding", "GB18030"),
      },
      { type: "separator" },
      {
        type: "item",
        label: tab.hasBom ? "移除 UTF-8 BOM" : "添加 UTF-8 BOM",
        action: () => dispatch("set-tab-bom"),
      },
    ]);
  });

  stEol.addEventListener("click", (event) => {
    const tab = store?.active;
    if (!tab || tab.binary) return;
    const tick = (value: string) => (tab.eol === value ? " ✓" : "");
    showContextMenu(event.clientX, event.clientY, [
      {
        type: "item",
        label: `LF（Unix）${tick("LF")}`,
        action: () => dispatch("set-tab-eol", "LF"),
      },
      {
        type: "item",
        label: `CRLF（Windows）${tick("CRLF")}`,
        action: () => dispatch("set-tab-eol", "CRLF"),
      },
    ]);
  });
}

export function updateStatus(): void {
  if (!store || !editor || !appWindow) return;
  const tab = store.active;
  if (!tab) {
    stPos.textContent = "行 0:0";
    stCount.textContent = "0 字";
    return;
  }
  if (tab.binary) {
    stPos.textContent = "只读";
    stCount.textContent = "—";
    stEncoding.textContent = "—";
    stEol.textContent = "—";
    stLang.textContent = languageOf(tab.title);
    stCursors.textContent = "";
    stState.textContent = tab.binary === "audio" ? "播放" : "预览";
    stState.classList.remove("dirty");
    const binaryTitle = `${tab.title} - fEditor`;
    if (binaryTitle !== lastWindowTitle) {
      lastWindowTitle = binaryTitle;
      void appWindow.setTitle(binaryTitle).catch(() => undefined);
    }
    return;
  }
  // 超大文本只读浏览：只显示文件总大小，行号/字数对分块视图没有意义
  if (tab.large) {
    stPos.textContent = "只读";
    stCount.textContent = formatBytes(tab.large.total);
    stEncoding.textContent = tab.large.encoding;
    stEol.textContent = "—";
    stLang.textContent = "大文件浏览";
    stCursors.textContent = "";
    stState.textContent = "只读";
    stState.classList.remove("dirty");
    const largeTitle = `${tab.title} - fEditor`;
    if (largeTitle !== lastWindowTitle) {
      lastWindowTitle = largeTitle;
      void appWindow.setTitle(largeTitle).catch(() => undefined);
    }
    return;
  }
  const state = editor.state;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  stPos.textContent = `行 ${line.number}:${head - line.from + 1}`;
  stCount.textContent = `${state.doc.length} 字`;
  stEncoding.textContent = tab.encoding;
  stEol.textContent = tab.eol;
  stLang.textContent = languageOf(tab.title);
  const cursors = state.selection.ranges.length;
  stCursors.textContent = cursors > 1 ? `光标 ${cursors}` : "";
  stState.textContent = tab.error ? "文件不存在" : tab.dirty ? "未保存" : "已保存";
  stState.classList.toggle("dirty", tab.dirty);
  const windowTitle = `${tab.dirty ? "*" : ""}${tab.title} - fEditor`;
  if (windowTitle !== lastWindowTitle) {
    lastWindowTitle = windowTitle;
    void appWindow.setTitle(windowTitle).catch(() => undefined);
  }
}

/** 状态栏临时提示：格式化失败等一次性信息用，几秒后自动恢复常规状态显示。 */
let transientStatusTimer: number | undefined;

export function showTransientStatus(message: string): void {
  window.clearTimeout(transientStatusTimer);
  stState.textContent = message;
  stState.classList.remove("dirty");
  transientStatusTimer = window.setTimeout(() => updateStatus(), 4000);
}
