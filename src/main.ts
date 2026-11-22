import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { redo, undo } from "@codemirror/commands";
import { EditorController } from "./editor";
import {
  TabStore,
  basename,
  binaryKindOf,
  createTab,
  isCsv,
  isMarkdown,
  isSvg,
  nextUntitledTitle,
  noteUntitledTitle,
} from "./tabs";
import { flushSession, loadSession, scheduleSessionSave } from "./session";
import { FileTree } from "./file-tree";
import { TerminalPanel } from "./terminal";
import { showContextMenu } from "./context-menu";
import { ask, message } from "./dialogs";
import {
  applySidebarWidth,
  applyTerminalHeight,
  applyTocWidth,
  bindPreviewResizer,
  bindSidebarResizer,
  bindTerminalResizer,
} from "./layout";
import { initFontSize } from "./font-size";
import { initEditorAppearance } from "./settings";
import { finishStartupTiming, markStartup } from "./startup-timing";
import { applyUiScale, bindUiZoom } from "./ui-zoom";
import { initStatusBar, updateStatus, showTransientStatus } from "./statusbar";
import { initToc, syncTocVisibility } from "./toc";
import { bindTabDrag, bindTabDragGlobal, initTabDrag } from "./tab-drag";
import { initGitMenu, showTreeMenu } from "./git-menu";
import { initSessionState, buildSession, setRecent } from "./session-state";
import { initPreviewPanel } from "./preview-panel";
import { initPreviewTranslate } from "./translate-tooltip";
import { initAppContext, app } from "./app-context";
import {
  initSidebar,
  syncSidebar,
  collapseSidebar,
  changeRoot,
  goUpOneLevel,
  toggleTree,
} from "./sidebar";
import { initTabSave, saveTab } from "./tab-save";
import { initTabLifecycle, activate, closeTab } from "./tab-lifecycle";
import {
  initFileOpen,
  newTab,
  openPath,
  openFileFromTree,
  openFolder,
  handleDropped,
  handlePrintDone,
} from "./file-open";
import { initMenuActions, handleMenuAction, bindShortcuts } from "./menu-actions";
import "./styles.css";

interface PrintResultPayload {
  path: string;
  error: string | null;
}

const appWindow = getCurrentWebviewWindow();
const store = new TabStore();

const tabbar = document.getElementById("tabs") as HTMLDivElement;
const newTabButton = document.getElementById("new-tab") as HTMLButtonElement;
const editorHost = document.getElementById("editor-host") as HTMLDivElement;
const blockToggle = document.getElementById("block-toggle") as HTMLButtonElement;
const closeFolderButton = document.getElementById("close-folder") as HTMLButtonElement;
const rootUpButton = document.getElementById("root-up") as HTMLButtonElement;

// 自动换行是编辑器行为偏好：入口在设置面板（编辑器分类），这里只存状态。
// "0" 表示关闭，其余（含无记录）默认开启
const wrapEnabled = localStorage.getItem("fEditor.wrap") !== "0";
// 列块模式对所有可编辑标签共享，与主题一样记在本地
let blockMode = localStorage.getItem("fEditor.blockMode") === "1";
// 主题偏好存在 localStorage，重启后沿用；不写进会话文件以免改会话版本号
const theme: "light" | "dark" = localStorage.getItem("fEditor.theme") === "dark" ? "dark" : "light";

const editor = new EditorController(editorHost, {
  onChange: () => {
    const tab = store.active;
    if (tab) {
      tab.dirty = editor.state.doc.toString() !== tab.savedText;
    }
    updateStatus();
    scheduleSessionSave(buildSession);
  },
  onCursor: () => {
    updateStatus();
    scheduleSessionSave(buildSession);
  },
});

// 状态栏与目录模块依赖以上对象，注入后其内部函数即可直接使用
initStatusBar({ store, editor, appWindow });
initToc({ store });

const terminal = new TerminalPanel(
  document.getElementById("terminal-panel") as HTMLDivElement,
  document.getElementById("terminal-host") as HTMLDivElement,
  document.getElementById("terminal-title") as HTMLSpanElement,
);
const terminalCloseButton = document.getElementById("terminal-close") as HTMLButtonElement;
const terminalHost = document.getElementById("terminal-host") as HTMLDivElement;

const tree = new FileTree(document.getElementById("file-tree") as HTMLDivElement, {
  // 单击复用当前标签，双击新开标签；已在其他标签打开的文件直接切过去
  onOpenFile: (path, mode) => void openFileFromTree(path, mode),
  onContextMenu: (entry, event) => void showTreeMenu(entry, event),
  // 双击目录 = 把该目录设为工作区根，方便在上层/下层之间跳
  onSetRoot: (path) => void changeRoot(path),
  onStateChange: () => scheduleSessionSave(buildSession),
  onError: (text) => void message(text),
});

