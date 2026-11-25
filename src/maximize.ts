//! 编辑区 / 终端最大化：只用 CSS 类控制显隐，不改动原有尺寸变量，
//! 还原时把其他面板按原状态恢复。两者互斥，避免同时最大化导致整片空白。

import { parkActiveMedia } from "./binary-preview";
import { showTransientStatus } from "./statusbar";

const body = document.getElementById("body") as HTMLDivElement;
const main = document.getElementById("main") as HTMLDivElement;
const editorMaxButton = document.getElementById("editor-max") as HTMLButtonElement;
const terminalMaxButton = document.getElementById("terminal-max") as HTMLButtonElement;
const terminalPanel = document.getElementById("terminal-panel") as HTMLElement;
const terminalHead = document.getElementById("terminal-head") as HTMLElement;
const tabbar = document.getElementById("tabbar") as HTMLElement;

let editorMaximized = false;
let terminalMaximized = false;

function syncButtons(): void {
  editorMaxButton.textContent = editorMaximized ? "⤡" : "⤢";
  editorMaxButton.title = editorMaximized
    ? "还原编辑区（Ctrl+Alt+M）"
    : "最大化编辑区（Ctrl+Alt+M）";
  editorMaxButton.classList.toggle("active", editorMaximized);

  terminalMaxButton.textContent = terminalMaximized ? "⤡" : "⤢";
  terminalMaxButton.title = terminalMaximized ? "还原终端" : "最大化终端（双击标题栏也可切换）";
  terminalMaxButton.classList.toggle("active", terminalMaximized);
}

export function isEditorMaximized(): boolean {
  return editorMaximized;
}

export function exitEditorMaximize(): void {
  if (!editorMaximized) return;
  editorMaximized = false;
  body.classList.remove("editor-maximized");
  syncButtons();
}

export function exitTerminalMaximize(): void {
  if (!terminalMaximized) return;
  terminalMaximized = false;
  main.classList.remove("terminal-maximized");
  syncButtons();
}

export function toggleEditorMaximize(): void {
  if (editorMaximized) {
    exitEditorMaximize();
    showTransientStatus("已还原编辑区");
    return;
  }
  // 终端最大化时编辑区是隐藏的，先退出终端，避免两个类同时生效
  exitTerminalMaximize();
  editorMaximized = true;
  body.classList.add("editor-maximized");
  syncButtons();
  showTransientStatus("编辑区已最大化，Ctrl+Alt+M 还原");
}

export function toggleTerminalMaximize(): void {
  if (terminalMaximized) {
    exitTerminalMaximize();
    return;
  }
  exitEditorMaximize();
  // 预览面板被隐藏时 WebView2 会中断媒体流，先把正在播放的媒体挪到常驻容器
  parkActiveMedia();
  terminalMaximized = true;
  main.classList.add("terminal-maximized");
  syncButtons();
}

export function bindMaximizeControls(): void {
  editorMaxButton.addEventListener("click", toggleEditorMaximize);
  terminalMaxButton.addEventListener("click", (event) => {
    // 避免冒泡到标题栏触发双击逻辑
    event.stopPropagation();
    toggleTerminalMaximize();
  });
  terminalHead.addEventListener("dblclick", (event) => {
    if ((event.target as HTMLElement).closest("button")) return;
    toggleTerminalMaximize();
  });
  // 标签栏空白处双击同样切换编辑区最大化；落在标签或按钮上不响应
  tabbar.addEventListener("dblclick", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest(".tab") || target.closest("button")) return;
    event.preventDefault();
    toggleEditorMaximize();
  });
  // 终端被 × 或进程退出隐藏时，同步退出最大化，避免残留空面板
  new MutationObserver(() => {
    if (terminalPanel.hidden) exitTerminalMaximize();
  }).observe(terminalPanel, { attributes: true, attributeFilter: ["hidden"] });

  syncButtons();
}
