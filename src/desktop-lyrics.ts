//! 桌面歌词窗口：只负责显示主窗口推送的当前句/下一句，整条歌词带可拖动

import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";

interface LyricPayload {
  current: string;
  next: string;
}

const currentEl = document.getElementById("current") as HTMLDivElement;
const nextEl = document.getElementById("next") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

/** 歌词为空时窗口全透明，开启瞬间给一条可见反馈，几秒后自动消失 */
let statusTimer: number | undefined;

function flashStatus(text: string): void {
  statusEl.textContent = text;
  if (statusTimer !== undefined) window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    statusTimer = undefined;
    statusEl.textContent = "";
  }, 2500);
}

function show(payload: LyricPayload): void {
  // 无歌词时整窗保持空白，不显示占位文字
  if (currentEl.textContent !== payload.current) currentEl.textContent = payload.current;
  if (nextEl.textContent !== payload.next) nextEl.textContent = payload.next;
  // 拿到真实歌词后立刻收起开启提示
  if (payload.current) statusEl.textContent = "";
}

/* ---------- 调节方式：右键菜单改颜色/透明度，滚轮改字号 ---------- */

const SIZE_KEY = "fEditor.desktopLyricSize";
const COLOR_KEY = "fEditor.desktopLyricColor";
const OPACITY_KEY = "fEditor.desktopLyricOpacity";
const MIN_SIZE = 16;
const MAX_SIZE = 48;
let lyricSize = Number(localStorage.getItem(SIZE_KEY)) || 26;
let lyricColor = localStorage.getItem(COLOR_KEY) || "#ffffff";
let lyricOpacity = Number(localStorage.getItem(OPACITY_KEY)) || 1;

const menuEl = document.getElementById("menu") as HTMLDivElement;
const opacityInput = document.getElementById("opacity") as HTMLInputElement;
const opacityValue = document.getElementById("opacity-value") as HTMLSpanElement;
const sizeInput = document.getElementById("size") as HTMLInputElement;
const sizeValue = document.getElementById("size-value") as HTMLSpanElement;
const widthInput = document.getElementById("width") as HTMLInputElement;
const widthValue = document.getElementById("width-value") as HTMLSpanElement;
const heightInput = document.getElementById("height") as HTMLInputElement;
const heightValue = document.getElementById("height-value") as HTMLSpanElement;

/** 窗口尺寸也记住，重启应用后恢复；直接用边缘拖拽改变时通过 resize 事件同步 */
const WIN_WIDTH_KEY = "fEditor.desktopLyricWidth";
const WIN_HEIGHT_KEY = "fEditor.desktopLyricHeight";
let winWidth = Number(localStorage.getItem(WIN_WIDTH_KEY)) || 760;
let winHeight = Number(localStorage.getItem(WIN_HEIGHT_KEY)) || 140;
// 旧版本可能存过更小的尺寸，这里抬到下限，保证右键菜单完整可见
winWidth = Math.max(300, winWidth);
winHeight = Math.max(140, winHeight);

function syncSizeControls(): void {
  widthInput.value = String(winWidth);
  widthValue.textContent = String(winWidth);
  heightInput.value = String(winHeight);
  heightValue.textContent = String(winHeight);
}

function applyWindowSize(): void {
  localStorage.setItem(WIN_WIDTH_KEY, String(winWidth));
  localStorage.setItem(WIN_HEIGHT_KEY, String(winHeight));
  syncSizeControls();
  void invoke("set_desktop_lyrics_size", { width: winWidth, height: winHeight });
}

function applyLyricSize(): void {
  document.documentElement.style.setProperty("--lyric-size", `${lyricSize}px`);
  // 滚轮与右键菜单里的滑块互相同步
  sizeInput.value = String(lyricSize);
  sizeValue.textContent = `${lyricSize}px`;
}

function applyLyricStyle(): void {
  document.documentElement.style.setProperty("--lyric-color", lyricColor);
  document.documentElement.style.setProperty("--lyric-opacity", String(lyricOpacity));
  // 菜单里的圆点同步高亮当前颜色
  for (const dot of document.querySelectorAll<HTMLButtonElement>(".dot")) {
    dot.classList.toggle("active", dot.dataset.color === lyricColor);
  }
  const percent = Math.round(lyricOpacity * 100);
  opacityInput.value = String(percent);
  opacityValue.textContent = `${percent}%`;
}

function closeMenu(): void {
  menuEl.classList.remove("open");
  document.body.classList.remove("menu-open");
}

