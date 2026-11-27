import { invoke } from "@tauri-apps/api/core";
import { showContextMenu, type MenuEntry } from "./context-menu";
import { ask, message, promptText } from "./dialogs";
import type { FileTree, TreeEntry } from "./file-tree";
import { parentDir } from "./paths";
import { showTransientStatus } from "./statusbar";
import type { TerminalPanel } from "./terminal";
import { createEntry, deleteEntry, renameEntry } from "./tree-files";

interface GitRepoInfo {
  root: string;
}

let tree: FileTree | null = null;
let terminal: TerminalPanel | null = null;
let openPath: ((path: string) => Promise<void>) | null = null;

/** 依赖在 main.ts 里创建完成后注入，避免模块间循环 import */
export function initGitMenu(deps: {
  tree: FileTree;
  terminal: TerminalPanel;
  openPath: (path: string) => Promise<void>;
}): void {
  tree = deps.tree;
  terminal = deps.terminal;
  openPath = deps.openPath;
}

/** 文件树右键菜单：文件用其父目录，目录用自身，空白处用工作区根 */
export async function showTreeMenu(entry: TreeEntry | null, event: MouseEvent): Promise<void> {
  if (!tree || !terminal) return;
  const root = tree.currentRoot;
  if (!root) return;
  const target = entry ? (entry.isDir ? entry.path : parentDir(entry.path)) : root;

  // 先判断是否在 git 仓库下，再一次性弹出菜单，避免菜单弹出后又被替换而闪烁
  const repo = await invoke<GitRepoInfo | null>("git_repo_info", { path: target }).catch(
    () => null,
  );

  // git log 默认展示整个仓库；按所选对象给出过滤范围：
  // 文件的 cwd 已在父目录，过滤用文件名；目录的 cwd 就是自身，用 "." 覆盖其下全部
  const logScope = entry ? (entry.isDir ? "." : entry.name) : "";

  const entries: MenuEntry[] = [];
  // 文件才提供「用新标签打开」；已在标签里打开时切过去，避免同一文件出现两份
  if (entry && !entry.isDir && openPath) {
    entries.push(
      { type: "item", label: "用新标签打开", action: () => void openPath?.(entry.path) },
      { type: "separator" },
    );
  }
  entries.push(
    { type: "item", label: "新建文件…", action: () => void createEntry(entry, false) },
    { type: "item", label: "新建文件夹…", action: () => void createEntry(entry, true) },
  );
  if (entry) {
    entries.push(
      { type: "separator" },
      { type: "item", label: "重命名…", action: () => void renameEntry(entry) },
      { type: "item", label: "删除", action: () => void deleteEntry(entry) },
      { type: "item", label: "复制路径", action: () => copyPath(entry) },
    );
  }
  entries.push(
    { type: "separator" },
    { type: "item", label: "刷新", action: () => void tree?.refresh() },
    { type: "item", label: "展开全部（3 层）", action: () => void tree?.expandAll() },
    { type: "item", label: "折叠全部", action: () => tree?.collapseAll() },
    { type: "separator" },
    { type: "item", label: "在集成终端打开", action: () => void terminal?.open(target) },
  );
  if (repo) entries.push({ type: "separator" }, ...gitMenuEntries(target, logScope));

  showContextMenu(event.clientX, event.clientY, entries);
}

/** 复制完整路径到剪贴板；失败时给出提示，避免看起来没反应 */
function copyPath(entry: TreeEntry): void {
  void navigator.clipboard.writeText(entry.path).then(
    () => showTransientStatus("已复制路径"),
    () => showTransientStatus("复制路径失败"),
  );
}

function gitMenuEntries(dir: string, logScope: string): MenuEntry[] {  // Git 操作收进子菜单，命令名保持英文，便于和终端里手敲的命令对应
  return [
    {
      type: "submenu",
      label: "Git",
      entries: [
        {
          type: "item",
          label: "git status",
          action: () => void terminal?.run(dir, "git status -sb"),
        },
        {
          type: "item",
          label: "git log",
          action: () => void runGitLog(dir, logScope),
        },
        { type: "separator" },
        { type: "item", label: "git pull", action: () => void terminal?.run(dir, "git pull") },
        { type: "item", label: "git push", action: () => void terminal?.run(dir, "git push") },
        { type: "item", label: "git commit all…", action: () => void commitAllChanges(dir) },
      ],
    },
  ];
}

/** 按所选文件/目录查看提交历史；引号规则要等终端起来后才能确定 */
async function runGitLog(dir: string, scope: string): Promise<void> {
  if (!terminal) return;
  await terminal.open(dir);
  const filter = scope ? ` -- ${terminal.quoteArg(scope)}` : "";
  // --oneline 只有短 hash 和标题，看不到作者；显式指定格式补上作者与日期
  const format = terminal.quoteArg("%h %ad %an  %s");
  await terminal.run(dir, `git log --graph --date=short -20 --pretty=${format}${filter}`);
}

/** 状态码配色：新增绿、修改橙、删除红、重命名/复制紫、未跟踪蓝 */
const STATUS_COLORS: Record<string, string> = {
  A: "#3fb950",
  M: "#d29922",
  D: "#f85149",
  R: "#a371f7",
  C: "#a371f7",
  "?": "#58a6ff",
};

/** porcelain 两位状态码里取非空格那位决定颜色；?? 整体按未跟踪处理 */
function statusColor(code: string): string {
  if (code.includes("?")) return STATUS_COLORS["?"];
  return STATUS_COLORS[code.trim().charAt(0)] ?? "#8b949e";
}

