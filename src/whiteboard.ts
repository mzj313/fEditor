import { app } from "./app-context";
import type { Tab } from "./tabs";

/**
 * 画板：以 SVG 文本为唯一数据源的手绘涂鸦面板。
 * 每一笔在指针抬起时合并成一条 <path> 写回编辑器事务，
 * 从而复用撤销重做、脏标记、保存与会话恢复，不需要任何私有格式。
 */

/** 画板逻辑尺寸：固定 viewBox，预览区按比例缩放铺满 */
const BOARD_WIDTH = 1600;
const BOARD_HEIGHT = 1000;

/** SVG 骨架：白底矩形让橡皮可以用背景色绘制，观感与真实纸张一致；
 * data-feditor-canvas 标记用于重新打开时识别画板，避免抢占普通 svg */
export const WHITEBOARD_SKELETON = `<svg xmlns="http://www.w3.org/2000/svg" data-feditor-canvas="1" width="${BOARD_WIDTH}" height="${BOARD_HEIGHT}" viewBox="0 0 ${BOARD_WIDTH} ${BOARD_HEIGHT}">
  <rect x="0" y="0" width="${BOARD_WIDTH}" height="${BOARD_HEIGHT}" fill="#ffffff"/>
</svg>
`;

/** 文件内容里是否带画板标记 */
export function isWhiteboardText(text: string): boolean {
  return text.includes('data-feditor-canvas="1"');
}

const PALETTE = ["#1f2328", "#e5484d", "#f5a524", "#30a46c", "#0091ff", "#8e4ec6", "#e93d82", "#ffffff"];
const WIDTHS: Array<{ label: string; value: number }> = [
  { label: "细", value: 2 },
  { label: "中", value: 5 },
  { label: "粗", value: 12 },
];

/** 采样点最小间距（画板坐标），过密只会膨胀文件而对观感无益 */
const MIN_POINT_DISTANCE = 2;

interface BoardState {
  color: string;
  strokeWidth: number;
  eraser: boolean;
}

let state: BoardState = { color: PALETTE[0], strokeWidth: 5, eraser: false };
/**
 * 在预览容器里渲染画板。
 * 每次切回画板标签都会重建，画笔状态用模块级变量保留。
 */
export function renderWhiteboard(host: HTMLElement, tab: Tab): void {
  host.replaceChildren();

  const root = document.createElement("div");
  root.className = "whiteboard";

  const toolbar = buildToolbar(root, tab, host);
  const stage = document.createElement("div");
  stage.className = "whiteboard-stage";
  // 可聚焦才能接收 Ctrl+Z：预览模式下焦点不在编辑器上
  stage.tabIndex = 0;
  root.append(toolbar, stage);
  host.append(root);

  const svg = parseSvg(tab);
  if (!svg) {
    const error = document.createElement("div");
    error.className = "binary-error";
    error.textContent = "画板内容不是合法的 SVG，无法绘制";
    stage.append(error);
    return;
  }
  stage.append(svg);

  bindDrawing(stage, svg);
  // 挂在根节点上：点过工具条按钮后焦点在按钮上，事件仍能冒泡到这里
  bindHistoryKeys(root, tab, host);
}

/** 从编辑器当前文本构造 SVG 元素 */
function parseSvg(tab: Tab): SVGSVGElement | null {
  const text = app.editor.state.doc.toString();
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  if (doc.querySelector("parsererror")) return null;
  const svg = doc.documentElement;
  if (!(svg instanceof SVGSVGElement)) return null;
  // 交给外层容器控制尺寸，画板本身铺满可用区域
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.style.display = "block";
  svg.style.touchAction = "none";
  return svg;
}

function buildToolbar(root: HTMLElement, tab: Tab, host: HTMLElement): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "whiteboard-toolbar";

  const swatches = document.createElement("div");
  swatches.className = "whiteboard-swatches";
  for (const color of PALETTE) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "whiteboard-swatch";
    button.style.background = color;
    button.title = color === "#ffffff" ? "白色" : color;
    button.classList.toggle("active", !state.eraser && color === state.color);
    button.addEventListener("click", () => {
      state = { ...state, color, eraser: false };
      root.querySelectorAll(".whiteboard-swatch").forEach((el) => el.classList.remove("active"));
      button.classList.add("active");
      root.querySelector(".whiteboard-eraser")?.classList.remove("active");
    });
    swatches.append(button);
  }
  bar.append(swatches);

  const widths = document.createElement("div");
  widths.className = "whiteboard-widths";
  for (const width of WIDTHS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "whiteboard-width";
    button.textContent = width.label;
    button.classList.toggle("active", width.value === state.strokeWidth);
    button.addEventListener("click", () => {
      state = { ...state, strokeWidth: width.value };
      root.querySelectorAll(".whiteboard-width").forEach((el) => el.classList.remove("active"));
      button.classList.add("active");
    });
    widths.append(button);
  }
  bar.append(widths);

  const eraser = document.createElement("button");
  eraser.type = "button";
  eraser.className = "whiteboard-eraser";
  eraser.textContent = "橡皮";
  eraser.classList.toggle("active", state.eraser);
  eraser.addEventListener("click", () => {
    state = { ...state, eraser: !state.eraser };
    eraser.classList.toggle("active", state.eraser);
    root.querySelectorAll(".whiteboard-swatch").forEach((el) => el.classList.remove("active"));
  });
  bar.append(eraser);

  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "whiteboard-clear";
  clear.textContent = "清空";
  clear.title = "清空画板，可用 Ctrl+Z 撤销";
  clear.addEventListener("click", () => clearBoard(tab, host));
  bar.append(clear);

  return bar;
}