// 全局共享对象注入：各业务模块通过 app 上下文只读访问
initAppContext({ appWindow, store, editor, tree, terminal, theme, wrapEnabled });

// 会话 / 标签拖拽 / Git 菜单 / 预览面板模块依赖以上对象，注入后即可直接使用
initSessionState({ store, editor, tree });
initTabDrag({
  store,
  afterReorder: () => {
    renderTabs();
    scheduleSessionSave(buildSession);
  },
});
initGitMenu({ tree, terminal, openPath });
initPreviewPanel({ store, editor, openPath });
initPreviewTranslate();

// 业务模块装配：跨界回调统一在 main 注入，模块之间保持单向依赖
initSidebar({ openFolder });
initTabSave({ renderTabs });
initTabLifecycle({ renderTabs, syncSidebar, saveTab, newTab });
initFileOpen({ renderTabs });
initMenuActions({ toggleTree, toggleBlockMode });

// 设置面板切换自动换行（编辑器分类的开关）
window.addEventListener("set-wrap", (event) => {
  app.wrapEnabled = (event as CustomEvent<boolean>).detail;
  localStorage.setItem("fEditor.wrap", app.wrapEnabled ? "1" : "0");
  editor.setWrap(app.wrapEnabled);
});

// 设置面板切换主题：与视图菜单共用同一套状态与联动（编辑器/终端配色）
window.addEventListener("set-theme", (event) => {
  const next = (event as CustomEvent<"light" | "dark">).detail;
  if (next !== app.theme) {
    app.theme = next;
    localStorage.setItem("fEditor.theme", app.theme);
    applyTheme();
  }
});

// WebView2 自带右键菜单里有「书写方向」「更多工具」等无关项，且无法逐项裁剪，
// 因此整体屏蔽，各区域改用下面的自定义菜单
window.addEventListener("contextmenu", (event) => event.preventDefault());

function writeClipboard(text: string): void {
  if (!text) return;
  void invoke("clipboard_write", { text }).catch(() => undefined);
}

async function readClipboard(): Promise<string> {
  return invoke<string>("clipboard_read").catch(() => "");
}

/** 编辑器右键菜单：撤销/重做与剪贴板操作 */
editorHost.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  const view = editor.view;
  const { from, to } = view.state.selection.main;
  showContextMenu(event.clientX, event.clientY, [
    { type: "item", label: "撤销", action: () => undo(view) },
    { type: "item", label: "重做", action: () => redo(view) },
    { type: "separator" },
    {
      type: "item",
      label: "剪切",
      action: () => {
        const text = view.state.sliceDoc(from, to);
        if (!text) return;
        writeClipboard(text);
        view.dispatch(view.state.replaceSelection(""));
        view.focus();
      },
    },
    { type: "item", label: "复制", action: () => writeClipboard(view.state.sliceDoc(from, to)) },
    {
      type: "item",
      label: "粘贴",
      action: () => {
        void readClipboard().then((text) => {
          if (!text) return;
          view.dispatch(view.state.replaceSelection(text));
          view.focus();
        });
      },
    },
    { type: "separator" },
    {
      type: "item",
      label: "全选",
      action: () => {
        view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
        view.focus();
      },
    },
  ]);
});

/** 终端右键菜单：复制/粘贴/全选/清屏/关闭 */
terminalHost.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  showContextMenu(event.clientX, event.clientY, [
    { type: "item", label: "复制", action: () => writeClipboard(terminal.selectedText()) },
    {
      type: "item",
      label: "粘贴",
      action: () => {
        void readClipboard().then((text) => terminal.paste(text));
      },
    },
    { type: "item", label: "全选", action: () => terminal.selectAll() },
    { type: "separator" },
    { type: "item", label: "清屏", action: () => terminal.clear() },
    { type: "item", label: "关闭终端", action: () => void terminal.close() },
  ]);
});

/** 主题同时作用于界面外壳、编辑器语法色与集成终端 */
function applyTheme(): void {
  const dark = app.theme === "dark";
  document.documentElement.dataset.theme = app.theme;
  editor.setTheme(dark);
  terminal.setTheme(dark);
}

