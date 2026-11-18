//! 思维导图只读渲染：左右双分支布局 + 折叠展开 + 缩放平移。
//!
//! 只负责画，不认识任何文件格式；输入永远是 mindmap.ts 里统一的 MindNode。
//! 布局算法是按需计算：折叠状态一变就整棵树重新测量、重新定位。

import type { MindNode } from "./mindmap";

const SVG_NS = "http://www.w3.org/2000/svg";
const FONT = "13px system-ui, -apple-system, 'Segoe UI', sans-serif";
/** 单个节点最宽多少像素，超过就换行 */
const MAX_TEXT_WIDTH = 168;
const LINE_HEIGHT = 18;
const PAD_X = 10;
const PAD_Y = 7;
const GAP_X = 42;
const GAP_Y = 12;
const MIN_NODE_HEIGHT = 30;
const PADDING = 40;
const MIN_SCALE = 0.15;
const MAX_SCALE = 3;

interface Laid {
  node: MindNode;
  depth: number;
  lines: string[];
  width: number;
  height: number;
  x: number;
  y: number;
  collapsed: boolean;
  children: Laid[];
  /** 这棵子树占用的垂直高度，用于把子节点居中排布 */
  subtree: number;
}

/** 每次渲染后登记清理函数，切标签时释放监听，避免叠加上一次的对象 */
let cleanup: (() => void) | null = null;

export function disposeMindmap(): void {
  cleanup?.();
  cleanup = null;
}

