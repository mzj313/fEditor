//! 界面缩放：Ctrl + 滚轮 / 触控板双指捏合 / Ctrl+加号减号，缩放整套界面。
//!
//! 用 CSS transform 而不是 WebView2 自带的页面缩放：
//! 页面缩放每帧都要整页重排重绘，捏合时明显发卡。transform 只走合成层，手感跟手。
//! 触摸板侧（经运行时日志证实）：WebView2 会把双指捏合转成 ctrl + wheel 像素流
//! 送进页面（单次 delta 只有几像素的 dm=0 事件），与按住 Ctrl 的双指平移同通道，
//! 因此这里统一接管 ctrl + wheel 即可覆盖两种手势；Rust 侧只需打开内核开关
//! （见 lib.rs 的 enable_pinch_zoom），不需要任何事件桥接。

const STORAGE_KEY = "fEditor.uiScale";
const MIN_SCALE = 0.6;
const MAX_SCALE = 2;
const STEP = 0.1;
/** 滚轮像素到缩放倍率的换算系数，调小更跟手、调大更沉稳 */
const WHEEL_SENSITIVITY = 0.0015;

let scale = 1;
let persistTimer: number | null = null;

function clamp(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

/**
 * 应用当前缩放。
 * #app 本身是 100% 宽高，缩放后必须把布局尺寸反向放大，
 * 否则右下角会露出一块空白（相当于「视口变小了」）。
 */
function applyScale(): void {
  const root = document.getElementById("app");
  if (!root) return;
  root.style.transformOrigin = "0 0";
  root.style.width = `${100 / scale}%`;
  root.style.height = `${100 / scale}vh`;
  // 提升为合成层，连续缩放时避免每帧重新光栅化整页
  root.style.willChange = scale === 1 ? "" : "transform";
  root.style.transform = scale === 1 ? "" : `scale(${scale})`;
  // 状态栏同步显示当前比例，方便确认手势/快捷键是否真的生效
  const indicator = document.getElementById("st-zoom");
  if (indicator) indicator.textContent = scale === 1 ? "" : `${Math.round(scale * 100)}%`;
}

/** 缩放过程会高频触发，落盘做防抖，避免每帧同步写 localStorage */
function schedulePersist(): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    localStorage.setItem(STORAGE_KEY, String(Math.round(scale * 100) / 100));
  }, 300);
}

function setScale(next: number): void {
  const value = clamp(next);
  if (Math.abs(value - scale) < 0.0005) return;
  scale = value;
  applyScale();
  schedulePersist();
  // 位图内容（PDF 画布等）需要按新比例重新栅格化，否则只是被拉伸发糊
  window.dispatchEvent(new CustomEvent("ui-scale-changed"));
}

/** 当前界面缩放倍率，位图渲染（如 PDF）用它决定栅格化分辨率 */
export function getUiScale(): number {
  return scale;
}

/** 设置面板的「重置为 100%」按钮 */
export function resetUiZoom(): void {
  setScale(1);
}

/** 启动时恢复上次比例；值非法或为 1 时保持默认布局 */
export function applyUiScale(): void {
  const saved = Number(localStorage.getItem(STORAGE_KEY));
  scale = Number.isFinite(saved) && saved > 0 ? clamp(saved) : 1;
  if (scale !== 1) applyScale();
}

export function bindUiZoom(): void {
  // 触控板捏合在 WebView2 里以 ctrl + wheel 送进来，这是唯一稳定的手势入口。
  // 用捕获阶段：先于编辑器、终端、思维导图等子元素处理，
  // 阻止它们各自缩放，保证一次手势只做一件事。
  window.addEventListener(
    "wheel",
    (event) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      // 思维导图区域例外：捏合（ctrl+wheel）缩放导图自身的显示比例，
      // 不缩放整个界面
      const target = event.target as Element | null;
      if (target?.closest?.(".mind-stage")) return;
      event.preventDefault();
      event.stopPropagation();
      // 触控板的双指手势会同时给出横纵两个分量，只取纵向会导致
      // 「左右方向滑/捏没反应」。这里按绝对值较大的那个轴计算。
      const delta =
        Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (delta === 0) return;
      setScale(scale * Math.exp(-delta * WHEEL_SENSITIVITY));
    },
    { passive: false, capture: true },
  );

  window.addEventListener("keydown", onKeyDown, { capture: true });
}

function onKeyDown(event: KeyboardEvent): void {
  if (!(event.ctrlKey || event.metaKey)) return;
  // Ctrl+0 复位，Ctrl+= / Ctrl+- 加减一档；等号键不带 Shift 时是 "="
  if (event.key === "0") {
    event.preventDefault();
    setScale(1);
    return;
  }
  if (event.key === "=" || event.key === "+") {
    event.preventDefault();
    setScale(scale + STEP);
    return;
  }
  if (event.key === "-" || event.key === "_") {
    event.preventDefault();
    setScale(scale - STEP);
  }
}
