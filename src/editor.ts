import { Compartment, EditorSelection, EditorState, type Extension, type SelectionRange } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from "@codemirror/commands";
import { StreamLanguage, bracketMatching, HighlightStyle, defaultHighlightStyle, indentOnInput, syntaxHighlighting, foldGutter, foldService } from "@codemirror/language";
import { highlightSelectionMatches } from "@codemirror/search";
import { tags } from "@lezer/highlight";
import { jsonLanguage, jsonFoldService } from "./json-lang";
import { openFindDialog } from "./find-dialog";
import { searchModule } from "./search";
import { hoverTranslate } from "./translate-tooltip";
import { markdownImagePaste } from "./md-image";

export interface EditorHooks {
  onChange(): void;
  onCursor(): void;
}

export const wrapCompartment = new Compartment();
const languageCompartment = new Compartment();
const searchCompartment = new Compartment();
const readOnlyCompartment = new Compartment();
const themeCompartment = new Compartment();
/** 悬停翻译用独立 compartment，设置里改弹出延迟后可即时生效 */
const hoverTranslateCompartment = new Compartment();

/** 类似 Sublime 默认配色（Monokai）：深灰底 + 粉/绿/黄/紫的高对比色 */
const darkHighlight = HighlightStyle.define([
  { tag: tags.comment, color: "#75715e" },
  {
    tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.modifier, tags.definitionKeyword],
    color: "#f92672",
  },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "#e6db74" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "#ae81ff" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "#a6e22e",
  },
  { tag: [tags.className, tags.typeName, tags.namespace, tags.standard(tags.name)], color: "#66d9ef" },
  { tag: [tags.propertyName, tags.attributeName, tags.variableName], color: "#f8f8f2" },
  { tag: [tags.tagName, tags.angleBracket], color: "#f92672" },
  { tag: [tags.heading, tags.strong], color: "#a6e22e", fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: [tags.link, tags.url], color: "#66d9ef", textDecoration: "underline" },
  { tag: [tags.meta, tags.processingInstruction], color: "#75715e" },
  { tag: tags.invalid, color: "#960050" },
]);

const darkTheme = [
  EditorView.theme(
    {
      "&": { backgroundColor: "#272822", color: "#f8f8f2" },
      ".cm-content": { caretColor: "#f8f8f2" },
      ".cm-gutters": {
        backgroundColor: "#1e1f1c",
        color: "#8f908a",
        borderRight: "1px solid #3e3d32",
      },
      ".cm-activeLine": { backgroundColor: "rgba(255, 255, 255, 0.04)" },
      ".cm-activeLineGutter": { backgroundColor: "rgba(255, 255, 255, 0.06)", color: "#f8f8f2" },
      ".cm-cursor": { borderLeftColor: "#f8f8f2" },
      ".cm-panels": { backgroundColor: "#1e1f1c", color: "#f8f8f2" },
      ".cm-tooltip": { backgroundColor: "#1e1f1c", border: "1px solid #3e3d32", color: "#f8f8f2" },
      ".cm-searchMatch": { backgroundColor: "rgba(230, 219, 116, 0.28)" },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(230, 219, 116, 0.5)" },
    },
    { dark: true },
  ),
  syntaxHighlighting(darkHighlight),
];

/** 新建编辑器状态时使用当前主题；切换主题时由 setTheme 重新配置已打开的视图 */
let darkMode = false;

/**
 * 列块模式：开启后普通拖动即为矩形选择；关闭时按住 Alt 仍可临时矩形选择。
 * 用模块级变量配合闭包，所有标签页共享同一开关，无需重新配置扩展。
 */
let blockMode = false;

// 双击（detail 2）要留给选词，否则会被矩形选择接管
const blockFilter = (event: MouseEvent): boolean =>
  event.button === 0 && event.detail <= 1 && (blockMode || event.altKey);

/**
 * 自建矩形选择样式，替换内置 rectangularSelection。
 * 内置实现按「字符列」定位：全角字符（中文）只算 1 列却占 2 个字宽，
 * 每行前面的全角字符数量不同就会逐行累积错位，看起来成阶梯状。
 * 这里改为每行都用同一个屏幕 x 去取最近的字符边界，行与行之间不再累积偏差。
 */
function blockSelectionStyle(filter: (event: MouseEvent) => boolean): Extension {
  return EditorView.mouseSelectionStyle.of((view, event) => {
    if (!filter(event)) return null;
    const anchorX = event.clientX;
    const anchorY = event.clientY;
    return {
      get(current: MouseEvent, _extend: boolean, multiple: boolean) {
        const ranges = rectangleRanges(view, anchorX, anchorY, current.clientX, current.clientY);
        if (!ranges.length) return view.state.selection;
        return multiple
          ? EditorSelection.create(ranges.concat(view.state.selection.ranges))
          : EditorSelection.create(ranges);
      },
      update() {
        return false;
      },
    };
  });
}