export function renderMindmap(host: HTMLElement, root: MindNode): void {
  disposeMindmap();
  const ctx = createMeasureContext();
  const collapsed = new Set<MindNode>();

  const stage = document.createElement("div");
  stage.className = "mind-stage";
  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("class", "mind-svg");
  const viewport = document.createElementNS(SVG_NS, "g") as SVGGElement;
  svg.appendChild(viewport);
  stage.appendChild(svg);

  const buttons = buildButtons();
  stage.appendChild(buttons.element);
  host.replaceChildren(stage);

  // 平移缩放的当前状态；fit 之后才知道内容尺寸，所以先给默认值
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  /** 用户手动缩放/平移过就不再自动适配，避免窗口一动就把视角抢回去 */
  let userAdjusted = false;

  const draw = (): void => {
    const laid = buildTree(root, 0, collapsed, ctx);
    layoutTree(laid);
    viewport.replaceChildren(...renderNodes(laid, collapsed, draw));
    const box = bounds(laid);
    if (!userAdjusted) fit(box);
    applyTransform();
  };

  const fit = (box: { x: number; y: number; width: number; height: number }): void => {
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    const k = Math.min(
      1,
      (width - PADDING * 2) / Math.max(1, box.width),
      (height - PADDING * 2) / Math.max(1, box.height),
    );
    scale = Math.max(MIN_SCALE, k);
    offsetX = width / 2 - (box.x + box.width / 2) * scale;
    offsetY = height / 2 - (box.y + box.height / 2) * scale;
  };

  const applyTransform = (): void => {
    viewport.setAttribute(
      "transform",
      `translate(${offsetX.toFixed(2)} ${offsetY.toFixed(2)}) scale(${scale.toFixed(4)})`,
    );
  };

  /** 以指针位置为锚点缩放，手感接近地图类应用 */
  const zoomAt = (clientX: number, clientY: number, factor: number): void => {
    const rect = svg.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    if (next === scale) return;
    offsetX = px - ((px - offsetX) / scale) * next;
    offsetY = py - ((py - offsetY) / scale) * next;
    scale = next;
    userAdjusted = true;
    applyTransform();
    buttons.setZoom(scale);
  };

  const setScale = (next: number): void => {
    const rect = svg.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, next / scale);
  };

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    // 触摸板捏合（WebView2 转成 ctrl+wheel 像素流）与普通滚轮都在这里缩放，
    // 倍率与像素增量成比例；触摸板单次 delta 只有几像素，按 1.12 阶梯会一步跳很多档
    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    zoomAt(event.clientX, event.clientY, Math.exp(-delta * 0.002));
  };
  svg.addEventListener("wheel", onWheel, { passive: false });

  // 空白处拖动平移；落在节点上的拖动交给点击处理
  let drag: { x: number; y: number; ox: number; oy: number } | null = null;
  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    if ((event.target as Element).closest(".mind-node")) return;
    drag = { x: event.clientX, y: event.clientY, ox: offsetX, oy: offsetY };
    svg.setPointerCapture(event.pointerId);
    stage.classList.add("panning");
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (!drag) return;
    offsetX = drag.ox + (event.clientX - drag.x);
    offsetY = drag.oy + (event.clientY - drag.y);
    userAdjusted = true;
    applyTransform();
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (!drag) return;
    drag = null;
    svg.releasePointerCapture(event.pointerId);
    stage.classList.remove("panning");
  };
  svg.addEventListener("pointerdown", onPointerDown);
  svg.addEventListener("pointermove", onPointerMove);
  svg.addEventListener("pointerup", onPointerUp);
  svg.addEventListener("pointercancel", onPointerUp);

  // 容器尺寸变化时重新适配，预览区被拖动缩放时不会留下一半空白。
  // 界面缩放会连续触发 resize，这里防抖：只在尺寸稳定后重建一次布局，
  // 否则每一帧都要重新测量文字、重建整棵 SVG，拖动手感会明显发卡。
  let resizeTimer: number | null = null;
  const observer = new ResizeObserver(() => {
    if (userAdjusted) return;
    if (resizeTimer !== null) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      resizeTimer = null;
      const laid = buildTree(root, 0, collapsed, ctx);
      layoutTree(laid);
      fit(bounds(laid));
      applyTransform();
    }, 120);
  });
  observer.observe(host);

  buttons.onFit = () => {
    userAdjusted = false;
    const laid = buildTree(root, 0, collapsed, ctx);
    layoutTree(laid);
    fit(bounds(laid));
    applyTransform();
    buttons.setZoom(scale);
  };
  buttons.onExpandAll = () => {
    collapsed.clear();
    userAdjusted = false;
    draw();
    buttons.setZoom(scale);
  };
  buttons.onCollapseTo = (depth: number) => {
    collapsed.clear();
    collectBeyond(root, 0, depth, collapsed);
    userAdjusted = false;
    draw();
    buttons.setZoom(scale);
  };
  buttons.onZoomIn = () => setScale(scale * 1.2);
  buttons.onZoomOut = () => setScale(scale / 1.2);

  draw();
  buttons.setZoom(scale);

  cleanup = () => {
    if (resizeTimer !== null) window.clearTimeout(resizeTimer);
    observer.disconnect();
    svg.removeEventListener("wheel", onWheel);
    svg.removeEventListener("pointerdown", onPointerDown);
    svg.removeEventListener("pointermove", onPointerMove);
    svg.removeEventListener("pointerup", onPointerUp);
    svg.removeEventListener("pointercancel", onPointerUp);
    host.replaceChildren();
  };
}

/* ---------------- 测量与换行 ---------------- */

function createMeasureContext(): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建文本测量上下文");
  ctx.font = FONT;
  return ctx;
}

const CJK = /[\u3000-\u9fff\uff00-\uffef]/;

/**
 * 按像素宽度换行：中日韩逐字断行，西文尽量在空格处断，
 * 单个超长单词（如 URL）才硬切，避免整行溢出节点框。
 */
