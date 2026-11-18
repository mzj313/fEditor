import type { FormatResult } from "./json-lang";

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 原文件以换行结尾时保持这个习惯，避免每次格式化都改掉末尾 */
function keepTrailingNewline(source: string, text: string): string {
  return source.endsWith("\n") ? `${text.replace(/\n+$/, "")}\n` : text.replace(/\n+$/, "");
}

/**
 * 两空格缩进重排 YAML。
 * 使用 yaml 的 Document API 而不是 parse/stringify，才能保留注释、锚点与键顺序。
 */
export async function formatYamlText(source: string): Promise<FormatResult> {
  if (source.trim() === "") return { ok: false, error: "内容为空" };

  const { parseDocument } = await import("yaml");
  const doc = parseDocument(source, { prettyErrors: true });
  if (doc.errors.length > 0) {
    // prettyErrors 已带行列号与出错位置片段，直接透传即可
    return { ok: false, error: doc.errors[0].message };
  }

  // lineWidth: 0 关闭自动折行，避免长字符串被重新排版
  const text = doc.toString({ indent: 2, lineWidth: 0 });
  return { ok: true, text: keepTrailingNewline(source, text) };
}

/** 校验 YAML 语法，返回可读错误信息；语法正确时返回 null。 */
export async function checkYaml(source: string): Promise<string | null> {
  const result = await formatYamlText(source);
  return result.ok ? null : result.error;
}

/**
 * 重排 TOML。
 * smol-toml 的 stringify 不保留注释，所以调用方需要先向用户确认。
 */
export async function formatTomlText(source: string): Promise<FormatResult> {
  if (source.trim() === "") return { ok: false, error: "内容为空" };

  const { parse, stringify } = await import("smol-toml");
  let data;
  try {
    data = parse(source);
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }

  try {
    const text = stringify(data);
    return { ok: true, text: keepTrailingNewline(source, text) };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

/** 校验 TOML 语法，返回可读错误信息；语法正确时返回 null。 */
export async function checkToml(source: string): Promise<string | null> {
  const { parse } = await import("smol-toml");
  try {
    parse(source);
    return null;
  } catch (error) {
    return errorText(error);
  }
}
