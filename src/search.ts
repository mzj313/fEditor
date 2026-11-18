import type { EditorView } from "@codemirror/view";
import * as search from "@codemirror/search";

// 编辑器主模块已经静态引入了 @codemirror/search（用于选中内容高亮），
// 这里再动态加载只会让打包器把同一模块拆不开，因此改为静态引用
export function searchModule(): Promise<typeof import("@codemirror/search")> {
  return Promise.resolve(search);
}

function focusReplaceInput(view: EditorView): void {
  // 默认面板存在替换输入框时优先聚焦它
  window.setTimeout(() => {
    const input = view.dom.querySelector(
      '.cm-search input[name="replace"]',
    ) as HTMLInputElement | null;
    input?.focus();
  }, 60);
}

export async function openSearch(view: EditorView, withReplace: boolean): Promise<void> {
  const mod = await searchModule();
  mod.openSearchPanel(view);
  if (withReplace) focusReplaceInput(view);
}

export async function findNext(view: EditorView): Promise<boolean> {
  const mod = await searchModule();
  return mod.findNext(view);
}

export async function findPrevious(view: EditorView): Promise<boolean> {
  const mod = await searchModule();
  return mod.findPrevious(view);
}

export async function replaceAllMatches(view: EditorView): Promise<boolean> {
  const mod = await searchModule();
  return mod.replaceAll(view);
}
