import { invoke } from "@tauri-apps/api/core";
import { showContextMenu, type MenuEntry } from "./context-menu";
import { promptText } from "./dialogs";
import type { FileTree, TreeEntry } from "./file-tree";
import { parentDir } from "./paths";
import type { TerminalPanel } from "./terminal";

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
    { type: "item", label: "刷新", action: () => void tree?.refresh() },
    { type: "item", label: "展开全部（3 层）", action: () => void tree?.expandAll() },
    { type: "item", label: "折叠全部", action: () => tree?.collapseAll() },
    { type: "separator" },
    { type: "item", label: "在集成终端打开", action: () => void terminal?.open(target) },
  );
  if (repo) entries.push({ type: "separator" }, ...gitMenuEntries(target, logScope));

  showContextMenu(event.clientX, event.clientY, entries);
}

function gitMenuEntries(dir: string, logScope: string): MenuEntry[] {
  // Git 操作收进子菜单，命令名保持英文，便于和终端里手敲的命令对应
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

async function commitAllChanges(dir: string): Promise<void> {
  if (!terminal) return;
  const text = await promptText("提交信息");
  if (!text) return;
  // 先暂存全部改动再提交，提交信息按当前 shell 的引号规则转义
  await terminal.run(dir, ["git add -A", `git commit -m ${terminal.quoteArg(text)}`]);
}