/** 在鼠标位置弹出菜单，靠近边缘时向内收，避免超出小窗口 */
function openMenu(x: number, y: number): void {
  menuEl.classList.add("open");
  document.body.classList.add("menu-open");
  const rect = menuEl.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
  menuEl.style.left = `${left}px`;
  menuEl.style.top = `${top}px`;
}

// WebView2 自带的右键菜单（刷新/检查）没有意义，改为弹出自己的调节菜单
document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  openMenu(event.clientX, event.clientY);
});

// 点击菜单外、按 Esc、滚动、窗口失焦都收起菜单
document.addEventListener("pointerdown", (event) => {
  if (!menuEl.contains(event.target as Node)) closeMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu();
});
window.addEventListener("blur", closeMenu);

window.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    closeMenu();
    // 向下滚变小、向上滚变大，每次 2px
    const step = event.deltaY > 0 ? -2 : 2;
    const next = Math.min(MAX_SIZE, Math.max(MIN_SIZE, lyricSize + step));
    if (next === lyricSize) return;
    lyricSize = next;
    localStorage.setItem(SIZE_KEY, String(lyricSize));
    applyLyricSize();
    flashStatus(`字号 ${lyricSize}px`);
  },
  { passive: false },
);

opacityInput.addEventListener("input", () => {
  lyricOpacity = Number(opacityInput.value) / 100;
  localStorage.setItem(OPACITY_KEY, String(lyricOpacity));
  applyLyricStyle();
});

sizeInput.addEventListener("input", () => {
  lyricSize = Number(sizeInput.value);
  localStorage.setItem(SIZE_KEY, String(lyricSize));
  applyLyricSize();
});

widthInput.addEventListener("input", () => {
  winWidth = Number(widthInput.value);
  applyWindowSize();
});

heightInput.addEventListener("input", () => {
  winHeight = Number(heightInput.value);
  applyWindowSize();
});

// 直接用窗口边缘拖拽改变大小时，同步回控件与存储
window.addEventListener("resize", () => {
  winWidth = window.innerWidth;
  winHeight = window.innerHeight;
  localStorage.setItem(WIN_WIDTH_KEY, String(winWidth));
  localStorage.setItem(WIN_HEIGHT_KEY, String(winHeight));
  syncSizeControls();
});

// 启动时恢复上次保存的窗口尺寸
applyWindowSize();

for (const dot of document.querySelectorAll<HTMLButtonElement>(".dot")) {
  dot.addEventListener("click", () => {
    lyricColor = dot.dataset.color ?? "#ffffff";
    localStorage.setItem(COLOR_KEY, lyricColor);
    applyLyricStyle();
  });
}

applyLyricSize();
applyLyricStyle();
void listen<LyricPayload>("desktop-lyric", (event) => show(event.payload));

/* ---------- 播放控制：上一首 / 下一首 / 音量 ---------- */

interface PlayerState {
  hasMedia: boolean;
  volume: number;
}

const controlsEl = document.getElementById("controls") as HTMLDivElement;
// 注意不要用 prev/next 作 id：歌词的「下一句」元素已经占用了 next
const prevButton = document.getElementById("prev-track") as HTMLButtonElement;
const nextButton = document.getElementById("next-track") as HTMLButtonElement;
const volumeInput = document.getElementById("volume") as HTMLInputElement;

function sendCommand(action: string, value?: number): void {
  void emit("desktop-lyric-command", { action, value }).catch(() => undefined);
}

prevButton.addEventListener("click", () => sendCommand("prev"));
nextButton.addEventListener("click", () => sendCommand("next"));
volumeInput.addEventListener("input", () => {
  sendCommand("volume", Number(volumeInput.value));
});

void listen<PlayerState>("desktop-lyric-state", (event) => {
  const { hasMedia, volume } = event.payload;
  // 没有正在播放的音频时隐藏控制条，避免点了没反应
  controlsEl.hidden = !hasMedia;
  // 正在拖动滑块时不回写，否则光标会被拽回旧值
  if (document.activeElement !== volumeInput) volumeInput.value = String(volume);
});

// 打开歌词窗时主动要一次状态，主窗口随即回推是否在播放以及当前音量
void emit("desktop-lyric-state-request").catch(() => undefined);

// 关闭按钮直接复用切换命令：隐藏窗口并记住当前位置
document.getElementById("close")?.addEventListener("click", () => {
  void invoke("toggle_desktop_lyrics");
});

flashStatus("右键调颜色/透明度 · 滚轮调字号");
