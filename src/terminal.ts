import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { getTerminalFontSize } from "./settings";

interface OpenResult {
  id: number;
  shell: string;
}

interface OutputEvent {
  id: number;
  data: number[];
}

/**
 * 底部集成终端：单会话复用。
 * 已有会话时通过 cd 切目录而不是重建，避免丢失之前的输出。
 */
export class TerminalPanel {
  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private observer: ResizeObserver | null = null;
  /** 防抖用的定时器句柄；连续 resize 期间只保留最后一次 fit */
  private fitTimer: number | null = null;
  private unlisten: UnlistenFn | null = null;
  private sessionId: number | null = null;
  private shell = "";
  private title = "";
  private dark = false;

  constructor(
    private panel: HTMLDivElement,
    private host: HTMLDivElement,
    private titleEl: HTMLSpanElement,
  ) {}

  get visible(): boolean {
    return !this.panel.hidden;
  }

  /** 在指定目录打开终端；面板已存在时只切换目录。focus=false 用于启动时默认展示，不抢编辑器焦点 */
  async open(cwd: string, focus = true): Promise<void> {
    this.panel.hidden = false;
    await this.ensureTerminal();

    if (this.sessionId === null) {
      const result = await invoke<OpenResult>("terminal_open", { cwd });
      this.sessionId = result.id;
      this.shell = result.shell;
      this.title = cwd;
      this.titleEl.textContent = cwd;
      this.titleEl.title = cwd;
      this.fitNow();
      if (focus) this.term?.focus();
      return;
    }

    // 复用会话：不同 shell 的切换目录写法不一样
    await invoke("terminal_write", { id: this.sessionId, data: this.cdCommand(cwd) });
    this.title = cwd;
    this.titleEl.textContent = cwd;
    this.titleEl.title = cwd;
    if (focus) this.term?.focus();
  }

  hide(): void {
    this.panel.hidden = true;
  }

  /**
   * 切换标签时同步终端所在目录。
   * 只对已打开、已建立会话的终端生效：不主动拉起面板，也不重复发送相同目录，
   * 避免切换标签时往 shell 里刷一堆无意义的 cd 命令。
   */
  async syncDirectory(cwd: string): Promise<void> {
    if (!this.visible || this.sessionId === null) return;
    const normalize = (value: string): string => value.replace(/[\\/]+$/, "").toLowerCase();
    if (normalize(this.title) === normalize(cwd)) return;
    await invoke("terminal_write", { id: this.sessionId, data: this.cdCommand(cwd) });
    this.title = cwd;
    this.titleEl.textContent = cwd;
    this.titleEl.title = cwd;
  }

  /** 在指定目录执行一条或多条命令（Git 操作走这里） */
  async run(cwd: string, commands: string | string[]): Promise<void> {
    await this.open(cwd);
    if (this.sessionId === null) return;
    const list = Array.isArray(commands) ? commands : [commands];
    // cmd 不支持用分号串联命令，PowerShell 两种都支持（这里统一用分号）
    const separator = this.shell.toLowerCase().includes("cmd") ? " && " : "; ";
    await invoke("terminal_write", {
      id: this.sessionId,
      data: `${list.join(separator)}\r`,
    });
    this.term?.focus();
  }

  /** 生成切换目录命令：cmd 用 cd /d，PowerShell 用 Set-Location，其余按 POSIX shell 处理 */
  private cdCommand(cwd: string): string {
    const shell = this.shell.toLowerCase();
    if (shell.includes("cmd")) return `cd /d "${cwd}"\r`;
    if (shell.includes("pwsh") || shell.includes("powershell")) {
      return `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'\r`;
    }
    return `cd -- ${this.quoteArg(cwd)}\r`;
  }