/** 按两点的屏幕坐标，为覆盖到的每一行各生成一个选区 */
function rectangleRanges(
  view: EditorView,
  anchorX: number,
  anchorY: number,
  currentX: number,
  currentY: number,
): SelectionRange[] {
  const start = view.posAtCoords({ x: anchorX, y: anchorY }, false);
  const end = view.posAtCoords({ x: currentX, y: currentY }, false);
  if (start === null || end === null) return [];

  const doc = view.state.doc;
  const startLine = doc.lineAt(start).number;
  const endLine = doc.lineAt(end).number;
  const first = Math.min(startLine, endLine);
  const last = Math.max(startLine, endLine);

  // 文档顶部在屏幕上的位置，用来给可视区外的行估算纵向坐标
  const scrollerRect = view.scrollDOM.getBoundingClientRect();
  const docTop = scrollerRect.top - view.scrollDOM.scrollTop;

  const ranges: SelectionRange[] = [];
  for (let number = first; number <= last; number++) {
    const line = doc.line(number);
    const coords = view.coordsAtPos(line.from);
    const y = coords
      ? (coords.top + coords.bottom) / 2
      : docTop + view.lineBlockAt(line.from).top + view.defaultLineHeight / 2;
    const from = view.posAtCoords({ x: anchorX, y }, false) ?? line.from;
    const to = view.posAtCoords({ x: currentX, y }, false) ?? line.to;
    ranges.push(EditorSelection.range(Math.min(from, to), Math.max(from, to)));
  }
  return ranges;
}

export class EditorController {
  readonly view: EditorView;
  private hooks: EditorHooks;
  private searchReady = false;

  constructor(parent: HTMLElement, hooks: EditorHooks) {
    this.hooks = hooks;
    this.view = new EditorView({
      state: EditorState.create({ doc: "", extensions: this.extensions(false) }),
      parent,
    });
  }

