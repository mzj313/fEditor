import { invoke } from "@tauri-apps/api/core";

export interface SessionTab {
  id: string;
  path: string;
  title: string;
  dirty: boolean;
  encoding: string;
  eol: "LF" | "CRLF";
  hasBom: boolean;
  mtime: number;
  cursor: number;
  scrollTop: number;
  /** 预览面板滚动位置，旧会话没有该字段时按 0 处理 */
  previewScrollTop?: number;
  /** PDF / Word / 图片 / 音视频预览标签，只记路径，不存内容 */
  binary?: "pdf" | "docx" | "image" | "audio" | "video" | "mind";
  /** 画板标签：恢复时保持可视化绘制模式 */
  canvas?: boolean;
}

/** 未命名草稿：没有磁盘路径，内容只能随会话保存，重启后原样恢复 */
export interface SessionDraft {
  id: string;
  title: string;
  text: string;
  cursor: number;
  scrollTop: number;
  canvas?: boolean;
}

export interface SessionData {
  version: 1;
  activeId: string | null;
  tabs: SessionTab[];
  /** 未命名的空白文件，首次保存时才会让用户选路径 */
  drafts?: SessionDraft[];
  recent: string[];
  updatedAt: number;
  /** 上次打开的工作区根目录，未打开文件夹时为空 */
  root?: string | null;
  /** 上次展开的目录集合，用于恢复文件树状态 */
  treeExpanded?: string[];
}

let timer: number | undefined;

export async function loadSession(): Promise<SessionData | null> {
  try {
    const data = await invoke<SessionData | null>("load_session");
    if (!data || data.version !== 1 || !Array.isArray(data.tabs)) return null;
    return data;
  } catch (error) {
    console.error("读取会话失败", error);
    return null;
  }
}

async function writeSession(data: SessionData): Promise<void> {
  try {
    await invoke("save_session", { data });
  } catch (error) {
    console.error("写入会话失败", error);
  }
}

export function scheduleSessionSave(build: () => SessionData): void {
  if (timer !== undefined) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = undefined;
    void writeSession(build());
  }, 400);
}

export async function flushSession(build: () => SessionData): Promise<void> {
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timer = undefined;
  }
  await writeSession(build());
}
