import { invoke } from "@tauri-apps/api/core";
import { app } from "./app-context";
import { applyLanguage, applyPayload, type FilePayload } from "./tab-lifecycle";
import { hidePreview, showPreview } from "./preview-panel";
import { scheduleSessionSave } from "./session";
import { activeText, buildSession } from "./session-state";
import { updateStatus } from "./statusbar";
import { ask, message } from "./dialogs";
import { checkToml, checkYaml } from "./config-lang";
import { basename, isToml, isYaml, type Tab } from "./tabs";

interface SaveResult {
  mtime: number;
  size: number;
}

interface TabSaveDeps {
  renderTabs(): void;
}

let deps: TabSaveDeps;

export function initTabSave(d: TabSaveDeps): void {
  deps = d;
}

export async function saveTab(tab: Tab, force = false): Promise<boolean> {
  if (tab.binary) return false;
  if (tab.error) {
    await message("原文件已不存在，无法保存当前内容。");
    return false;
  }
  let targetPath = tab.path;
  if (!targetPath) {
    // 未命名标签首次保存：标题本身带扩展名就沿用，否则默认按 txt 保存
    const hasExt = /\.[^./\\]+$/.test(tab.title);
    const picked = await invoke<string | null>("pick_save_path", {
      defaultName: hasExt ? tab.title : `${tab.title}.txt`,
    });
    if (!picked) return false;
    targetPath = picked;
  }

  const text = activeText(tab);

  // YAML/TOML 的缩进错误往往肉眼难辨，保存前先做一次语法检查
  const title = targetPath ? basename(targetPath) : tab.title;
  if (isYaml(title) || isToml(title)) {
    const problem = isYaml(title) ? await checkYaml(text) : await checkToml(text);
    if (problem) {
      const choice = await ask(`语法检查未通过：\n${problem}\n\n仍要保存吗？`, [
        { label: "仍要保存", value: "save" },
        { label: "取消", value: "cancel", primary: true },
      ]);
      if (choice !== "save") return false;
    }
  }

  try {
    const result = await invoke<SaveResult>("save_file", {
      path: targetPath,
      content: text,
      encoding: tab.encoding,
      eol: tab.eol,
      hasBom: tab.hasBom,
      expectedMtime: force ? 0 : tab.mtime,
    });

    tab.path = targetPath;
    tab.title = basename(targetPath);
    tab.mtime = result.mtime;
    tab.size = result.size;
    tab.savedText = text;
    tab.dirty = false;
    tab.error = null;
    const { store, editor } = app;
    if (tab.id === store.activeId) {
      tab.state = editor.state;
    }
    deps.renderTabs();
    updateStatus();
    scheduleSessionSave(buildSession);
    return true;
  } catch (error) {
    const raw = String(error);
    if (raw.includes("EXTERNAL_MODIFIED")) {
      const choice = await ask("文件已被其他程序修改，如何处理？", [
        { label: "重新打开", value: "reload" },
        { label: "仍要覆盖", value: "overwrite" },
        { label: "取消", value: "cancel", primary: true },
      ]);
      if (choice === "overwrite") return saveTab(tab, true);
      if (choice === "reload") {
        await reloadTab(tab);
        return false;
      }
      return false;
    }
    await message(`保存失败：\n${raw}`);
    return false;
  }
}

export async function reloadTab(tab: Tab): Promise<void> {
  if (!tab.path) return;
  const { store, editor } = app;
  try {
    const payload = await invoke<FilePayload>("read_file", { path: tab.path });
    applyPayload(tab, payload);
    tab.state = editor.createState(payload.content, { cursor: 0 });
    tab.loaded = true;
    if (tab.id === store.activeId) {
      editor.setState(tab.state);
      await applyLanguage(tab.title);
      tab.langApplied = true;
      if (tab.preview) {
        await showPreview(tab);
      } else {
        hidePreview();
      }
      updateStatus();
    }
    deps.renderTabs();
  } catch (error) {
    await message(`重新打开失败：\n${error}`);
  }
}
