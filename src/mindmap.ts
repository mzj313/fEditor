//! 思维导图：三种格式解析成同一个树模型，渲染交给 mindmap-view。
//!
//! 各家思维导图没有通用标准，这里只做只读预览：
//! - `.xmind`：ZIP 压缩包，Zen/2020+ 用 content.json，XMind 8 用 content.xml
//! - `.mm`：FreeMind，纯 XML（`<node TEXT="...">` 递归）
//! - `.opml`：大纲交换格式，`<outline text="...">` 递归
//!
//! 解析层刻意保持极薄：只要能把层级和文本取出来，渲染层完全不感知来源。

import { unzipSync } from "fflate";

/** 统一的树节点；note 是备注，渲染时作为 hover 提示 */
export interface MindNode {
  title: string;
  note?: string;
  children: MindNode[];
}

/** .xmind 是二进制压缩包，走二进制预览通道 */
export function isXmind(name: string): boolean {
  return name.toLowerCase().endsWith(".xmind");
}

/** .mm / .opml 是纯文本 XML，保留编辑能力，预览通过 Ctrl+E 触发 */
export function isMindText(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".mm") || lower.endsWith(".opml");
}

function emptyNode(title: string, note?: string): MindNode {
  return { title: title.trim() || "(未命名)", note: note?.trim() || undefined, children: [] };
}

/** 一些文件在标题里塞了换行，统一压成空格，避免节点高度算出奇怪的值 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/* ---------------- XMind ---------------- */

/**
 * 解析 .xmind。
 * 先找 content.json（新格式），找不到再退回 content.xml（XMind 8）。
 * 两种格式的层级字段完全不同，所以分别有独立分支。
 */
export function parseXmind(bytes: Uint8Array): MindNode {
  const entries = unzipSync(bytes);
  const json = entries["content.json"];
  if (json) {
    return parseXmindJson(new TextDecoder().decode(json));
  }
  const xml = entries["content.xml"];
  if (xml) {
    return parseXmindXml(new TextDecoder().decode(xml));
  }
  throw new Error("文件里没有 content.json 或 content.xml，不是有效的 XMind 文件");
}

function parseXmindJson(text: string): MindNode {
  const raw = JSON.parse(text) as unknown;
  // Zen 的 content.json 是 sheet 数组；个别版本外层多包一层 { sheets: [...] }
  const sheets = Array.isArray(raw)
    ? raw
    : ((raw as { sheets?: unknown[] }).sheets ?? []);
  const first = sheets[0] as { rootTopic?: unknown } | undefined;
  if (!first?.rootTopic) throw new Error("content.json 里没有 rootTopic");
  return topicToNode(first.rootTopic as Record<string, unknown>);
}

function topicToNode(topic: Record<string, unknown>): MindNode {
  const title = typeof topic.title === "string" ? oneLine(topic.title) : "";
  const note = readXmindNote(topic);
  const node = emptyNode(title, note);
  const children = (topic.children ?? {}) as Record<string, unknown>;
  // attached 是挂在主节点下的子主题；detached 是自由主题，也一并展示
  for (const group of ["attached", "detached"]) {
    const list = children[group];
    if (!Array.isArray(list)) continue;
    for (const child of list) {
      if (child && typeof child === "object") {
        node.children.push(topicToNode(child as Record<string, unknown>));
      }
    }
  }
  return node;
}

function readXmindNote(topic: Record<string, unknown>): string | undefined {
  const notes = topic.notes as { plain?: { content?: string } } | undefined;
  const plain = notes?.plain?.content;
  return typeof plain === "string" ? oneLine(plain) : undefined;
}

function parseXmindXml(text: string): MindNode {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("content.xml 解析失败");
  const root = firstChildByLocalName(doc.documentElement, "sheet");
  const topic = root ? firstChildByLocalName(root, "topic") : null;
  if (!topic) throw new Error("content.xml 里没有 topic");
  return xmlTopicToNode(topic);
}

/** XML 带命名空间，querySelector 很难写，统一按 localName 手写遍历 */
function firstChildByLocalName(parent: Element, name: string): Element | null {
  for (const child of Array.from(parent.children)) {
    if (child.localName === name) return child;
  }
  return null;
}

function childrenByLocalName(parent: Element, name: string): Element[] {
  return Array.from(parent.children).filter((child) => child.localName === name);
}

function xmlTopicToNode(topic: Element): MindNode {
  const titleEl = firstChildByLocalName(topic, "title");
  const plain = firstChildByLocalName(topic, "notes");
  const noteText = plain ? firstChildByLocalName(plain, "plain")?.textContent ?? "" : "";
  const node = emptyNode(titleEl?.textContent ?? "", oneLine(noteText));

  for (const group of childrenByLocalName(topic, "children")) {
    const topics = firstChildByLocalName(group, "topics");
    if (!topics) continue;
    for (const child of childrenByLocalName(topics, "topic")) {
      node.children.push(xmlTopicToNode(child));
    }
  }
  return node;
}

/* ---------------- FreeMind (.mm) ---------------- */

export function parseFreemind(text: string): MindNode {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("不是有效的 FreeMind XML");
  const root = doc.getElementsByTagName("node")[0];
  if (!root) throw new Error("FreeMind 文件里没有 node");
  return mmNodeToNode(root);
}

function mmNodeToNode(element: Element): MindNode {
  const title = element.getAttribute("TEXT") ?? element.getAttribute("text") ?? "";
  const node = emptyNode(title);
  // 富文本节点的纯文本在 <richcontent TYPE="NODE"> 里，作为标题缺失时的兜底
  if (!title) {
    const rich = firstChildByLocalName(element, "richcontent");
    if (rich) node.title = oneLine(rich.textContent ?? "") || "(未命名)";
  }
  for (const child of childrenByLocalName(element, "node")) {
    node.children.push(mmNodeToNode(child));
  }
  return node;
}

/* ---------------- OPML ---------------- */

export function parseOpml(text: string): MindNode {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("不是有效的 OPML XML");
  const body = doc.getElementsByTagName("body")[0];
  const outline = body ? childrenByLocalName(body, "outline")[0] : null;
  if (!outline) throw new Error("OPML 文件里没有 outline");
  return opmlNodeToNode(outline);
}

function opmlNodeToNode(element: Element): MindNode {
  const title = element.getAttribute("text") ?? element.getAttribute("title") ?? "";
  const note = element.getAttribute("_note") ?? element.getAttribute("note") ?? undefined;
  const node = emptyNode(title, note);
  for (const child of childrenByLocalName(element, "outline")) {
    node.children.push(opmlNodeToNode(child));
  }
  return node;
}