  private extensions(readOnly: boolean): Extension[] {
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      highlightActiveLine(),
      drawSelection(),
      dropCursor(),
      crosshairCursor(),
      EditorState.allowMultipleSelections.of(true),
      blockSelectionStyle(blockFilter),
      // Markdown 里粘贴图片时转存 assets 并插入引用，其他文件不受影响
      markdownImagePaste(),
      history(),
      indentOnInput(),
      bracketMatching(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      // 选中文本后把全文相同内容一起标出来，双击选词即可看出所有出现位置
      highlightSelectionMatches(),
      themeCompartment.of(darkMode ? darkTheme : []),
      wrapCompartment.of(EditorView.lineWrapping),
      languageCompartment.of([]),
      searchCompartment.of([]),
      hoverTranslateCompartment.of(hoverTranslate()),
      readOnlyCompartment.of(readOnly ? EditorState.readOnly.of(true) : []),
      keymap.of([
        { key: "Mod-Shift-l", run: () => this.splitLinesIntoCursors() },
        { key: "Mod-Alt-ArrowUp", run: () => this.addCursor(-1) },
        { key: "Mod-Alt-ArrowDown", run: () => this.addCursor(1) },
        { key: "Escape", run: () => this.collapseCursors() },
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) this.hooks.onChange();
        if (update.docChanged || update.selectionSet) this.hooks.onCursor();
      }),
    ];
  }

  createState(text: string, options: { readOnly?: boolean; cursor?: number | null } = {}): EditorState {
    const position = Math.max(0, Math.min(options.cursor ?? 0, text.length));
    return EditorState.create({
      doc: text,
      selection: EditorSelection.single(position),
      extensions: this.extensions(options.readOnly ?? false),
    });
  }

  get state(): EditorState {
    return this.view.state;
  }

  setState(state: EditorState): void {
    this.view.setState(state);
  }

  get scrollTop(): number {
    return this.view.scrollDOM.scrollTop;
  }

  setScrollTop(value: number): void {
    this.view.scrollDOM.scrollTop = value;
  }

  focus(): void {
    this.view.focus();
  }

  /** 跳到指定行（1 开始），用于全文搜索结果定位 */
  gotoLine(line: number): void {
    const doc = this.view.state.doc;
    const number = Math.max(1, Math.min(line, doc.lines));
    this.view.dispatch({
      selection: EditorSelection.single(doc.line(number).from),
      scrollIntoView: true,
    });
    this.view.focus();
  }

  undo(): void {
    undo(this.view);
  }

  redo(): void {
    redo(this.view);
  }

  /** 切换列块模式；对所有标签页生效 */
  setBlockMode(on: boolean): void {
    blockMode = on;
  }

  setWrap(on: boolean): void {
    this.view.dispatch({
      effects: wrapCompartment.reconfigure(on ? EditorView.lineWrapping : []),
    });
  }

  /** 更新悬停翻译弹出延迟；重挂扩展让新 hoverTime 立即生效 */
  setHoverTranslate(): void {
    this.view.dispatch({
      effects: hoverTranslateCompartment.reconfigure(hoverTranslate()),
    });
  }

  /** 切换主题；之后新建的标签状态会沿用同一主题 */
  setTheme(dark: boolean): void {
    darkMode = dark;
    this.view.dispatch({
      effects: themeCompartment.reconfigure(dark ? darkTheme : []),
    });
  }

  async ensureMarkdown(): Promise<void> {
    const { markdown } = await import("@codemirror/lang-markdown");
    this.view.dispatch({ effects: languageCompartment.reconfigure(markdown()) });
  }

  /** JSON 高亮不依赖额外包，直接同步 reconfigure 即可。 */
  ensureJson(): void {
    // 挂上折叠 gutter 与括号配对的折叠服务，让 JSON 左侧行号可收缩展开
    this.view.dispatch({
      effects: languageCompartment.reconfigure([
        jsonLanguage,
        foldGutter(),
        foldService.of(jsonFoldService),
      ]),
    });
  }

  /** YAML 用官方语法包，动态加载以减小首屏体积。 */
  async ensureYaml(): Promise<void> {
    const { yaml } = await import("@codemirror/lang-yaml");
    this.view.dispatch({ effects: languageCompartment.reconfigure(yaml()) });
  }

  /** TOML 官方没有独立语法包，复用 legacy-modes 的流式词法。 */
  async ensureToml(): Promise<void> {
    const { toml } = await import("@codemirror/legacy-modes/mode/toml");
    this.view.dispatch({
      effects: languageCompartment.reconfigure(StreamLanguage.define(toml)),
    });
  }

  /** 用新文本替换整篇或指定区间；走 dispatch 才能进入撤销历史。 */
  replaceText(text: string, range?: { from: number; to: number }): void {
    const target = range ?? { from: 0, to: this.view.state.doc.length };
    this.view.dispatch({
      changes: { from: target.from, to: target.to, insert: text },
      userEvent: "input",
    });
    this.view.focus();
  }

  private async ensureSearch(): Promise<void> {
    if (this.searchReady) return;
    const mod = await searchModule();
    this.view.dispatch({
      // 只装搜索状态与全文高亮；界面用自建弹框，因此不再挂 searchKeymap，
      // 避免 Ctrl+F 先弹出 CodeMirror 自带的顶部搜索条
      effects: searchCompartment.reconfigure([mod.search()]),
    });
    this.searchReady = true;
  }

  async openSearch(withReplace: boolean): Promise<void> {
    await this.ensureSearch();
    openFindDialog(this.view, withReplace);
  }

  addCursor(direction: 1 | -1): boolean {
    const state = this.view.state;
    const ranges = state.selection.ranges;
    const base = ranges[ranges.length - 1];
    const line = state.doc.lineAt(base.head);
    const column = base.head - line.from;
    const targetNumber = line.number + direction;
    if (targetNumber < 1 || targetNumber > state.doc.lines) return true;

    const target = state.doc.line(targetNumber);
    const position = Math.min(target.from + column, target.to);
    const positions = ranges.map((range) => range.head);
    if (positions.includes(position)) return true;
    positions.push(position);
    positions.sort((a, b) => a - b);

    this.view.dispatch({
      selection: EditorSelection.create(positions.map((p) => EditorSelection.cursor(p))),
      scrollIntoView: true,
    });
    this.view.focus();
    return true;
  }

  splitLinesIntoCursors(): boolean {
    const state = this.view.state;
    const positions: number[] = [];
    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from).number;
      const last = state.doc.lineAt(range.to).number;
      for (let number = first; number <= last; number += 1) {
        positions.push(state.doc.line(number).from);
      }
    }
    const unique = Array.from(new Set(positions)).sort((a, b) => a - b);
    if (unique.length <= 1) return true;

    this.view.dispatch({
      selection: EditorSelection.create(unique.map((p) => EditorSelection.cursor(p))),
      scrollIntoView: true,
    });
    this.view.focus();
    return true;
  }

  collapseCursors(): boolean {
    if (this.view.state.selection.ranges.length <= 1) return false;
    this.view.dispatch({
      selection: EditorSelection.single(this.view.state.selection.main.head),
      scrollIntoView: true,
    });
    this.view.focus();
    return true;
  }
}
