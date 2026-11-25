//! Markdown 图片落盘：粘贴或拖入图片时保存到文档同级的 assets 目录，
//! 并在光标处插入 `![](assets/xxx.png)` 相对引用，避免把 base64 塞进正文。

import { invoke } from "@tauri-apps/api/core";
import { EditorView } from "@codemirror/view";
import { app } from "./app-context";
import { showTransientStatus } from "./statusbar";
import { basename, isMarkdown } from "./tabs";

/** 剪贴板图片的 MIME 到扩展名映射；未收录的按 png 兜底 */
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

/** 取父目录；同时兼容 Windows 反斜杠与 POSIX 斜杠 */
function dirname(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : path;
}

/** 时间戳文件名：同一次粘贴多张图时由 Rust 侧自动追加 -1、-2 去重 */
function timestampName(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    "image-",
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

/** File 转纯 base64（去掉 data URL 前缀），交给 Rust 写盘 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(blob);
  });
}

function imagePathOf(path: string): boolean {
  const match = /\.([^./\\]+)$/.exec(path);
  return match ? IMAGE_EXTENSIONS.has(match[1].toLowerCase()) : false;
}

function imageStem(path: string): string {
  const name = basename(path);
  return name.replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-") || "image";
}

/** 图片存档目录：与文档同级，统一用正斜杠，Rust 在 Windows 上同样能识别 */
function assetsDir(documentPath: string): string {
  return `${dirname(documentPath)}/assets`;
}

/**
 * 在光标处插入引用。保存是异步的，期间用户可能已切换标签，
 * 此时只落盘不插入，避免把引用写进别的文件。
 */
function insertReference(text: string, tabId: string): void {
  if (app.store.active?.id !== tabId) return;
  const view = app.editor.view;
  view.dispatch(view.state.replaceSelection(text));
  view.focus();
}

async function saveToAssets(dir: string, baseName: string, ext: string, base64: string): Promise<string> {
  return invoke<string>("save_asset", { dir, baseName, ext, base64 });
}

async function saveClipboardImages(files: File[], tabId: string, documentPath: string): Promise<void> {
  const dir = assetsDir(documentPath);
  for (const file of files) {
    try {
      const ext = MIME_EXT[file.type] ?? "png";
      const base64 = await blobToBase64(file);
      const saved = await saveToAssets(dir, timestampName(), ext, base64);
      insertReference(`![](assets/${basename(saved)})`, tabId);
      showTransientStatus("图片已保存到 assets");
    } catch (error) {
      showTransientStatus(`图片保存失败：${error}`);
      return;
    }
  }
}

/** 编辑器的粘贴扩展：仅拦截剪贴板里带图片的粘贴，普通文本粘贴保持原样 */
export function markdownImagePaste() {
  return EditorView.domEventHandlers({
    paste(event) {
      const tab = app.store.active;
      if (!tab || tab.binary || tab.error || !isMarkdown(tab.title)) return false;

      const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
        file.type.startsWith("image/"),
      );
      if (files.length === 0) return false;

      // 图片没法作为文本粘贴，这里直接接管，避免浏览器把文件名当文本塞进正文
      event.preventDefault();
      if (!tab.path) {
        showTransientStatus("请先保存 Markdown 文件，再粘贴图片");
        return true;
      }
      void saveClipboardImages(files, tab.id, tab.path);
      return true;
    },
  });
}

/**
 * 拖入图片文件时的处理：只有拖到编辑区内才转存 assets，
 * 拖到侧栏或标签栏仍走原有的「打开文件」逻辑。
 * position 是 Tauri 给的物理像素坐标，需换算成 CSS 像素再判断区域。
 */
export async function tryInsertDroppedImages(
  paths: string[],
  position?: { x: number; y: number },
): Promise<boolean> {
  const tab = app.store.active;
  if (!tab || tab.binary || tab.error || !isMarkdown(tab.title) || !tab.path) return false;
  if (paths.length === 0 || !paths.every(imagePathOf)) return false;

  const host = document.getElementById("editor-host");
  const rect = host?.getBoundingClientRect();
  if (!position || !rect) return false;
  const scale = window.devicePixelRatio || 1;
  const x = position.x / scale;
  const y = position.y / scale;
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return false;

  const dir = assetsDir(tab.path);
  try {
    const references: string[] = [];
    for (const path of paths) {
      const match = /\.([^./\\]+)$/.exec(path);
      const ext = (match?.[1] ?? "png").toLowerCase();
      const base64 = await invoke<string>("read_file_base64", { path });
      const saved = await saveToAssets(dir, imageStem(path), ext, base64);
      references.push(`![](assets/${basename(saved)})`);
    }
    insertReference(references.join("\n"), tab.id);
    showTransientStatus("图片已保存到 assets");
    return true;
  } catch (error) {
    showTransientStatus(`图片保存失败：${error}`);
    return true; // 已按图片处理过，不再把同一批文件当普通文件打开
  }
}
