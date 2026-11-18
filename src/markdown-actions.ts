import { EditorSelection, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export type MarkdownAction =
  | "bold"
  | "italic"
  | "strike"
  | "h1"
  | "h2"
  | "h3"
  | "bullet"
  | "ordered"
  | "quote"
  | "link"
  | "code";

function wrapSelection(view: EditorView, before: string, after: string): void {
  view.dispatch(
    view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to);
      if (text) {
        return {
          changes: [
            { from: range.from, insert: before },
            { from: range.to, insert: after },
          ],
          range: EditorSelection.range(
            range.from + before.length,
            range.to + before.length,
          ),
        };
      }
      return {
        changes: { from: range.from, insert: before + after },
        range: EditorSelection.cursor(range.from + before.length),
      };
    }),
    { userEvent: "input" },
  );
}

function selectedLines(state: EditorState): number[] {
  const numbers = new Set<number>();
  for (const range of state.selection.ranges) {
    const start = state.doc.lineAt(range.from).number;
    const end = state.doc.lineAt(range.to).number;
    for (let number = start; number <= end; number += 1) numbers.add(number);
  }
  return Array.from(numbers).sort((a, b) => a - b);
}

function togglePrefix(view: EditorView, prefix: string): void {
  const { state } = view;
  const changes = [];
  for (const number of selectedLines(state)) {
    const line = state.doc.line(number);
    if (line.text.startsWith(prefix)) {
      changes.push({ from: line.from, to: line.from + prefix.length, insert: "" });
    } else {
      changes.push({ from: line.from, insert: prefix });
    }
  }
  if (changes.length > 0) view.dispatch({ changes, userEvent: "input" });
}

function applyHeading(view: EditorView, prefix: string): void {
  const { state } = view;
  const changes = [];
  for (const number of selectedLines(state)) {
    const line = state.doc.line(number);
    const match = /^(#{1,6}\s+)/.exec(line.text);
    if (!match) {
      changes.push({ from: line.from, insert: prefix });
    } else if (match[1] === prefix) {
      changes.push({ from: line.from, to: line.from + match[1].length, insert: "" });
    } else {
      changes.push({ from: line.from, to: line.from + match[1].length, insert: prefix });
    }
  }
  if (changes.length > 0) view.dispatch({ changes, userEvent: "input" });
}

function applyOrderedList(view: EditorView): void {
  const { state } = view;
  const changes = [];
  let index = 1;
  for (const number of selectedLines(state)) {
    const line = state.doc.line(number);
    const match = /^(\d+\.\s+)/.exec(line.text);
    if (match) {
      changes.push({
        from: line.from,
        to: line.from + match[1].length,
        insert: `${index}. `,
      });
    } else {
      changes.push({ from: line.from, insert: `${index}. ` });
    }
    index += 1;
  }
  if (changes.length > 0) view.dispatch({ changes, userEvent: "input" });
}

function applyLink(view: EditorView): void {
  view.dispatch(
    view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to) || "链接文字";
      const insert = `[${text}](url)`;
      const urlFrom = range.from + text.length + 3;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(urlFrom, urlFrom + 3),
      };
    }),
    { userEvent: "input" },
  );
}

function applyCodeBlock(view: EditorView): void {
  const range = view.state.selection.main;
  const selected = view.state.sliceDoc(range.from, range.to);
  if (!selected) {
    view.dispatch({
      changes: { from: range.from, insert: "```\n\n```" },
      selection: EditorSelection.cursor(range.from + 4),
      userEvent: "input",
    });
    return;
  }
  view.dispatch({
    changes: [
      { from: range.from, insert: "```\n" },
      { from: range.to, insert: "\n```" },
    ],
    selection: EditorSelection.range(range.from + 4, range.to + 4),
    userEvent: "input",
  });
}

export function applyMarkdownAction(view: EditorView, action: MarkdownAction): void {
  switch (action) {
    case "bold":
      wrapSelection(view, "**", "**");
      break;
    case "italic":
      wrapSelection(view, "*", "*");
      break;
    case "strike":
      wrapSelection(view, "~~", "~~");
      break;
    case "h1":
      applyHeading(view, "# ");
      break;
    case "h2":
      applyHeading(view, "## ");
      break;
    case "h3":
      applyHeading(view, "### ");
      break;
    case "bullet":
      togglePrefix(view, "- ");
      break;
    case "ordered":
      applyOrderedList(view);
      break;
    case "quote":
      togglePrefix(view, "> ");
      break;
    case "link":
      applyLink(view);
      break;
    case "code":
      applyCodeBlock(view);
      break;
    default:
      break;
  }
}