/** 还原文 git 加引号的路径：中文等非 ASCII 会被转成八进制字节转义 */
function unquoteGitPath(quoted: string): string {
  let out = "";
  const bytes: number[] = [];
  // 八进制转义是 UTF-8 字节，需要攒够一段再用 TextDecoder 还原
  const flush = () => {
    if (bytes.length === 0) return;
    out += new TextDecoder().decode(new Uint8Array(bytes));
    bytes.length = 0;
  };

  for (let index = 0; index < quoted.length; index += 1) {
    const char = quoted[index];
    if (char !== "\\") {
      flush();
      out += char;
      continue;
    }
    const next = quoted[index + 1] ?? "";
    if (next >= "0" && next <= "7") {
      bytes.push(parseInt(quoted.slice(index + 1, index + 4), 8));
      index += 3;
      continue;
    }
    flush();
    out += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next;
    index += 1;
  }
  flush();
  return out;
}

/** 从 porcelain 行解析真实路径：去掉状态码，处理引号转义与重命名 */
function parseStatusPath(line: string): string {
  // 格式固定为 "XY 路径"，第 3 个字符是分隔空格
  let rest = line.slice(3);
  // 重命名/复制写成 "旧 -> 新"，提交只需要新路径
  const arrow = rest.indexOf(" -> ");
  if (arrow >= 0) rest = rest.slice(arrow + 4);
  return rest.startsWith('"') && rest.endsWith('"')
    ? unquoteGitPath(rest.slice(1, -1))
    : rest;
}

interface ChangePicker {
  element: HTMLElement;
  /** 当前勾选的文件路径；弹窗关闭后仍可读取 */
  selected(): string[];
}

/** 把 git status --porcelain 的行渲染成带复选框的清单：状态码着色 + 文件路径 */
function buildChangePicker(changes: string[]): ChangePicker {
  const wrap = document.createElement("div");
  wrap.style.minWidth = "420px";

  const head = document.createElement("div");
  head.textContent = `本次改动共 ${changes.length} 个文件，勾选要提交的：`;
  head.style.marginBottom = "6px";
  wrap.append(head);

  const toolbar = document.createElement("div");
  toolbar.style.cssText =
    "display:flex;align-items:center;gap:12px;margin-bottom:6px;font-size:12px;";
  const allLabel = document.createElement("label");
  allLabel.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer;";
  const allBox = document.createElement("input");
  allBox.type = "checkbox";
  allBox.checked = true;
  allLabel.append(allBox, document.createTextNode("全选"));

  const count = document.createElement("span");
  count.style.opacity = "0.7";
  toolbar.append(allLabel, count);
  wrap.append(toolbar);

  const list = document.createElement("div");
  list.style.cssText =
    "max-height:260px;overflow-y:auto;text-align:left;font-family:Consolas,monospace;font-size:12px;line-height:1.6;";
  wrap.append(list);

  const boxes: HTMLInputElement[] = [];
  const syncCount = () => {
    const picked = boxes.filter((box) => box.checked).length;
    count.textContent = `已选 ${picked} / ${boxes.length}`;
    allBox.checked = picked === boxes.length;
    allBox.indeterminate = picked > 0 && picked < boxes.length;
  };

  for (const line of changes) {
    const row = document.createElement("label");
    row.style.cssText = "display:flex;align-items:center;gap:6px;padding:1px 0;cursor:pointer;";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = true;
    box.dataset.path = parseStatusPath(line);
    box.addEventListener("change", syncCount);

    const badge = document.createElement("span");
    badge.textContent = line.slice(0, 2);
    badge.style.cssText = `color:${statusColor(line.slice(0, 2))};font-weight:600;white-space:pre;`;

    const name = document.createElement("span");
    name.textContent = line.slice(2);
    name.style.whiteSpace = "pre-wrap";

    row.append(box, badge, name);
    list.append(row);
    boxes.push(box);
  }

  allBox.addEventListener("change", () => {
    for (const box of boxes) box.checked = allBox.checked;
    syncCount();
  });
  syncCount();

  return {
    element: wrap,
    selected: () =>
      boxes
        .filter((box) => box.checked)
        .map((box) => box.dataset.path ?? "")
        .filter((path) => path.length > 0),
  };
}

async function commitAllChanges(dir: string): Promise<void> {
  // 存成局部常量：多个 await 之后模块级变量的类型收窄会失效
  const shell = terminal;
  if (!shell) return;
  // 提交前先展示改动清单，让用户勾选这次提交包含哪些文件
  const changes = await invoke<string[]>("git_status", { path: dir }).catch(() => [] as string[]);
  if (changes.length === 0) {
    await message("没有可提交的改动（工作区是干净的）。");
    return;
  }
  const picker = buildChangePicker(changes);
  const choice = await ask(picker.element, [
    { label: "继续提交", value: "ok", primary: true },
    { label: "取消", value: "cancel" },
  ]);
  if (choice !== "ok") return;
  // 弹窗只是隐藏、DOM 还在，关闭后照常读取勾选结果
  const picked = picker.selected();
  if (picked.length === 0) {
    await message("请至少勾选一个文件。");
    return;
  }
  const text = await promptText("提交信息");
  if (!text) return;
  // 先清空暂存区，再只暂存勾选的文件，避免把未勾选的改动一起提交出去
  const args = picked.map((path) => shell.quoteArg(path)).join(" ");
  await shell.run(dir, [
    "git reset --quiet",
    `git add -- ${args}`,
    `git commit -m ${shell.quoteArg(text)}`,
  ]);
}
