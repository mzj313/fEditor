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

/** 把 git status --porcelain 的行渲染成彩色清单：状态码着色 + 文件路径 */
function buildChangeList(changes: string[]): HTMLElement {
  const wrap = document.createElement("div");
  const head = document.createElement("div");
  head.textContent = `本次将提交以下 ${changes.length} 个文件：`;
  head.style.marginBottom = "6px";
  wrap.append(head);

  const list = document.createElement("div");
  list.style.cssText =
    "max-height:260px;overflow-y:auto;text-align:left;font-family:Consolas,monospace;font-size:12px;line-height:1.6;";
  for (const line of changes) {
    const row = document.createElement("div");
    const badge = document.createElement("span");
    badge.textContent = line.slice(0, 2);
    badge.style.cssText = `color:${statusColor(line.slice(0, 2))};font-weight:600;white-space:pre;`;
    const name = document.createElement("span");
    name.textContent = line.slice(2);
    name.style.whiteSpace = "pre-wrap";
    row.append(badge, name);
    list.append(row);
  }
  wrap.append(list);
  return wrap;
}

async function commitAllChanges(dir: string): Promise<void> {
  if (!terminal) return;
  // 提交前先展示改动清单，让用户确认这次提交会包含哪些文件
  const changes = await invoke<string[]>("git_status", { path: dir }).catch(() => [] as string[]);
  if (changes.length === 0) {
    await message("没有可提交的改动（工作区是干净的）。");
    return;
  }
  const choice = await ask(buildChangeList(changes), [
    { label: "继续提交", value: "ok", primary: true },
    { label: "取消", value: "cancel" },
  ]);
  if (choice !== "ok") return;
  const text = await promptText("提交信息");
  if (!text) return;
  // 先暂存全部改动再提交，提交信息按当前 shell 的引号规则转义
  await terminal.run(dir, ["git add -A", `git commit -m ${terminal.quoteArg(text)}`]);
}