/** 列块模式开关：状态栏按钮与菜单共用，状态记在本地，对所有标签生效 */
function toggleBlockMode(): void {
  blockMode = !blockMode;
  localStorage.setItem("fEditor.blockMode", blockMode ? "1" : "0");
  editor.setBlockMode(blockMode);
  blockToggle.classList.toggle("on", blockMode);
  showTransientStatus(
    blockMode ? "列块模式：开（直接拖动即为矩形选择）" : "列块模式：关（按住 Alt 临时矩形选择）",
  );
}

function renderTabs(): void {
  tabbar.replaceChildren(
    ...store.tabs.map((tab) => {
      const item = document.createElement("div");
      item.className = "tab" + (tab.id === store.activeId ? " active" : "");
      item.title = tab.path ?? tab.title;

      const label = document.createElement("span");
      label.className = "tab-title";
      label.textContent = tab.title;
      item.appendChild(label);

      if (tab.dirty) {
        const dot = document.createElement("span");
        dot.className = "dirty";
        dot.textContent = "●";
        item.appendChild(dot);
      }

      const close = document.createElement("button");
      close.className = "tab-close";
      close.textContent = "×";
      close.title = "关闭标签（Ctrl/Cmd+W）";
      close.draggable = false;
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        void closeTab(tab.id);
      });
      item.appendChild(close);

      bindTabDrag(item, tab);
      item.addEventListener("click", () => void activate(tab.id));
      item.addEventListener("auxclick", (event) => {
        if (event.button === 1) {
          event.preventDefault();
          void closeTab(tab.id);
        }
      });
      return item;
    }),
  );
}

