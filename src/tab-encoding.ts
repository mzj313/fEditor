//! 状态栏的编码 / 换行切换：编码切换会按指定编码重新读盘，
//! 换行与 BOM 只改保存参数，标记为未保存后由用户决定何时落盘。

import { app } from "./app-context";
import { ask, message } from "./dialogs";
import { hidePreview, showPreview } from "./preview-panel";
import { scheduleSessionSave } from "./session";
import { buildSession } from "./session-state";
import { showTransientStatus, updateStatus } from "./statusbar";
import { applyLanguage, applyPayload, readTextFile } from "./tab-lifecycle";

/** 按指定编码重新读取当前标签对应的文件 */
export async function applyEncoding(encoding: string): Promise<void> {
  const { store, editor } = app;
  const tab = store.active;
  if (!tab || tab.binary || tab.large || !tab.path) {
    showTransientStatus("当前标签不支持切换编码");
    return;
  }
  if (tab.dirty) {
    const choice = await ask("切换编码会按新编码重新读取磁盘内容，当前未保存的修改将丢失。", [
      { label: "继续", value: "ok", primary: true },
      { label: "取消", value: "cancel" },
    ]);
    if (choice !== "ok") return;
  }
  try {
    const result = await readTextFile(tab.path, encoding);
    // 大文件不支持按编码重读；用户取消时也保持原内容
    if (result.kind !== "text") {
      showTransientStatus("已取消重新读取");
      return;
    }
    applyPayload(tab, result.payload);
    tab.state = editor.createState(result.payload.content, { cursor: 0 });
    tab.loaded = true;
    tab.langApplied = false;
    editor.setState(tab.state);
    await applyLanguage(tab.title);
    tab.langApplied = true;
    if (tab.preview) {
      await showPreview(tab);
    } else {
      hidePreview();
    }
    updateStatus();
    scheduleSessionSave(buildSession);
    showTransientStatus(`已按 ${encoding} 重新读取`);
  } catch (error) {
    await message(`重新读取失败：\n${error}`);
  }
}

/** UTF-8 BOM 只影响保存时的文件头，不必重新读盘 */
export function toggleBom(): void {
  const { store } = app;
  const tab = store.active;
  if (!tab || tab.binary || tab.large || !tab.path) return;
  if (tab.encoding !== "UTF-8") {
    showTransientStatus("只有 UTF-8 支持 BOM");
    return;
  }
  tab.hasBom = !tab.hasBom;
  tab.dirty = true;
  updateStatus();
  showTransientStatus(tab.hasBom ? "保存时将写入 UTF-8 BOM" : "保存时将移除 BOM");
}

/** 换行风格在保存时生效，先标记未保存提醒用户继续编辑或保存 */
export function applyEol(eol: "LF" | "CRLF"): void {
  const { store } = app;
  const tab = store.active;
  if (!tab || tab.binary || tab.large) return;
  if (tab.eol === eol) return;
  tab.eol = eol;
  tab.dirty = true;
  updateStatus();
  showTransientStatus(`保存时将使用 ${eol === "CRLF" ? "CRLF（Windows）" : "LF（Unix）"} 换行`);
}
