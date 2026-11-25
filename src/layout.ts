/** 侧栏 / 预览目录 / 终端 / 插件面板四个可拖动尺寸：状态记在本地，尺寸写到 CSS 变量 */

const sidebarResizer = document.getElementById("sidebar-resizer") as HTMLDivElement;
const previewResizer = document.getElementById("preview-resizer") as HTMLDivElement;
const terminalResizer = document.getElementById("terminal-resizer") as HTMLDivElement;
const pluginResizer = document.getElementById("plugin-resizer") as HTMLDivElement;

// 文件树宽度同样记在本地；非法或缺失时回落到默认值
const sidebarMinWidth = 160;
const sidebarDefaultWidth = 240;
const savedSidebarWidth = Number(localStorage.getItem("fEditor.sidebarWidth"));
let sidebarWidth =
  Number.isFinite(savedSidebarWidth) && savedSidebarWidth >= sidebarMinWidth
    ? savedSidebarWidth
    : sidebarDefaultWidth;
// 预览目录宽度、终端高度与插件面板高度，规则同上
const tocMinWidth = 120;
const terminalMinHeight = 100;
const pluginMinHeight = 160;
let tocWidth = readStoredSize("fEditor.tocWidth", 220, tocMinWidth);
let terminalHeight = readStoredSize("fEditor.terminalHeight", 220, terminalMinHeight);
let pluginHeight = readStoredSize("fEditor.pluginHeight", 340, pluginMinHeight);

/** 读取本地记录的尺寸；缺失或非法时用默认值 */
function readStoredSize(key: string, fallback: number, min: number): number {
  const value = Number(localStorage.getItem(key));
  return Number.isFinite(value) && value >= min ? value : fallback;
}

/** 侧栏宽度写到 CSS 变量，宽度由样式表统一消费 */
export function applySidebarWidth(): void {
  document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
}

export function applyTocWidth(): void {
  document.documentElement.style.setProperty("--toc-width", `${tocWidth}px`);
}

export function applyTerminalHeight(): void {
  document.documentElement.style.setProperty("--terminal-height", `${terminalHeight}px`);
}

export function applyPluginHeight(): void {
  document.documentElement.style.setProperty("--plugin-height", `${pluginHeight}px`);
}

/** 插件打开时用它声明的高度；只是本次会话的建议值，拖动后仍以拖动结果为准 */
export function setPluginHeight(height: number): void {
  // 窗口很矮时不能让面板把编辑区挤没
  const max = Math.max(pluginMinHeight, window.innerHeight - 240);
  pluginHeight = Math.min(max, Math.max(pluginMinHeight, Math.round(height)));
  applyPluginHeight();
}

/**
 * 通用分隔条拖动：pointer capture 保证鼠标移出细条也能继续跟手，松手自动解绑。
 * 三个尺寸都只在拖动过程中改变量并同步 CSS 变量，松手才落盘 localStorage。
 */
function bindDragResizer(
  handle: HTMLElement,
  axis: "x" | "y",
  onStart: () => void,
  onDrag: (delta: number) => void,
  onEnd: () => void,
): void {
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing", axis === "x" ? "resizing-x" : "resizing-y");
    const start = axis === "x" ? event.clientX : event.clientY;
    onStart();

    const onMove = (moveEvent: PointerEvent): void => {
      onDrag((axis === "x" ? moveEvent.clientX : moveEvent.clientY) - start);
    };
    const finish = (): void => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      document.body.classList.remove("resizing", "resizing-x", "resizing-y");
      onEnd();
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  });
}

/** 文件树在右侧：拖动条往左移才是变宽，位移取反 */
export function bindSidebarResizer(): void {
  let startWidth = sidebarWidth;
  bindDragResizer(
    sidebarResizer,
    "x",
    () => {
      startWidth = sidebarWidth;
    },
    (delta) => {
      const max = Math.max(sidebarMinWidth, window.innerWidth - 420);
      sidebarWidth = Math.min(max, Math.max(sidebarMinWidth, startWidth - delta));
      applySidebarWidth();
    },
    () => localStorage.setItem("fEditor.sidebarWidth", String(Math.round(sidebarWidth))),
  );
}

/** 目录在左侧：往右拖变宽，位移为正 */
export function bindPreviewResizer(): void {
  let startWidth = tocWidth;
  bindDragResizer(
    previewResizer,
    "x",
    () => {
      startWidth = tocWidth;
    },
    (delta) => {
      // 目录在左侧：往右拖变宽，位移为正
      const max = Math.max(tocMinWidth, window.innerWidth - 520);
      tocWidth = Math.min(max, Math.max(tocMinWidth, startWidth + delta));
      applyTocWidth();
    },
    () => localStorage.setItem("fEditor.tocWidth", String(Math.round(tocWidth))),
  );
}

/** 终端在分隔条下方：往上拖变高，位移取反 */
export function bindTerminalResizer(): void {
  let startHeight = terminalHeight;
  bindDragResizer(
    terminalResizer,
    "y",
    () => {
      startHeight = terminalHeight;
    },
    (delta) => {
      const max = Math.max(terminalMinHeight, window.innerHeight - 240);
      terminalHeight = Math.min(max, Math.max(terminalMinHeight, startHeight - delta));
      applyTerminalHeight();
    },
    () => localStorage.setItem("fEditor.terminalHeight", String(Math.round(terminalHeight))),
  );
}

/** 插件面板同样贴在编辑区底部：往上拖变高，位移取反 */
export function bindPluginResizer(): void {
  applyPluginHeight();
  let startHeight = pluginHeight;
  bindDragResizer(
    pluginResizer,
    "y",
    () => {
      startHeight = pluginHeight;
    },
    (delta) => {
      const max = Math.max(pluginMinHeight, window.innerHeight - 240);
      pluginHeight = Math.min(max, Math.max(pluginMinHeight, startHeight - delta));
      applyPluginHeight();
    },
    () => localStorage.setItem("fEditor.pluginHeight", String(Math.round(pluginHeight))),
  );
}