/** 清空 = 用一个事务把文档换回骨架，整次清空只占一步撤销 */
function clearBoard(tab: Tab, host: HTMLElement): void {
  app.editor.view.dispatch({
    changes: { from: 0, to: app.editor.state.doc.length, insert: WHITEBOARD_SKELETON },
  });
  app.editor.view.scrollDOM.scrollTop = 0;
  renderWhiteboard(host, tab);
}

interface Stroke {
  points: Array<{ x: number; y: number }>;
  path: SVGPathElement;
  pointerId: number;
}

function bindDrawing(stage: HTMLElement, svg: SVGSVGElement): void {
  let stroke: Stroke | null = null;

  /** 视口坐标换算成画板坐标，兼容缩放 */
  const toBoardPoint = (event: PointerEvent) => {
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  };

  const startStroke = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const point = toBoardPoint(event);
    if (!point) return;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "none");
    // 橡皮用画板底色绘制：白底画板上的视觉效果与擦除一致
    path.setAttribute("stroke", state.eraser ? "#ffffff" : state.color);
    path.setAttribute("stroke-width", String(state.eraser ? state.strokeWidth * 2 : state.strokeWidth));
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("d", `M ${round(point.x)} ${round(point.y)}`);
    path.style.pointerEvents = "none";
    svg.append(path);
    stage.setPointerCapture(event.pointerId);
    stage.focus();
    stroke = { points: [point], path, pointerId: event.pointerId };
    event.preventDefault();
  };

  const extendStroke = (event: PointerEvent) => {
    if (!stroke || stroke.pointerId !== event.pointerId) return;
    const point = toBoardPoint(event);
    if (!point) return;
    const last = stroke.points[stroke.points.length - 1];
    // 抽稀：间距太小的点不记录，避免一笔写入几百个无效点
    if (Math.hypot(point.x - last.x, point.y - last.y) < MIN_POINT_DISTANCE) return;
    stroke.points.push(point);
    stroke.path.setAttribute(
      "d",
      `M ${round(stroke.points[0].x)} ${round(stroke.points[0].y)}` +
        stroke.points
          .slice(1)
          .map((p) => ` L ${round(p.x)} ${round(p.y)}`)
          .join(""),
    );
  };

  const finishStroke = (event: PointerEvent) => {
    if (!stroke || stroke.pointerId !== event.pointerId) return;
    const current = stroke;
    stroke = null;
    try {
      stage.releasePointerCapture(event.pointerId);
    } catch {
      // 指针已释放时忽略，不影响收笔
    }
    commitStroke(current);
  };

  stage.addEventListener("pointerdown", startStroke);
  stage.addEventListener("pointermove", extendStroke);
  stage.addEventListener("pointerup", finishStroke);
  stage.addEventListener("pointercancel", finishStroke);
  // 拖拽画布时不选中任何文字
  stage.addEventListener("dragstart", (event) => event.preventDefault());
}

/** 把一笔写回 SVG 文本：整笔一次事务，撤销粒度就是一笔 */
function commitStroke(stroke: Stroke): void {
  const { editor } = app;
  const markup = `<path d="${stroke.path.getAttribute("d")}" fill="none" stroke="${stroke.path.getAttribute("stroke")}" stroke-width="${stroke.path.getAttribute("stroke-width")}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const text = editor.state.doc.toString();
  const closeIndex = text.lastIndexOf("</svg>");
  const insertAt = closeIndex >= 0 ? closeIndex : text.length;
  editor.view.dispatch({
    changes: { from: insertAt, insert: `  ${markup}\n` },
  });
}

/** 画板内接管撤销重做：预览模式下编辑器没有焦点，快捷键不会走 CodeMirror 键位 */
function bindHistoryKeys(root: HTMLElement, tab: Tab, host: HTMLElement): void {
  root.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key !== "z" && key !== "y") return;
    event.preventDefault();
    const { editor } = app;
    if (key === "y" || (key === "z" && event.shiftKey)) {
      import("@codemirror/commands").then(({ redo }) => redo(editor.view));
    } else {
      import("@codemirror/commands").then(({ undo }) => undo(editor.view));
    }
    // 撤销后文档已变，重建画板把笔画同步回画面
    requestAnimationFrame(() => renderWhiteboard(host, tab));
  });
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