async function boot(): Promise<void> {
  bindShortcuts();
  bindTabDragGlobal();
  // 尽早应用主题，避免深色用户先看到一帧浅色界面
  applyTheme();
  // 恢复上次的界面缩放，同样要赶在首帧之前
  applyUiScale();
  bindUiZoom();
  // 恢复上次的编辑器字号与字体外观，同样赶在首帧之前，避免先按默认值排一帧再跳
  initFontSize();
  initEditorAppearance();
  // 恢复上次的文件树宽度，避免首帧先按默认宽度排版再跳动
  applySidebarWidth();
  bindSidebarResizer();
  applyTocWidth();
  bindPreviewResizer();
  applyTerminalHeight();
  bindTerminalResizer();
  // 列块模式是纯前端行为，直接恢复上次状态并同步状态栏按钮
  editor.setBlockMode(blockMode);
  blockToggle.classList.toggle("on", blockMode);
  blockToggle.addEventListener("click", () => toggleBlockMode());
  newTabButton.addEventListener("click", () => newTab());
  closeFolderButton.addEventListener("click", () => collapseSidebar());
  rootUpButton.addEventListener("click", goUpOneLevel);
  terminalCloseButton.addEventListener("click", () => void terminal.close());
  syncSidebar();
  syncTocVisibility();
  markStartup("界面初始化");

  try {
    await listen<string>("menu-action", (event) => {
      void handleMenuAction(event.payload);
    });
    await listen<PrintResultPayload>("print-pdf-done", (event) => {
      void handlePrintDone(event.payload);
    });
  } catch (error) {
    console.warn("注册菜单事件失败", error);
  }
  markStartup("菜单事件就绪");

  // 会话、命令行参数与右键菜单目录互不依赖，并发取回，减少串行 IPC 等待
  const [session, cli, cliDir] = await Promise.all([
    loadSession(),
    invoke<string[]>("cli_files").catch(() => [] as string[]),
    invoke<string | null>("cli_dir").catch(() => null),
  ]);
  markStartup("会话读取");
  if (session) {
    setRecent(session.recent ?? []);
    for (const saved of session.tabs) {
      if (!saved.path) continue;
      // 标题始终是文件名，完整目录通过标签的悬停提示展示
      const title = basename(saved.path);
      // 类型始终按扩展名重新判定：旧会话里的 binary 字段可能和文件对不上
      const binary = binaryKindOf(title) ?? undefined;
      store.add(
        createTab({
          id: saved.id,
          path: saved.path,
          title,
          encoding: binary ? "—" : saved.encoding || "UTF-8",
          eol: saved.eol === "CRLF" ? "CRLF" : "LF",
          hasBom: Boolean(saved.hasBom),
          mtime: saved.mtime ?? 0,
          scrollTop: saved.scrollTop ?? 0,
          pendingCursor: saved.cursor ?? 0,
          preview: isMarkdown(title) || isSvg(title) || isCsv(title),
          binary,
          loaded: Boolean(binary),
        }),
      );
    }
    for (const draft of session.drafts ?? []) {
      const title = draft.title || nextUntitledTitle();
      noteUntitledTitle(title);
      store.add(
        createTab({
          id: draft.id,
          title,
          savedText: draft.text,
          scrollTop: draft.scrollTop ?? 0,
          pendingCursor: draft.cursor ?? 0,
          loaded: false,
        }),
      );
    }
  }

  // 先让编辑器把内容显示出来，用户不必等目录扫描完成。
  // 右键菜单打开时以传入目录为工作区；其余情况恢复上次的文件夹，
  // 上次的文件夹可能已被移动或删除，恢复失败时静默忽略，不打断启动。
  const rootToOpen = cliDir ?? session?.root ?? null;
  const treeReady = rootToOpen
    ? tree.setRoot(rootToOpen, true).then(async (opened) => {
        if (!opened) return;
        // 展开集合属于上次的根目录，切换目录时不能套用
        if (!cliDir) await tree.restoreExpanded(session?.treeExpanded ?? []);
        syncSidebar();
        // 目录扫描期间用户可能已切换标签，这里按当前标签补一次定位高亮
        const current = store.active;
        if (current?.path) tree.markActive(current.path);
      })
    : Promise.resolve();

  if (store.tabs.length === 0 && cli.length === 0) {
    newTab();
  } else if (store.tabs.length > 0) {
    const target =
      (session?.activeId && store.get(session.activeId)?.id) ||
      store.tabs[0].id;
    // 启动恢复时保持上次保存的文件夹，不因激活标签而切换工作区
    await activate(target, false, false);
    markStartup("首屏文件就绪");
  }

  for (const path of cli) {
    await openPath(path, true);
  }

  // 首屏内容已经进编辑器，立刻显示窗口；
  // 目录扫描和事件注册放到显示之后，大目录时也不会拖慢开窗
  revealWindow();

  await treeReady;
  markStartup("文件树恢复");

  // 集成终端默认打开：有工作区目录就自动展示；不抢焦点，编辑器保持可用
  if (tree.currentRoot) {
    await terminal.open(tree.currentRoot, false);
  }

  try {
    await appWindow.onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        void handleDropped(event.payload.paths);
      }
    });
  } catch (error) {
    console.warn("注册拖拽事件失败", error);
  }

  try {
    await appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      const dirtyTabs = store.tabs.filter((tab) => tab.dirty);
      if (dirtyTabs.length > 0) {
        const choice = await ask(`有 ${dirtyTabs.length} 个标签未保存，确定退出吗？`, [
          { label: "保存全部", value: "save", primary: true },
          { label: "不保存退出", value: "discard" },
          { label: "取消", value: "cancel" },
        ]);
        if (choice === "cancel") return;
        if (choice === "save") {
          for (const tab of dirtyTabs) {
            const saved = await saveTab(tab);
            if (!saved) return;
          }
        }
      }
      await flushSession(buildSession);
      // 先结束终端进程再退出，否则 PTY 子进程会残留
      await terminal.close();
      await appWindow.destroy();
    });
  } catch (error) {
    console.warn("注册关闭事件失败", error);
  }

  window.addEventListener("beforeunload", () => {
    void flushSession(buildSession);
  });

  finishStartupTiming();
}

let windowRevealed = false;

/**
 * 窗口在 tauri.conf.json 里初始隐藏，等两帧渲染完成再显示。
 * WebView2 初始化期间窗口是纯白的，先显示会看到 1-2 秒白屏；
 * 隐藏后直接出现在内容已绘制好的画面上，观感是「一点就开」。
 */
function revealWindow(): void {
  if (windowRevealed) return;
  windowRevealed = true;
  const show = () => {
    // 权限缺失或窗口已销毁时会失败，静默忽略即可（Rust 侧还有兜底）
    void appWindow
      .show()
      .then(() => {
        markStartup("窗口显示");
        return appWindow.setFocus();
      })
      .catch(() => undefined);
  };
  requestAnimationFrame(() => requestAnimationFrame(show));
  // 双 rAF 在某些情况下（窗口未显示时合成器降频）可能不触发，加个短定时器保底
  window.setTimeout(show, 200);
}

// 打印窗口复用同一份前端：按窗口标签分流，主窗口才启动完整界面
if (appWindow.label === "print") {
  void import("./print-mode");
} else {
  void boot().catch((error) => {
    console.error("启动失败", error);
    // 启动流程出错也要把窗口放出来，否则用户只看到一个任务栏图标
    revealWindow();
  });

  // 兜底：启动流程卡住时也要尽快把窗口放出来，避免长时间「点了没反应」
  window.setTimeout(revealWindow, 1500);
}
