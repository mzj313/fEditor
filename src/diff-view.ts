//! 文本对比：视图菜单 →「文本对比…」
//! 左右两栏各自可「选择文件」或直接粘贴文本；两侧都有内容后自动按行对比，
//! 面板本身就地显示带行号与整行底色的差异（不再有独立的工具栏和结果区）。
//! 双击任意一侧可切回文本域继续编辑，改完自动重算。结果用四列网格渲染：
//! 左行号 / 左文本 / 右行号 / 右文本，行号列紧贴中间分隔线。

import { invoke } from "@tauri-apps/api/core";

interface FilePayload {
  path: string;
  content: string;
}

/** 差异行的类型：相同 / 修改（左右都有但内容不同） / 仅新增 / 仅删除 */
type DiffKind = "equal" | "mod" | "add" | "del";

interface DiffRow {
  leftNo: number | null;
  leftText: string | null;
  rightNo: number | null;
  rightText: string | null;
  kind: DiffKind;
}

/**
 * DP 规模上限（单元格数）。行级 LCS 需要 (n+1)*(m+1) 个格子，
 * 超过这个量级时改用「中间整块替换」，避免大文件把内存吃满。
 */
const MAX_DP_CELLS = 4_000_000;

/** 单次最多渲染多少行，防止超大文件把 DOM 撑爆 */
const MAX_RENDER_ROWS = 20_000;

/** 输入停止多久后自动对比，太短会在打字中间就跳走 */
const AUTO_COMPARE_DELAY_MS = 400;

/** 按行切分；统一换行符并丢掉末尾因换行产生的空串 */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

interface DiffOp {
  type: "equal" | "del" | "ins";
  ai: number;
  bi: number;
}

/** 行级 LCS：返回把 a 变成 b 的操作序列 */
function lcsOps(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((_, j) => ({ type: "ins" as const, ai: 0, bi: j }));
  if (m === 0) return a.map((_, i) => ({ type: "del" as const, ai: i, bi: 0 }));

  if (n * m > MAX_DP_CELLS) {
    // 规模过大：左侧全部删除、右侧全部新增，交给上层配对成「修改」
    const ops: DiffOp[] = [];
    for (let i = 0; i < n; i++) ops.push({ type: "del", ai: i, bi: 0 });
    for (let j = 0; j < m; j++) ops.push({ type: "ins", ai: 0, bi: j });
    return ops;
  }

  const width = m + 1;
  // dp[i * width + j] = a[i..] 与 b[j..] 的 LCS 长度，从后往前填表
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", ai: i, bi: j });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ type: "del", ai: i, bi: j });
      i++;
    } else {
      ops.push({ type: "ins", ai: i, bi: j });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", ai: i++, bi: j });
  while (j < m) ops.push({ type: "ins", ai: i, bi: j++ });
  return ops;
}

/** 把两段文本算成按行对齐的差异行 */
function buildDiffRows(leftText: string, rightText: string): DiffRow[] {
  const a = splitLines(leftText);
  const b = splitLines(rightText);

  // 公共前后缀先剥离，既省 DP 内存也能让结果更直观（前后未改动部分直接对齐）
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const rows: DiffRow[] = [];
  for (let k = 0; k < start; k++) {
    rows.push({ leftNo: k + 1, leftText: a[k], rightNo: k + 1, rightText: b[k], kind: "equal" });
  }

  // 中间段：连续的删除与新增按顺序两两配对成「修改」，多出来的单独成行
  const ops = lcsOps(a.slice(start, endA), b.slice(start, endB));
  let deletes: number[] = [];
  let inserts: number[] = [];
  const flush = (): void => {
    const paired = Math.min(deletes.length, inserts.length);
    for (let k = 0; k < paired; k++) {
      const ai = start + deletes[k];
      const bi = start + inserts[k];
      rows.push({
        leftNo: ai + 1,
        leftText: a[ai],
        rightNo: bi + 1,
        rightText: b[bi],
        kind: "mod",
      });
    }
    for (let k = paired; k < deletes.length; k++) {
      const ai = start + deletes[k];
      rows.push({ leftNo: ai + 1, leftText: a[ai], rightNo: null, rightText: null, kind: "del" });
    }
    for (let k = paired; k < inserts.length; k++) {
      const bi = start + inserts[k];
      rows.push({ leftNo: null, leftText: null, rightNo: bi + 1, rightText: b[bi], kind: "add" });
    }
    deletes = [];
    inserts = [];
  };

  for (const op of ops) {
    if (op.type === "equal") {
      flush();
      const ai = start + op.ai;
      const bi = start + op.bi;
      rows.push({
        leftNo: ai + 1,
        leftText: a[ai],
        rightNo: bi + 1,
        rightText: b[bi],
        kind: "equal",
      });
    } else if (op.type === "del") {
      deletes.push(op.ai);
    } else {
      inserts.push(op.bi);
    }
  }
  flush();

  for (let k = 0; endA + k < a.length; k++) {
    const ai = endA + k;
    const bi = endB + k;
    rows.push({
      leftNo: ai + 1,
      leftText: a[ai],
      rightNo: bi + 1,
      rightText: b[bi],
      kind: "equal",
    });
  }
  return rows;
}

