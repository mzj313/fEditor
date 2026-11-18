import { invoke } from "@tauri-apps/api/core";

let rendererPromise: Promise<{
  render: (text: string) => string;
}> | null = null;

async function createRenderer(): Promise<{ render: (text: string) => string }> {
  const [{ default: MarkdownIt }, { default: DOMPurify }] = await Promise.all([
    import("markdown-it"),
    import("dompurify"),
  ]);
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    breaks: false,
  });
  // 任务列表（- [ ] / - [x]）markdown-it 默认不支持，会把方括号原样输出成「[]」。
  // 这里把列表项开头的复选框语法换成方框符号，保证预览里能看出勾选状态。
  md.core.ruler.after("inline", "task_list", (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      const children = token.children;
      if (token.type !== "inline" || !children || children.length === 0) continue;
      // 只处理「列表项里的段落」，避免正文里普通的 [ ] 也被改写
      if (tokens[i - 1]?.type !== "paragraph_open" || tokens[i - 2]?.type !== "list_item_open") continue;
      const first = children[0];
      if (first.type !== "text") continue;
      const matched = /^\[([ xX])\]\s*/.exec(first.content);
      if (!matched) continue;
      first.content = first.content.slice(matched[0].length);
      const checkbox = new state.Token("html_inline", "", 0);
      checkbox.content = matched[1].toLowerCase() === "x" ? "☑ " : "☐ ";
      children.unshift(checkbox);
    }
  });
  // 本地单机编辑器需要保留内联 SVG 的完整结构，因此把 HTML/SVG/滤镜/MathML
  // 四套 profile 全部开启；style 与 foreignObject 不在默认白名单内，需显式放行，
  // 否则内联 svg 里的 <style> 会被 DOMPurify 直接删除、图形失去样式。
  const sanitizeConfig = {
    USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
    ADD_TAGS: ["style", "foreignObject"],
  };
  return {
    render: (text: string) => DOMPurify.sanitize(md.render(text), sanitizeConfig),
  };
}

export async function renderMarkdown(text: string): Promise<string> {
  if (!rendererPromise) rendererPromise = createRenderer();
  const renderer = await rendererPromise;
  return renderer.render(text);
}

/** mermaid 只用到这两个方法，单独声明避免把整个包的类型都引进来。 */
interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

let mermaidPromise: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => {
      const mermaid = (mod.default ?? mod) as MermaidApi;
      mermaid.initialize({
        startOnLoad: false, // 由我们手动触发渲染，不扫描整个页面
        securityLevel: "strict", // 禁止图内嵌脚本与任意链接
        theme: "default", // 与当前浅色预览区保持一致
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

/**
 * 把 ```mermaid 代码块替换为渲染后的 SVG。
 * 只有文档里真的出现 mermaid 块时才动态加载，避免首屏多下载几百 KB。
 */
export async function renderMermaidDiagrams(container: HTMLElement): Promise<void> {
  const blocks = Array.from(
    container.querySelectorAll<HTMLElement>("pre > code.language-mermaid"),
  );
  if (!blocks.length) return;

  const mermaid = await loadMermaid();
  let index = 0;

  for (const code of blocks) {
    const source = code.textContent ?? "";
    const pre = code.parentElement;
    if (!pre) continue;

    try {
      // 同一页面多张图必须用不同 id，否则内部临时节点会互相覆盖
      const { svg } = await mermaid.render(`mermaid-diagram-${index++}`, source);
      const wrapper = document.createElement("div");
      wrapper.className = "mermaid-diagram";
      wrapper.innerHTML = svg;
      pre.replaceWith(wrapper);
    } catch (error) {
      // 语法错误时保留源码并提示原因，避免整页预览直接失败
      pre.classList.add("mermaid-error");
      const hint = document.createElement("div");
      hint.className = "mermaid-error-hint";
      hint.textContent = `Mermaid 渲染失败：${
        error instanceof Error ? error.message : String(error)
      }`;
      pre.after(hint);
    }
  }
}

/** 常见图片扩展名到 MIME 的映射，用于拼出 data URI。 */
const IMAGE_MIME: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

/** 已带协议的 src 无需本地读取，保持原样。 */
function isNonLocalSrc(src: string): boolean {
  return /^(https?:|data:|blob:|asset:)/i.test(src);
}

/** 路径分隔符跟随路径自身：Windows 用反斜杠，macOS/Linux 用斜杠。 */
function separatorOf(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}

/** 取父目录；根目录（POSIX 的 `/`、Windows 的 `C:\`）不能截空。 */
function dirname(path: string): string {
  const sep = separatorOf(path);
  const normalized =
    sep === "\\" ? path.replace(/\//g, "\\") : path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf(sep);
  if (index < 0) return normalized;
  if (index === 0) return sep;
  if (sep === "\\" && index === 2 && /^[a-zA-Z]:/.test(normalized)) {
    return normalized.slice(0, 3);
  }
  return normalized.slice(0, index);
}

/**
 * 以 basePath 所在目录为基准拼出绝对路径。
 * 分隔符跟随 basePath 自身，避免在 POSIX 路径里拼出 `dir\img.png` 这种找不到文件的混合路径。
 */
function joinPath(basePath: string, relative: string): string {
  const sep = separatorOf(basePath);
  const dir = dirname(basePath);
  const rel = relative
    .replace(/[/\\]+/g, sep)
    .replace(sep === "\\" ? /^\\+/ : /^\/+/, "");
  return `${dir}${sep}${rel}`;
}

/** markdown-it 会把空格、中文等字符转成百分号编码，读文件前要先还原。 */
function decodeSrc(src: string): string {
  try {
    return decodeURI(src);
  } catch {
    return src;
  }
}

/**
 * 把 markdown 里的相对路径图片换成本地文件的 data URI。
 * 渲染前浏览器无法访问本地磁盘，故渲染后逐张读取并回填；
 * 单张失败只会给该图打标记，不影响其余图片和整页预览。
 */
export async function resolveLocalImages(
  container: HTMLElement,
  basePath: string | null,
): Promise<void> {
  if (!basePath) return; // 未命名文档没有基准目录，无从推断相对路径
  // 文档里的路径来自文件内容而非用户选择：只解析图片扩展名，
  // 并把读取范围限定在文档所在目录内
  const baseDir = dirname(basePath);
  const images = Array.from(container.querySelectorAll<HTMLImageElement>("img"));

  await Promise.all(
    images.map(async (img) => {
      const src = img.getAttribute("src") ?? "";
      if (!src || isNonLocalSrc(src)) return;

      // 去查询串/锚点，还原百分号编码；绝对路径直接用，相对路径以文档目录为基准
      const rel = decodeSrc(src).split(/[?#]/)[0];
      if (!rel) return;
      const target = /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(rel)
        ? rel
        : joinPath(basePath, rel);
      const dot = target.lastIndexOf(".");
      const mime = dot >= 0 ? IMAGE_MIME[target.slice(dot + 1).toLowerCase()] : undefined;
      if (!mime) {
        // 非图片扩展名一律不读：否则文档里写 ![](/Users/me/.ssh/id_rsa)
        // 就能把任意文件内容带进页面
        img.classList.add("img-broken");
        return;
      }
      try {
        const base64 = await invoke<string>("read_file_base64", {
          path: target,
          root: baseDir,
        });
        img.src = `data:${mime};base64,${base64}`;
      } catch {
        // 读取失败保留原始 src，虚线框提示用户检查路径，不抛异常打断预览
        img.classList.add("img-broken");
      }
    }),
  );
}
