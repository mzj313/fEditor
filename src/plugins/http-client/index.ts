//! HTTP 调试插件：类似轻量 Postman，请求由 Rust 侧发出（绕过浏览器 CORS）。
//! 左侧配置请求（参数 / 请求头 / 请求体），右侧展示响应（状态、耗时、大小、
//! 响应体 / 响应头 / HTML 预览）。当前请求与历史记录存在 localStorage，
//! 关掉面板再打开不会丢。

import { invoke } from "@tauri-apps/api/core";
import type { PluginContext, ToolPlugin } from "../types";
import "./http-client.css";

type BodyType = "none" | "text" | "json" | "multipart";
type Pair = [string, string];

interface FormRow {
  key: string;
  value: string;
  filePath: string | null;
}

interface RequestState {
  method: string;
  url: string;
  headers: Pair[];
  bodyType: BodyType;
  body: string;
  form: FormRow[];
}

interface HttpResponse {
  status: number;
  statusText: string;
  headers: Pair[];
  body: string;
  url: string;
  elapsedMs: number;
  size: number;
  truncated: boolean;
  binary: boolean;
}

interface HistoryEntry {
  at: number;
  status: number;
  request: RequestState;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const STORE_CURRENT = "fEditor.plugin.http.current";
const STORE_HISTORY = "fEditor.plugin.http.history";
const MAX_HISTORY = 30;
/** 输入停顿多久后写入 localStorage，避免每敲一个字都写盘 */
const SAVE_DELAY_MS = 300;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 解码 query 值；非法转义时保留原文，避免整段参数消失 */
function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

function splitUrl(url: string): { base: string; query: string } {
  const index = url.indexOf("?");
  return index === -1
    ? { base: url, query: "" }
    : { base: url.slice(0, index), query: url.slice(index + 1) };
}

function parseQuery(query: string): Pair[] {
  if (!query) return [];
  return query
    .split("&")
    .filter((part) => part !== "")
    .map((part) => {
      const eq = part.indexOf("=");
      return eq === -1
        ? [safeDecode(part), ""]
        : [safeDecode(part.slice(0, eq)), safeDecode(part.slice(eq + 1))];
    });
}

function buildQuery(pairs: Pair[]): string {
  return pairs
    .filter(([key]) => key.trim() !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

/** 没写协议时按 http 处理（调试本地服务更常见），并去掉首尾空白 */
function normalizeUrl(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text) ? text : `http://${text}`;
}

function defaultState(): RequestState {
  return { method: "GET", url: "", headers: [], bodyType: "none", body: "", form: [] };
}

function cloneRequest(request: RequestState): RequestState {
  return {
    method: request.method,
    url: request.url,
    headers: request.headers.map(([k, v]) => [k, v] as Pair),
    bodyType: request.bodyType,
    body: request.body,
    form: request.form.map((row) => ({ ...row })),
  };
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 本地存储写满时静默失败，不影响当前会话使用
  }
}

/** 键值对编辑器：请求头、查询参数共用 */
function createPairEditor(
  keyPlaceholder: string,
  valuePlaceholder: string,
  onChange: () => void,
): { element: HTMLElement; get(): Pair[]; set(rows: Pair[]): void } {
  const element = el("div", "plugin-http-kv");
  const rowsHost = el("div", "plugin-http-kv-rows");

  const addRow = (key = "", value = ""): void => {
    const row = el("div", "plugin-http-kv-row");
    const keyInput = el("input", "plugin-http-kv-key") as HTMLInputElement;
    keyInput.placeholder = keyPlaceholder;
    keyInput.value = key;
    const valueInput = el("input", "plugin-http-kv-value") as HTMLInputElement;
    valueInput.placeholder = valuePlaceholder;
    valueInput.value = value;
    const remove = el("button", "plugin-http-kv-remove", "×");
    remove.title = "删除这一行";
    remove.addEventListener("click", () => {
      row.remove();
      onChange();
    });
    keyInput.addEventListener("input", onChange);
    valueInput.addEventListener("input", onChange);
    row.append(keyInput, valueInput, remove);
    rowsHost.append(row);
  };

  const addButton = el("button", "plugin-http-kv-add", "＋ 添加一行");
  addButton.addEventListener("click", () => {
    addRow();
    onChange();
  });
  element.append(rowsHost, addButton);

  return {
    element,
    get: () =>
      Array.from(rowsHost.querySelectorAll<HTMLElement>(".plugin-http-kv-row"))
        .map((row) => {
          const inputs = row.querySelectorAll<HTMLInputElement>("input");
          return [inputs[0].value, inputs[1].value] as Pair;
        })
        .filter(([key]) => key.trim() !== ""),
    set: (rows) => {
      rowsHost.replaceChildren();
      if (!rows.length) addRow();
      else for (const [key, value] of rows) addRow(key, value);
    },
  };
}

/** multipart 表单编辑器：每行可以是普通字段或本地文件 */
function createFormEditor(
  pickFile: (row: FormRow, refresh: () => void) => void,
  onChange: () => void,
): { element: HTMLElement; get(): FormRow[]; set(rows: FormRow[]): void } {
  const element = el("div", "plugin-http-kv");
  const rowsHost = el("div", "plugin-http-kv-rows");

  const addRow = (initial?: FormRow): void => {
    const data: FormRow = initial ?? { key: "", value: "", filePath: null };
    const row = el("div", "plugin-http-kv-row");
    const keyInput = el("input", "plugin-http-kv-key") as HTMLInputElement;
    keyInput.placeholder = "字段名";
    keyInput.value = data.key;
    const valueInput = el("input", "plugin-http-kv-value") as HTMLInputElement;
    valueInput.placeholder = "字段值（选文件后忽略）";
    valueInput.value = data.value;
    const fileButton = el("button", "plugin-http-file", "选择文件…");
    const remove = el("button", "plugin-http-kv-remove", "×");
    remove.title = "删除这一行";

    const refresh = (): void => {
      keyInput.value = data.key;
      valueInput.value = data.value;
      const name = data.filePath ? data.filePath.replace(/^.*[\\/]/, "") : "";
      fileButton.textContent = name || "选择文件…";
      fileButton.title = data.filePath ?? "选择一个文件作为该字段的值";
      fileButton.dataset.path = data.filePath ?? "";
      fileButton.classList.toggle("has-file", Boolean(data.filePath));
      valueInput.disabled = Boolean(data.filePath);
    };

    keyInput.addEventListener("input", () => {
      data.key = keyInput.value;
      onChange();
    });
    valueInput.addEventListener("input", () => {
      data.value = valueInput.value;
      onChange();
    });
    fileButton.addEventListener("click", () => pickFile(data, refresh));
    remove.addEventListener("click", () => {
      row.remove();
      onChange();
    });
    row.append(keyInput, valueInput, fileButton, remove);
    rowsHost.append(row);
  };

  const addButton = el("button", "plugin-http-kv-add", "＋ 添加字段");
  addButton.addEventListener("click", () => {
    addRow();
    onChange();
  });
  element.append(rowsHost, addButton);

  return {
    element,
    get: () =>
      Array.from(rowsHost.querySelectorAll<HTMLElement>(".plugin-http-kv-row")).map((row) => {
        const inputs = row.querySelectorAll<HTMLInputElement>("input");
        const button = row.querySelector<HTMLElement>(".plugin-http-file");
        return {
          key: inputs[0].value,
          value: inputs[1].value,
          filePath: button?.dataset.path || null,
        };
      }),
    set: (rows) => {
      rowsHost.replaceChildren();
      if (!rows.length) addRow();
      else for (const row of rows) addRow({ ...row });
    },
  };
}

function toCurl(request: RequestState): string {
  const url = normalizeUrl(request.url);
  const parts = [`curl -X ${request.method} "${url}"`];
  for (const [key, value] of request.headers) {
    if (key.trim()) parts.push(`-H "${key}: ${value}"`);
  }
  if (request.bodyType === "multipart") {
    for (const row of request.form) {
      if (!row.key.trim()) continue;
      parts.push(
        row.filePath
          ? `-F "${row.key}=@${row.filePath}"`
          : `-F "${row.key}=${row.value.replace(/"/g, '\\"')}"`,
      );
    }
  } else if (request.bodyType !== "none" && request.body) {
    parts.push(`--data-raw "${request.body.replace(/"/g, '\\"')}"`);
  }
  // 用续行符拼接，方便直接粘到终端里
  return parts.join(" \\\n  ");
}

function mount(host: HTMLElement, ctx: PluginContext): () => void {
  let state: RequestState = readJson<RequestState>(STORE_CURRENT, defaultState());
  let historyEntries = readJson<HistoryEntry[]>(STORE_HISTORY, []);
  let sending = false;
  let saveTimer: number | null = null;
  let syncingUrl = false;

  const root = el("div", "plugin-http");

  /* ---------- 顶部地址栏 ---------- */
  const bar = el("div", "plugin-http-bar");
  const methodSelect = el("select", "plugin-http-method") as HTMLSelectElement;
  for (const method of METHODS) {
    const option = el("option", undefined, method) as HTMLOptionElement;
    option.value = method;
    methodSelect.append(option);
  }
  methodSelect.value = state.method;

  const urlInput = el("input", "plugin-http-url") as HTMLInputElement;
  urlInput.placeholder = "输入地址，如 http://localhost:8080/api（未写协议默认 http）";
  urlInput.value = state.url;
  urlInput.spellcheck = false;

  const sendButton = el("button", "plugin-http-send", "发送");
  const curlButton = el("button", "plugin-http-tool", "复制 curl");
  const historySelect = el("select", "plugin-http-history") as HTMLSelectElement;
  bar.append(methodSelect, urlInput, sendButton, curlButton, historySelect);

  /* ---------- 左侧请求区 ---------- */
  const requestPane = el("section", "plugin-http-pane");
  const requestTabs = el("div", "plugin-http-tabs");
  const requestBody = el("div", "plugin-http-page");

  const paramsEditor = createPairEditor("参数名", "参数值", () => {
    if (syncingUrl) return;
    const { base } = splitUrl(urlInput.value);
    const query = buildQuery(paramsEditor.get());
    urlInput.value = query ? `${base}?${query}` : base;
    state.url = urlInput.value;
    scheduleSave();
  });
  const headersEditor = createPairEditor("Header", "值", () => {
    state.headers = headersEditor.get();
    scheduleSave();
  });

  // 请求体：类型 + 文本域 / multipart 表单
  const bodyTypeSelect = el("select", "plugin-http-body-type") as HTMLSelectElement;
  for (const [value, label] of [
    ["none", "无"],
    ["text", "文本"],
    ["json", "JSON"],
    ["multipart", "表单（可传文件）"],
  ] as const) {
    const option = el("option", undefined, label) as HTMLOptionElement;
    option.value = value;
    bodyTypeSelect.append(option);
  }
  bodyTypeSelect.value = state.bodyType;

  const bodyText = el("textarea", "plugin-http-body-text") as HTMLTextAreaElement;
  bodyText.placeholder = "请求体内容";
  bodyText.spellcheck = false;
  bodyText.value = state.body;

  const formatButton = el("button", "plugin-http-tool", "格式化 JSON");
  formatButton.addEventListener("click", () => {
    try {
      bodyText.value = JSON.stringify(JSON.parse(bodyText.value), null, 2);
      state.body = bodyText.value;
      scheduleSave();
      ctx.showStatus("JSON 已格式化");
    } catch {
      ctx.showStatus("JSON 格式不正确");
    }
  });

  const formEditor = createFormEditor(
    (row, refresh) => {
      void (async () => {
        const paths = await ctx.pickFiles();
        if (!paths.length) return;
        row.filePath = paths[0];
        refresh();
        onChangeForm();
      })();
    },
    () => onChangeForm(),
  );

  function onChangeForm(): void {
    state.form = formEditor.get();
    scheduleSave();
  }

  const bodyHead = el("div", "plugin-http-body-head");
  bodyHead.append(bodyTypeSelect, formatButton);
  const bodyPage = el("div", "plugin-http-body");
  bodyPage.append(bodyHead, bodyText, formEditor.element);

  const pages: Record<string, HTMLElement> = {
    params: paramsEditor.element,
    headers: headersEditor.element,
    body: bodyPage,
  };
  let activeRequestTab = "params";
  const requestTabButtons: HTMLButtonElement[] = [];
  for (const [key, label] of [
    ["params", "参数"],
    ["headers", "请求头"],
    ["body", "请求体"],
  ] as const) {
    const button = el("button", "plugin-http-tab", label);
    button.addEventListener("click", () => {
      activeRequestTab = key;
      for (const [k, page] of Object.entries(pages)) page.hidden = k !== key;
      for (const b of requestTabButtons) b.classList.toggle("active", b === button);
    });
    requestTabButtons.push(button);
    requestTabs.append(button);
  }
  requestBody.append(pages.params, pages.headers, pages.body);
  pages.headers.hidden = true;
  pages.body.hidden = true;
  requestPane.append(requestTabs, requestBody);

  /* ---------- 右侧响应区 ---------- */
  const responsePane = el("section", "plugin-http-pane");
  const statusLine = el("div", "plugin-http-status");
  statusLine.textContent = "尚未发送请求";

  const responseTabs = el("div", "plugin-http-tabs");
  const responseBody = el("div", "plugin-http-page");
  const bodyPre = el("pre", "plugin-http-pre");
  const headersTable = el("div", "plugin-http-headers");
  const previewFrame = el("iframe", "plugin-http-preview") as HTMLIFrameElement;
  // 不允许 same-origin：页面被隔离在独立源里，拿不到主程序接口
  previewFrame.setAttribute("sandbox", "allow-forms allow-popups");
  previewFrame.title = "HTML 响应预览";
  /** 预览用 Blob URL；CSP 的 frame-src 已放行 blob:，且 blob 文档仍继承 script-src，脚本不会执行 */
  let previewUrl = "";
  const setPreview = (html: string): void => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = "";
    }
    if (!html) {
      previewFrame.removeAttribute("src");
      return;
    }
    previewUrl = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    previewFrame.src = previewUrl;
  };

  const responsePages: Record<string, HTMLElement> = {
    body: bodyPre,
    headers: headersTable,
    preview: previewFrame,
  };
  const responseTabButtons: HTMLButtonElement[] = [];
  for (const [key, label] of [
    ["body", "响应体"],
    ["headers", "响应头"],
    ["preview", "预览"],
  ] as const) {
    const button = el("button", "plugin-http-tab", label);
    button.addEventListener("click", () => {
      for (const [k, page] of Object.entries(responsePages)) page.hidden = k !== key;
      for (const b of responseTabButtons) b.classList.toggle("active", b === button);
    });
    responseTabButtons.push(button);
    responseTabs.append(button);
    if (key === "preview") button.hidden = true;
  }
  responseTabButtons[0].classList.add("active");
  responseBody.append(bodyPre, headersTable, previewFrame);
  headersTable.hidden = true;
  previewFrame.hidden = true;
  responsePane.append(statusLine, responseTabs, responseBody);

  const main = el("div", "plugin-http-main");
  main.append(requestPane, responsePane);
  root.append(bar, main);
  host.append(root);

  /* ---------- 状态与持久化 ---------- */
  const scheduleSave = (): void => {
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      writeJson(STORE_CURRENT, state);
    }, SAVE_DELAY_MS);
  };

  const refreshHistory = (): void => {
    historySelect.replaceChildren();
    const placeholder = el("option", undefined, "历史记录") as HTMLOptionElement;
    placeholder.value = "";
    historySelect.append(placeholder);
    historyEntries.forEach((entry, index) => {
      const time = new Date(entry.at).toLocaleTimeString();
      const label = `${entry.status} · ${entry.request.method} ${entry.request.url} · ${time}`;
      const option = el("option", undefined, label) as HTMLOptionElement;
      option.value = String(index);
      historySelect.append(option);
    });
    historySelect.value = "";
  };

  const applyState = (next: RequestState): void => {
    state = cloneRequest(next);
    methodSelect.value = state.method;
    urlInput.value = state.url;
    headersEditor.set(state.headers);
    bodyTypeSelect.value = state.bodyType;
    bodyText.value = state.body;
    formEditor.set(state.form);
    updateBodyVisibility();
    // URL → 参数：进入编辑时按当前地址解析一次
    paramsEditor.set(parseQuery(splitUrl(state.url).query));
    scheduleSave();
  };

  const updateBodyVisibility = (): void => {
    const multipart = bodyTypeSelect.value === "multipart";
    bodyText.hidden = multipart;
    formEditor.element.hidden = !multipart;
    formatButton.hidden = bodyTypeSelect.value !== "json";
  };

  /* ---------- 事件绑定 ---------- */
  methodSelect.addEventListener("change", () => {
    state.method = methodSelect.value;
    scheduleSave();
  });

  urlInput.addEventListener("input", () => {
    state.url = urlInput.value;
    scheduleSave();
  });

  // 失焦时把地址里的 query 同步进「参数」页，方便逐项修改
  urlInput.addEventListener("change", () => {
    syncingUrl = true;
    paramsEditor.set(parseQuery(splitUrl(urlInput.value).query));
    syncingUrl = false;
  });

  bodyTypeSelect.addEventListener("change", () => {
    state.bodyType = bodyTypeSelect.value as BodyType;
    updateBodyVisibility();
    scheduleSave();
  });

  bodyText.addEventListener("input", () => {
    state.body = bodyText.value;
    scheduleSave();
  });

  historySelect.addEventListener("change", () => {
    const index = Number(historySelect.value);
    if (Number.isNaN(index) || !historyEntries[index]) return;
    applyState(historyEntries[index].request);
    statusLine.textContent = `已载入历史记录（${new Date(historyEntries[index].at).toLocaleString()}）`;
  });

  curlButton.addEventListener("click", () => {
    const command = toCurl({
      ...state,
      url: normalizeUrl(state.url),
      headers: headersEditor.get(),
      form: formEditor.get(),
      body: bodyText.value,
    });
    void navigator.clipboard.writeText(command).then(
      () => ctx.showStatus("curl 已复制到剪贴板"),
      () => ctx.showStatus("复制失败，请检查剪贴板权限"),
    );
  });

  /* ---------- 发送与渲染 ---------- */
  const renderResponse = (response: HttpResponse): void => {
    const ok = response.status >= 200 && response.status < 400;
    statusLine.replaceChildren();
    statusLine.append(
      el("span", `plugin-http-code ${ok ? "ok" : "bad"}`, `${response.status} ${response.statusText}`),
      el("span", "plugin-http-meta", `${response.elapsedMs} ms`),
      el("span", "plugin-http-meta", formatSize(response.size)),
    );
    if (response.truncated) {
      statusLine.append(el("span", "plugin-http-warn", "响应过大，仅显示前 5 MB"));
    }
    if (response.url && response.url !== normalizeUrl(urlInput.value)) {
      statusLine.append(el("span", "plugin-http-meta", `最终地址：${response.url}`));
    }

    // 正文一键复制，方便贴到别处比对
    if (!response.binary) {
      const copyButton = el("button", "plugin-http-tool", "复制正文");
      copyButton.addEventListener("click", () => {
        void navigator.clipboard.writeText(bodyPre.textContent ?? "").then(
          () => ctx.showStatus("正文已复制"),
          () => ctx.showStatus("复制失败，请检查剪贴板权限"),
        );
      });
      statusLine.append(copyButton);
    }

    const contentType = response.headers
      .find(([key]) => key.toLowerCase() === "content-type")?.[1] ?? "";

    // 正文：JSON 自动美化，二进制只提示大小
    if (response.binary) {
      bodyPre.textContent = `二进制响应（${formatSize(response.size)}），不展示正文`;
    } else {
      let text = response.body;
      if (contentType.includes("json")) {
        try {
          text = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          // 声明是 JSON 但内容不合法时按原文展示
        }
      }
      bodyPre.textContent = text || "（空响应体）";
    }

    headersTable.replaceChildren();
    for (const [key, value] of response.headers) {
      const row = el("div", "plugin-http-header-row");
      row.append(el("span", "plugin-http-header-name", key), el("span", "plugin-http-header-value", value));
      headersTable.append(row);
    }

    // 只有 HTML 响应才提供沙箱预览；脚本因 CSP 不会执行
    const isHtml = contentType.includes("text/html");
    responseTabButtons[2].hidden = !isHtml;
    setPreview(isHtml ? response.body : "");

    // 每次响应默认停在正文页
    responseTabButtons[0].click();
  };

  const pushHistory = (status: number): void => {
    historyEntries.unshift({ at: Date.now(), status, request: cloneRequest(state) });
    historyEntries = historyEntries.slice(0, MAX_HISTORY);
    writeJson(STORE_HISTORY, historyEntries);
    refreshHistory();
  };

  const send = (): void => {
    if (sending) return;
    const url = normalizeUrl(urlInput.value);
    if (!url) {
      statusLine.textContent = "请输入请求地址";
      urlInput.focus();
      return;
    }
    // 发送前把「参数」页的修改合并进地址；没有参数行时保持地址原样，
    // 避免刚粘进来的完整 URL（带 query）在回车发送时被截断
    const queryRows = paramsEditor.get();
    const finalUrl = queryRows.length ? `${splitUrl(url).base}?${buildQuery(queryRows)}` : url;
    state = {
      method: methodSelect.value,
      url: finalUrl,
      headers: headersEditor.get(),
      bodyType: bodyTypeSelect.value as BodyType,
      body: bodyText.value,
      form: formEditor.get(),
    };
    urlInput.value = finalUrl;
    scheduleSave();

    sending = true;
    sendButton.disabled = true;
    sendButton.textContent = "发送中…";
    statusLine.textContent = "请求中…";
    void invoke<HttpResponse>("http_send", {
      input: {
        method: state.method,
        url: state.url,
        headers: state.headers,
        body: state.bodyType === "text" || state.bodyType === "json" ? state.body : null,
        bodyType: state.bodyType,
        form: state.form.map((row) => ({
          key: row.key,
          value: row.value,
          filePath: row.filePath,
          fileName: null,
        })),
      },
    })
      .then((response) => {
        renderResponse(response);
        pushHistory(response.status);
      })
      .catch((error: unknown) => {
        statusLine.textContent = `请求失败：${String(error)}`;
        statusLine.classList.add("error");
        window.setTimeout(() => statusLine.classList.remove("error"), 2000);
      })
      .finally(() => {
        sending = false;
        sendButton.disabled = false;
        sendButton.textContent = "发送";
      });
  };

  sendButton.addEventListener("click", send);
  // 地址栏回车直接发送，和浏览器习惯一致
  urlInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      send();
    }
  });

  /* ---------- 初始化 ---------- */
  headersEditor.set(state.headers);
  bodyTypeSelect.value = state.bodyType;
  bodyText.value = state.body;
  formEditor.set(state.form);
  paramsEditor.set(parseQuery(splitUrl(state.url).query));
  updateBodyVisibility();
  requestTabButtons[0].classList.add("active");
  refreshHistory();

  return () => {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      writeJson(STORE_CURRENT, state);
    }
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = "";
    }
    previewFrame.removeAttribute("src");
  };
}

const plugin: ToolPlugin = {
  id: "http",
  title: "HTTP 调试",
  menuId: "tools.http",
  shortcut: "Ctrl+Shift+H",
  // 左右两栏 + 地址栏，比默认高度高一些才不憋屈
  preferredHeight: 460,
  mount,
};

export default plugin;
