import { unzipSync } from "fflate";

/** WordprocessingML 命名空间，DOMParser 解析后必须用 NS 版查询接口 */
const WML = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export interface DocxTocEntry {
  /** 标题级别：outlineLvl 是 0 基，这里统一转成 1 基（1~9） */
  level: number;
  text: string;
  /** 该标题段落在正文段落（排除文本框）中的序号，用于映射 docx-preview 渲染出的 DOM */
  paraIndex: number;
}

/** 样式表里每个样式的关键信息：样式名与大纲级别 */
interface StyleInfo {
  name: string;
  outlineLvl: number | null;
}

/**
 * 从 docx 字节里提取按文档顺序排列的标题。
 * docx-preview 不会把 Word 标题渲染成 h1~h6，只能回到 OOXML 本身：
 * styles.xml 建立样式 → 级别映射，document.xml 按段落顺序识别标题。
 */
export function extractDocxHeadings(bytes: Uint8Array): DocxTocEntry[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    return [];
  }
  const docXml = files["word/document.xml"];
  if (!docXml) return [];

  const parser = new DOMParser();
  const styleLevels = parseStyleLevels(
    files["word/styles.xml"] ? parser.parseFromString(new TextDecoder().decode(files["word/styles.xml"]), "application/xml") : null,
  );
  const doc = parser.parseFromString(new TextDecoder().decode(docXml), "application/xml");

  const body = doc.getElementsByTagNameNS(WML, "body")[0];
  if (!body) return [];

  const entries: DocxTocEntry[] = [];
  let paraIndex = 0;
  // getElementsByTagNameNS 按文档顺序返回，天然覆盖表格内的段落
  for (const para of Array.from(body.getElementsByTagNameNS(WML, "p"))) {
    // 文本框（txbxContent）里的段落 docx-preview 基本不渲染，
    // 跳过计数，避免正文段落的 DOM 序号错位
    if (insideTextbox(para)) continue;
    const level = headingLevelOf(para, styleLevels);
    if (level > 0) {
      const text = paraText(para).trim();
      if (text) entries.push({ level, text, paraIndex });
    }
    paraIndex += 1;
  }
  return entries;
}

/** 样式表关键信息：直接定义的级别映射与 basedOn 继承链 */
interface StyleMaps {
  levels: Map<string, number>;
  parents: Map<string, string>;
}

/**
 * 收集样式表中 styleId → 级别的映射：outlineLvl 优先，内置 heading 样式名兜底。
 * 自定义标题样式常通过 basedOn 继承"标题 1"而自身不带 outlineLvl，
 * 级别查询需要沿继承链追溯。
 */
function parseStyleLevels(stylesDoc: Document | null): StyleMaps {
  const maps: StyleMaps = { levels: new Map(), parents: new Map() };
  if (!stylesDoc) return maps;
  for (const style of Array.from(stylesDoc.getElementsByTagNameNS(WML, "style"))) {
    const styleId = localAttr(style, "styleId");
    if (!styleId) continue;
    const nameEl = style.getElementsByTagNameNS(WML, "name")[0];
    const name = nameEl ? localAttr(nameEl, "val") ?? "" : "";
    const outlineEl = style.getElementsByTagNameNS(WML, "outlineLvl")[0];
    const outline = outlineEl ? Number(localAttr(outlineEl, "val")) : NaN;
    // outlineLvl 覆盖到 1~9 级；中文版内置标题的 styleId 是 "1"/"2"，样式名仍是 "heading N"
    const named = /^(?:heading|标题)\s*(\d)$/i.exec(name);
    if (Number.isInteger(outline) && outline >= 0 && outline < 9) {
      maps.levels.set(styleId, outline + 1);
    } else if (named) {
      maps.levels.set(styleId, Number(named[1]));
    }
    const basedOn = style.getElementsByTagNameNS(WML, "basedOn")[0];
    const parentId = basedOn ? localAttr(basedOn, "val") : null;
    if (parentId) maps.parents.set(styleId, parentId);
  }
  return maps;
}

/** 沿 basedOn 链追溯级别；直接定义优先，深度限制防御样式环 */
function resolveStyleLevel(maps: StyleMaps, styleId: string, depth = 0): number {
  const direct = maps.levels.get(styleId);
  if (direct !== undefined) return direct;
  const parent = maps.parents.get(styleId);
  if (parent && depth < 8) return resolveStyleLevel(maps, parent, depth + 1);
  return 0;
}

/** 段落级 outlineLvl 优先于样式映射；两者都缺就不是标题 */
function headingLevelOf(para: Element, styleLevels: StyleMaps): number {
  const pPr = para.getElementsByTagNameNS(WML, "pPr")[0];
  if (!pPr) return 0;
  const inlineOutline = pPr.getElementsByTagNameNS(WML, "outlineLvl")[0];
  if (inlineOutline) {
    const lvl = Number(localAttr(inlineOutline, "val"));
    if (Number.isInteger(lvl) && lvl >= 0 && lvl < 9) return lvl + 1;
    // outlineLvl 明确标注为 body text（val 很大）时不再回退样式
    if (Number.isInteger(lvl)) return 0;
  }
  const pStyle = pPr.getElementsByTagNameNS(WML, "pStyle")[0];
  const styleId = pStyle ? localAttr(pStyle, "val") : null;
  return styleId ? resolveStyleLevel(styleLevels, styleId) : 0;
}

/** 段落可见文本：拼接所有 w:t，制表符转空格 */
function paraText(para: Element): string {
  let text = "";
  for (const t of Array.from(para.getElementsByTagNameNS(WML, "t"))) {
    text += t.textContent ?? "";
  }
  return text.replace(/\t/g, " ");
}

/** XML 侧没有 parentElement，沿 parentNode 向上找文本框祖先 */
function insideTextbox(node: Element): boolean {
  let cur: Node | null = node.parentNode;
  while (cur) {
    const local = cur.nodeType === 1 ? (cur as Element).localName ?? "" : "";
    if (local === "txbxContent") return true;
    cur = cur.parentNode;
  }
  return false;
}

/** OOXML 属性都带 w: 前缀，用 localName 匹配避免前缀差异 */
function localAttr(el: Element, name: string): string | null {
  for (const attr of Array.from(el.attributes)) {
    if (attr.localName === name) return attr.value;
  }
  return null;
}