/* ---------------- 面板 UI ---------------- */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let backdrop: HTMLDivElement | null = null;
/** 自动对比的防抖句柄，关闭面板时要清掉 */
let compareTimer: number | null = null;

function closeDiffDialog(): void {
  if (compareTimer !== null) {
    window.clearTimeout(compareTimer);
    compareTimer = null;
  }
  if (!backdrop) return;
  backdrop.remove();
  backdrop = null;
}

/** 差异行背景：修改/删除在左栏，修改/新增在右栏 */
function kindClass(kind: DiffKind, side: "left" | "right"): string {
  if (kind === "equal") return "";
  if (kind === "mod") return side === "left" ? "diff-del-line" : "diff-add-line";
  if (kind === "del") return side === "left" ? "diff-del-line" : "";
  return side === "right" ? "diff-add-line" : "";
}

/** 渲染差异网格；所有行共用一个滚动容器，左右天然对齐 */
function renderGrid(host: HTMLElement, leftText: string, rightText: string): void {
  const rows = buildDiffRows(leftText, rightText);
  host.replaceChildren();
  if (!rows.length) {
    host.append(el("div", "diff-empty", "两侧均为空"));
    return;
  }

  const grid = el("div", "diff-grid");
  const limit = Math.min(rows.length, MAX_RENDER_ROWS);
  for (let k = 0; k < limit; k++) {
    const row = rows[k];
    const node = el("div", `diff-row diff-${row.kind}`);
    // 列序与截图一致：左文本 | 左行号 ‖ 右行号 | 右文本（行号贴着中间分隔线）
    node.append(
      el(
        "div",
        `diff-text diff-left ${kindClass(row.kind, "left")}`,
        row.leftText ?? "",
      ),
      el("div", "diff-no", row.leftNo === null ? "" : String(row.leftNo)),
      el("div", "diff-no", row.rightNo === null ? "" : String(row.rightNo)),
      el(
        "div",
        `diff-text diff-right ${kindClass(row.kind, "right")}`,
        row.rightText ?? "",
      ),
    );
    grid.append(node);
  }
  host.append(grid);

  if (rows.length > limit) {
    host.append(el("div", "diff-empty", `内容过大，仅显示前 ${limit} 行`));
  }
}

/**
 * 单侧栏头：标题 + 文件名（选择后显示）+「选择文件…」。
 * 返回文件名节点，供选择文件后回填。
 */
function buildPaneHead(
  row: HTMLElement,
  title: string,
  onPick: () => void,
): HTMLSpanElement {
  const head = el("div", "diff-pane-head");
  head.append(el("span", "diff-pane-title", title));
  const fileLabel = el("span", "diff-file-label");
  fileLabel.hidden = true;
  const pick = el("button", "diff-pick", "选择文件…");
  pick.addEventListener("click", onPick);
  head.append(fileLabel, pick);
  row.append(head);
  return fileLabel;
}