  /** 按当前 shell 的语法给参数加引号，用于拼接提交信息、分支名 */
  quoteArg(value: string): string {
    const shell = this.shell.toLowerCase();
    if (shell.includes("cmd")) {
      // cmd 的双引号内无法转义引号，直接剔除，避免命令被提前截断
      return `"${value.replace(/"/g, "")}"`;
    }
    if (shell.includes("pwsh") || shell.includes("powershell")) {
      return `'${value.replace(/'/g, "''")}'`;
    }
    // POSIX：单引号内除单引号外都是字面量，用 '\'' 拼接
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  toggle(cwd: string): Promise<void> {
    if (this.visible) {
      this.hide();
      return Promise.resolve();
    }
    return this.open(cwd);
  }

  /** 结束进程并释放画面，下次打开会重新创建会话 */
  async close(): Promise<void> {
    const id = this.sessionId;
    this.sessionId = null;
    this.hide();
    if (id !== null) {
      await invoke("terminal_close", { id }).catch(() => undefined);
    }
  }

  currentTitle(): string {
    return this.title;
  }

  /** 当前选中的文本，未选中时为空串 */
  selectedText(): string {
    return this.term?.getSelection() ?? "";
  }

  selectAll(): void {
    this.term?.selectAll();
  }

  clear(): void {
    this.term?.clear();
  }

  /** 走 xterm 的 paste，等价于用户按 Ctrl+V，会触发 onData 写回 PTY */
  paste(text: string): void {
    if (!text) return;
    this.term?.paste(text);
    this.term?.focus();
  }

  focus(): void {
    this.term?.focus();
  }

  /** 与主界面主题保持一致，避免浅色终端夹在深色界面里 */
  setTheme(dark: boolean): void {
    this.dark = dark;
    if (this.term) this.term.options.theme = this.terminalTheme();
  }

  /** 设置面板调整终端字号：实例未创建时偏好会在下次 open 时生效 */
  setFontSize(size: number): void {
    if (!this.term) return;
    this.term.options.fontSize = size;
    this.fitNow();
  }

  private terminalTheme(): Record<string, string> {
    return this.dark
      ? {
          background: "#272822",
          foreground: "#f8f8f2",
          cursor: "#66d9ef",
          selectionBackground: "rgba(102, 217, 239, 0.3)",
        }
      : {
          background: "#ffffff",
          foreground: "#202124",
          cursor: "#2f6fdb",
          selectionBackground: "rgba(47, 111, 219, 0.28)",
        };
  }

  private async ensureTerminal(): Promise<void> {
    if (this.term) return;
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
    ]);

    const term = new Terminal({
      fontFamily: '"SFMono-Regular", Menlo, Consolas, "Courier New", monospace',
      fontSize: getTerminalFontSize(),
      cursorBlink: true,
      scrollback: 5000,
      theme: this.terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(this.host);
    // 首次尺寸在 open() 里通过 fitNow() 校准：那里会处理界面缩放带来的测量偏差

    // 用户在终端里输入时直接写回 PTY
    term.onData((data) => {
      if (this.sessionId !== null) {
        void invoke("terminal_write", { id: this.sessionId, data });
      }
    });
    term.onResize(({ rows, cols }) => {
      if (this.sessionId !== null) {
        void invoke("terminal_resize", { id: this.sessionId, rows, cols }).catch(
          () => undefined,
        );
      }
    });

    this.unlisten = await listen<OutputEvent>("terminal-output", (event) => {
      if (event.payload.id !== this.sessionId) return;
      term.write(new Uint8Array(event.payload.data));
    });

    this.term = term;
    this.fit = fit;

    // 面板尺寸变化（窗口缩放、界面缩放）时同步 PTY 的行列数。
    // 界面缩放会连续触发 resize，这里做防抖，避免每一帧都重排 xterm 并通知 PTY。
    this.observer = new ResizeObserver(() => this.scheduleFit());
    this.observer.observe(this.host);
  }

  /** 80ms 内的连续尺寸变化合并成一次 fit */
  private scheduleFit(): void {
    if (this.fitTimer !== null) window.clearTimeout(this.fitTimer);
    this.fitTimer = window.setTimeout(() => {
      this.fitTimer = null;
      this.fitNow();
    }, 80);
  }

  private fitNow(): void {
    if (!this.fit || this.panel.hidden) return;
    // 隐藏状态下容器高度为 0，fit 会把行列算成极小值
    requestAnimationFrame(() => {
      // 界面缩放是给 #app 加 transform，而 FitAddon 是「父容器布局宽度 ÷ 单元格矩形宽度」，
      // 分子不含缩放、分母含缩放，缩放不为 1 时列数会被算少一大截。
      // 这里临时撤掉缩放量一次尺寸，同一帧内还原，不会出现闪烁。
      const root = document.getElementById("app");
      const saved = root
        ? { transform: root.style.transform, width: root.style.width, height: root.style.height }
        : null;
      if (root && saved?.transform) {
        root.style.transform = "";
        root.style.width = "";
        root.style.height = "";
      }
      try {
        this.fit?.fit();
      } catch {
        // 容器还没布局完成时忽略即可，下一次 resize 会再校准
      } finally {
        if (root && saved?.transform) {
          root.style.transform = saved.transform;
          root.style.width = saved.width;
          root.style.height = saved.height;
        }
      }
    });
  }
}
