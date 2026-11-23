import { StreamLanguage, type StringStream } from "@codemirror/language";
import type { EditorState, Text } from "@codemirror/state";

interface JsonState {
  // 留空占位：当前实现不需要跨 token 状态，保持接口一致即可
  depth: number;
}

/**
 * 轻量 JSON 词法分析。
 * 不引入 @codemirror/lang-json，避免新增依赖；token 名称使用 CodeMirror 标准 tag，
 * 这样能直接复用 defaultHighlightStyle 的配色。
 */
const jsonStream = {
  startState(): JsonState {
    return { depth: 0 };
  },
  token(stream: StringStream, _state: JsonState): string | null {
    if (stream.eatSpace()) return null;

    const ch = stream.peek();
    if (ch === '"') {
      // 手动扫描字符串，正确处理 \" 与 \\ 转义，避免正则回溯问题
      stream.next();
      let escaped = false;
      while (!stream.eol()) {
        const current = stream.next();
        if (escaped) {
          escaped = false;
          continue;
        }
        if (current === "\\") {
          escaped = true;
          continue;
        }
        if (current === '"') break;
      }
      // 字符串后面紧跟冒号说明它是对象键，用不同颜色区分
      const rest = stream.string.slice(stream.pos).trimStart();
      return rest.startsWith(":") ? "propertyName" : "string";
    }

    if (ch !== undefined && (ch === "-" || (ch >= "0" && ch <= "9"))) {
      stream.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      return "number";
    }

    if (stream.match("true") || stream.match("false")) return "bool";
    if (stream.match("null")) return "null";
    if (stream.match(/[{}\[\],:]/)) return "punctuation";

    // 无法识别的字符按普通文本消费，保证不会死循环
    stream.next();
    return null;
  },
};

export const jsonLanguage = StreamLanguage.define(jsonStream);

/* ---- JSON 折叠 ---- */

interface FoldRange {
  from: number;
  to: number;
}

/** 缓存：每个文档版本只做一次全量括号配对扫描；行起始位置 -> 该行的折叠范围 */
const foldRangesCache = new WeakMap<Text, Map<number, FoldRange>>();

/**
 * 全文扫描括号配对（跳过字符串与转义），得到每行可折叠的范围。
 * 跨行的对象/数组才可折叠；同一行出现多个开括号时只记录第一个。
 */
function computeFoldRanges(doc: Text): Map<number, FoldRange> {
  const map = new Map<number, FoldRange>();
  const stack: { open: string; openPos: number; lineStart: number }[] = [];
  let inString = false;
  let escaped = false;
  for (let pos = 0; pos < doc.length; pos++) {
    const ch = doc.sliceString(pos, pos + 1);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push({ open: ch, openPos: pos, lineStart: doc.lineAt(pos).from });
      continue;
    }
    const top = stack[stack.length - 1];
    const paired = (ch === "}" && top?.open === "{") || (ch === "]" && top?.open === "[");
    if (paired) {
      stack.pop();
      // 开括号与闭合括号不在同一行才折叠；同一起始行只记录第一个范围
      if (!map.has(top.lineStart) && doc.lineAt(pos).from !== top.lineStart) {
        map.set(top.lineStart, { from: top.openPos + 1, to: pos });
      }
    }
  }
  return map;
}

/**
 * JSON 折叠服务：语法树是自定义 StreamLanguage 生成、不带折叠信息，
 * 这里通过 foldService 按行提供 { [ ] } 的折叠范围给 foldGutter 使用。
 */
export const jsonFoldService = (
  state: EditorState,
  lineStart: number,
  _lineEnd: number,
): FoldRange | null => {
  let ranges = foldRangesCache.get(state.doc);
  if (!ranges) {
    ranges = computeFoldRanges(state.doc);
    foldRangesCache.set(state.doc, ranges);
  }
  return ranges.get(lineStart) ?? null;
};

export type FormatResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/**
 * 用两空格缩进重排 JSON。
 * 直接复用 JSON.parse 的校验，格式错误时把浏览器给出的位置信息透传给调用方。
 */
export function formatJsonText(source: string): FormatResult {
  if (source.trim() === "") {
    return { ok: false, error: "内容为空" };
  }
  try {
    const value: unknown = JSON.parse(source);
    const formatted = JSON.stringify(value, null, 2);
    // 原文件以换行结尾时保持这个习惯，避免每次格式化都改掉末尾
    const tail = source.endsWith("\n") ? "\n" : "";
    return { ok: true, text: formatted + tail };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
