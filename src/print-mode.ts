/**
 * 打印窗口模式：主窗口通过菜单发起 Markdown 打印预览时，
 * Rust 创建（或复用）这个离屏窗口，这里负责把 HTML 渲染成
 * 白底文档流，等字体和图片就绪后让 Rust 生成 PDF。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface PrintJob {
  id: number;
  title: string;
  html: string;
}

/** 渲染完成后等图片全部结束（成功或失败都继续），避免 PDF 里缺图 */
function waitForImages(doc: HTMLElement): Promise<void> {
  const images = Array.from(doc.querySelectorAll("img"));
  return Promise.all(
    images.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete) {
            resolve();
            return;
          }
          img.addEventListener("load", () => resolve(), { once: true });
          img.addEventListener("error", () => resolve(), { once: true });
        }),
    ),
  ).then(() => undefined);
}

async function render(job: PrintJob): Promise<void> {
  document.title = `${job.title} - 打印预览`;
  const root = document.getElementById("print-root");
  if (!root) return;
  // 复用主界面的 #preview-host 样式，纸质版观感与预览一致
  const doc = document.createElement("div");
  doc.id = "preview-host";
  doc.innerHTML = job.html;
  root.replaceChildren(doc);

  await document.fonts.ready;
  await waitForImages(doc);
  await invoke("print_capture", { title: job.title });
}

async function boot(): Promise<void> {
  document.body.classList.add("print-window");
  // 纸质版固定浅色，与深色主题无关
  document.documentElement.dataset.theme = "light";

  await listen<number>("print-render", () => {
    void invoke<PrintJob | null>("print_take_job").then((job) => {
      if (job) return render(job);
    });
  });

  // 窗口可能晚于任务创建，启动时主动拉一次兜底
  const job = await invoke<PrintJob | null>("print_take_job");
  if (job) await render(job);
}

void boot();