function wrapText(ctx: CanvasRenderingContext2D, text: string): string[] {
  const chars = Array.from(text);
  const lines: string[] = [];
  let line = "";
  let lastSpace = -1;

  for (const ch of chars) {
    const next = line + ch;
    if (ctx.measureText(next).width <= MAX_TEXT_WIDTH) {
      if (ch === " ") lastSpace = line.length;
      line = next;
      continue;
    }
    if (CJK.test(ch)) {
      lines.push(line);
      line = ch;
      lastSpace = -1;
      continue;
    }
    if (lastSpace > 0) {
      lines.push(line.slice(0, lastSpace));
      line = line.slice(lastSpace + 1) + ch;
      lastSpace = -1;
      continue;
    }
    lines.push(line);
    line = ch;
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

/* ---------------- 布局 ---------------- */

function buildTree(
  node: MindNode,
  depth: number,
  collapsed: Set<MindNode>,
  ctx: CanvasRenderingContext2D,
): Laid {
  const lines = wrapText(ctx, node.title);
  const textWidth = Math.max(
    24,
    ...lines.map((line) => ctx.measureText(line).width),
  );
  const isCollapsed = collapsed.has(node) && node.children.length > 0;
  return {
    node,
    depth,
    lines,
    width: Math.ceil(textWidth + PAD_X * 2),
    height: Math.max(MIN_NODE_HEIGHT, lines.length * LINE_HEIGHT + PAD_Y * 2),
    x: 0,
    y: 0,
    collapsed: isCollapsed,
    children: isCollapsed
      ? []
      : node.children.map((child) => buildTree(child, depth + 1, collapsed, ctx)),
    subtree: 0,
  };
}

/** 自底向上算子树高度，父节点据此把子节点整体居中 */
function layoutTree(root: Laid): void {
  measureSubtree(root);
  root.x = 0;
  root.y = -root.height / 2;
  // 根节点分成左右两簇，其余节点跟随父节点所在的一侧
  const half = Math.ceil(root.children.length / 2);
  placeGroup(root, root.children.slice(0, half), 1);
  placeGroup(root, root.children.slice(half), -1);
}

function measureSubtree(laid: Laid): number {
  if (laid.children.length === 0) {
    laid.subtree = laid.height;
    return laid.subtree;
  }
  let total = 0;
  for (const child of laid.children) total += measureSubtree(child);
  laid.subtree = Math.max(laid.height, total + GAP_Y * (laid.children.length - 1));
  return laid.subtree;
}

function placeGroup(parent: Laid, group: Laid[], side: 1 | -1): void {
  if (group.length === 0) return;
  let total = 0;
  for (const child of group) total += child.subtree;
  total += GAP_Y * (group.length - 1);

  let cursor = parent.y + parent.height / 2 - total / 2;
  for (const child of group) {
    child.x = side === 1 ? parent.x + parent.width + GAP_X : parent.x - GAP_X - child.width;
    child.y = cursor + child.subtree / 2 - child.height / 2;
    cursor += child.subtree + GAP_Y;
    placeGroup(child, child.children, side);
  }
}

function bounds(root: Laid): { x: number; y: number; width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  walk(root, (item) => {
    minX = Math.min(minX, item.x);
    minY = Math.min(minY, item.y);
    maxX = Math.max(maxX, item.x + item.width);
    maxY = Math.max(maxY, item.y + item.height);
  });
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function walk(root: Laid, visit: (item: Laid) => void): void {
  visit(root);
  for (const child of root.children) walk(child, visit);
}

function collectBeyond(
  node: MindNode,
  depth: number,
  limit: number,
  out: Set<MindNode>,
): void {
  if (depth >= limit && node.children.length > 0) {
    out.add(node);
    return;
  }
  for (const child of node.children) collectBeyond(child, depth + 1, limit, out);
}

/* ---------------- 绘制 ---------------- */

function renderNodes(laid: Laid, collapsed: Set<MindNode>, redraw: () => void): SVGElement[] {
  const elements: SVGElement[] = [];

  walk(laid, (item) => {
    // 连线先画，保证节点框压在线上
    for (const child of item.children) {
      elements.push(link(item, child));
    }
  });

  walk(laid, (item) => {
    elements.push(nodeShape(item, collapsed, redraw));
  });

  return elements;
}

function link(parent: Laid, child: Laid): SVGElement {
  const toRight = child.x >= parent.x;
  const x1 = toRight ? parent.x + parent.width : parent.x;
  const y1 = parent.y + parent.height / 2;
  const x2 = toRight ? child.x : child.x + child.width;
  const y2 = child.y + child.height / 2;
  const midX = (x1 + x2) / 2;

  const path = document.createElementNS(SVG_NS, "path") as SVGPathElement;
  path.setAttribute("class", "mind-link");
  path.setAttribute(
    "d",
    `M${x1} ${y1}C${midX} ${y1} ${midX} ${y2} ${x2} ${y2}`,
  );
  return path;
}

function nodeShape(laid: Laid, collapsed: Set<MindNode>, redraw: () => void): SVGElement {
  const group = document.createElementNS(SVG_NS, "g") as SVGGElement;
  group.setAttribute("class", `mind-node mind-d${Math.min(laid.depth, 5)}`);
  group.setAttribute("transform", `translate(${laid.x} ${laid.y})`);

  const rect = document.createElementNS(SVG_NS, "rect") as SVGRectElement;
  rect.setAttribute("width", String(laid.width));
  rect.setAttribute("height", String(laid.height));
  rect.setAttribute("rx", "7");
  group.appendChild(rect);

  laid.lines.forEach((line, index) => {
    const text = document.createElementNS(SVG_NS, "text") as SVGTextElement;
    text.setAttribute("x", String(PAD_X));
    text.setAttribute("y", String(PAD_Y + LINE_HEIGHT * index + LINE_HEIGHT / 2 + 4));
    text.textContent = line;
    group.appendChild(text);
  });

  if (laid.node.note) {
    const title = document.createElementNS(SVG_NS, "title") as SVGTitleElement;
    title.textContent = laid.node.note;
    group.appendChild(title);
  }

  // 折叠状态下标出被隐藏的子节点数量，避免看起来像没有内容
  if (laid.collapsed) {
    const badge = document.createElementNS(SVG_NS, "text") as SVGTextElement;
    badge.setAttribute("class", "mind-badge");
    badge.setAttribute("x", String(laid.width - 6));
    badge.setAttribute("y", String(laid.height + 13));
    badge.setAttribute("text-anchor", "end");
    badge.textContent = `+${laid.node.children.length}`;
    group.appendChild(badge);
  }

  if (laid.node.children.length > 0) {
    group.classList.add("mind-clickable");
    group.addEventListener("click", (event) => {
      event.stopPropagation();
      if (collapsed.has(laid.node)) collapsed.delete(laid.node);
      else collapsed.add(laid.node);
      redraw();
    });
  }
  return group;
}

/* ---------------- 工具条 ---------------- */

interface MindButtons {
  element: HTMLElement;
  setZoom(scale: number): void;
  onFit: () => void;
  onExpandAll: () => void;
  onCollapseTo: (depth: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
}

function buildButtons(): MindButtons {
  const bar = document.createElement("div");
  bar.className = "mind-toolbar";

  const zoomText = document.createElement("span");
  zoomText.className = "mind-zoom";
  zoomText.textContent = "100%";

  const button = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
    const element = document.createElement("button");
    element.textContent = label;
    element.title = title;
    element.addEventListener("click", onClick);
    return element;
  };

  const api: MindButtons = {
    element: bar,
    setZoom: (value) => {
      zoomText.textContent = `${Math.round(value * 100)}%`;
    },
    onFit: () => undefined,
    onExpandAll: () => undefined,
    onCollapseTo: () => undefined,
    onZoomIn: () => undefined,
    onZoomOut: () => undefined,
  };

  bar.append(
    button("适应", "缩放到完整可见", () => api.onFit()),
    button("−", "缩小", () => api.onZoomOut()),
    zoomText,
    button("＋", "放大", () => api.onZoomIn()),
    button("全部展开", "展开所有层级", () => api.onExpandAll()),
    button("折叠到 2 层", "只保留前两层", () => api.onCollapseTo(2)),
  );
  return api;
}