/** 视图菜单 →「文本对比…」入口；已打开时只把焦点放回面板 */
export function openDiffDialog(): void {
  if (backdrop) {
    backdrop.querySelector<HTMLTextAreaElement>(".diff-input")?.focus();
    return;
  }

  backdrop = el("div", "diff-backdrop");
  const card = el("div", "diff-card");

  const head = el("div", "diff-head");
  head.append(el("span", "diff-title", "文本对比"));
  const status = el("span", "diff-status", "两侧都有内容后自动对比，双击结果可返回编辑");
  head.append(status);
  const close = el("button", "diff-close", "×");
  close.title = "关闭（Esc）";
  close.addEventListener("click", () => closeDiffDialog());
  head.append(close);

  const paneHeads = el("div", "diff-pane-heads");
  const editors = el("div", "diff-editors");
  const body = el("div", "diff-body");
  body.hidden = true;

  const leftInput = el("textarea", "diff-input");
  const rightInput = el("textarea", "diff-input");
  for (const input of [leftInput, rightInput]) {
    input.spellcheck = false;
    input.placeholder = "粘贴文本，或点击右上「选择文件…」";
  }
  editors.append(leftInput, rightInput);

  /** 头部状态提示，几秒后自动消失，不占额外空间 */
  let statusTimer: number | null = null;
  const setStatus = (text: string): void => {
    status.textContent = text;
    if (statusTimer !== null) window.clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => {
      status.textContent = "";
    }, 5000);
  };

  /** 结果态：隐藏文本域，就地显示差异网格 */
  const showView = (): void => {
    renderGrid(body, leftInput.value, rightInput.value);
    status.textContent = "";
    editors.hidden = true;
    body.hidden = false;
    body.scrollTop = 0;
  };

  /** 编辑态：隐藏结果，露出文本域，焦点放到指定一侧 */
  const showEdit = (side: "left" | "right"): void => {
    body.hidden = true;
    editors.hidden = false;
    (side === "left" ? leftInput : rightInput).focus();
  };

  /** 两侧都有内容才自动切到结果态，避免刚粘完一侧就跳走 */
  const scheduleCompare = (): void => {
    if (compareTimer !== null) window.clearTimeout(compareTimer);
    compareTimer = window.setTimeout(() => {
      compareTimer = null;
      if (leftInput.value && rightInput.value) showView();
    }, AUTO_COMPARE_DELAY_MS);
  };

  const pickFile = (
    input: HTMLTextAreaElement,
    fileLabel: HTMLSpanElement,
    side: "left" | "right",
  ): void => {
    void (async () => {
      try {
        const paths = await invoke<string[]>("pick_open_files");
        if (!paths.length) return;
        const path = paths[0];
        // read_file 返回的 content 已统一成 LF，直接放进文本域即可编辑/对比
        const payload = await invoke<FilePayload>("read_file", { path });
        input.value = payload.content;
        fileLabel.textContent = path.replace(/^.*[\\/]/, "");
        fileLabel.title = payload.path;
        fileLabel.hidden = false;
        if (leftInput.value && rightInput.value) showView();
        else showEdit(side);
      } catch (error) {
        setStatus(`读取文件失败：${error}`);
      }
    })();
  };

  const leftFileLabel = buildPaneHead(paneHeads, "原文本", () => {
    pickFile(leftInput, leftFileLabel, "left");
  });
  const rightFileLabel = buildPaneHead(paneHeads, "新文本", () => {
    pickFile(rightInput, rightFileLabel, "right");
  });

  leftInput.addEventListener("input", scheduleCompare);
  rightInput.addEventListener("input", scheduleCompare);

  // Ctrl+Enter 立即对比，不必等防抖
  for (const input of [leftInput, rightInput]) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        if (compareTimer !== null) {
          window.clearTimeout(compareTimer);
          compareTimer = null;
        }
        showView();
      }
    });
  }

  // 双击任意一侧切回编辑：左侧命中 .diff-left，其余按右侧处理
  body.addEventListener("dblclick", (event) => {
    const target = event.target as HTMLElement | null;
    showEdit(target?.closest(".diff-right") ? "right" : "left");
  });

  card.append(head, paneHeads, editors, body);
  backdrop.append(card);
  document.body.append(backdrop);

  // 遮罩上拦截 Esc（文本域内也生效），捕获阶段避免被其他处理抢先
  backdrop.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDiffDialog();
    }
  });

  leftInput.focus();
}
