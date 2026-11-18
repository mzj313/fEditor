import { StreamLanguage, type StringStream } from "@codemirror/language";

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
