/** CSV 预览渲染上限：超过只展示前 MAX_ROWS 行，避免一次性铺出几十万 DOM 节点 */
const MAX_ROWS = 5000;

export interface CsvTable {
  rows: string[][];
  /** 嗅探出的分隔符，供提示文案与未来编辑功能参考 */
  delimiter: string;
  totalRows: number;
}

/** RFC4180 状态机解析：引号包裹、字段内逗号/换行、双引号转义都按标准处理 */
function parseWith(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const pushField = (): void => {
    row.push(field);
    field = "";
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        // 双引号转义："ab""cd" 里的 "" 是内容引号
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      pushRow();
      i += 1;
      continue;
    }
    // 引号外的普通字符批量推进：逐字符拼接在大文件上是主要性能瓶颈
    let j = i;
    while (j < text.length) {
      const c = text[j];
      if (c === '"' || c === delimiter || c === "\r" || c === "\n") break;
      j += 1;
    }
    field += text.slice(i, j);
    i = j;
  }
  // 文件以换行结尾时最后的空行不算一行；非空残留才收尾
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

/**
 * 分隔符嗅探：对采样片段统计候选分隔符出现次数，取最多者。
 * 引号内的逗号会轻微干扰计数，但正常 CSV 数量级差距足以覆盖。
 */
function sniffDelimiter(text: string): string {
  const sample = text.slice(0, 2000);
  const counts: Array<{ ch: string; n: number }> = [
    { ch: ",", n: 0 },
    { ch: ";", n: 0 },
    { ch: "\t", n: 0 },
  ];
  for (const ch of sample) {
    const hit = counts.find((c) => c.ch === ch);
    if (hit) hit.n += 1;
  }
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].ch : ",";
}

/** 解析 CSV 文本；行数不截断（解析开销可接受），渲染层负责展示上限 */
export function parseCsv(text: string): CsvTable {
  const delimiter = sniffDelimiter(text);
  const rows = parseWith(text, delimiter);
  return { rows, delimiter, totalRows: rows.length };
}

/** 分隔符的可读名称，用于顶部统计文案 */
function delimiterLabel(ch: string): string {
  if (ch === "\t") return "制表符";
  if (ch === ";") return "分号";
  return "逗号";
}

/** 把解析结果渲染成表格：顶部概览 + 首行表头（sticky）+ 行号列 */
export function renderCsvPreview(host: HTMLElement, text: string): void {
  const table = parseCsv(text);
  if (table.rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "binary-error";
    empty.textContent = "文件为空";
    host.replaceChildren(empty);
    return;
  }

  // 列数取所有行最大值：残缺行也要补齐单元格，否则表格边框会错位
  const columns = table.rows.reduce((max, row) => Math.max(max, row.length), 0);

  const wrap = document.createElement("div");
  wrap.className = "csv-preview";

  const summary = document.createElement("div");
  summary.className = "csv-summary";
  const delimiter = delimiterLabel(table.delimiter);
  summary.textContent = `共 ${table.totalRows} 行 × ${columns} 列 · 分隔符：${delimiter}`;
  wrap.appendChild(summary);

  const el = document.createElement("table");
  el.className = "csv-table";

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  const corner = document.createElement("th");
  corner.className = "csv-rownum";
  corner.textContent = "#";
  headRow.appendChild(corner);
  for (let column = 0; column < columns; column++) {
    const th = document.createElement("th");
    th.textContent = table.rows[0][column] ?? "";
    headRow.appendChild(th);
  }
  head.appendChild(headRow);
  el.appendChild(head);

  const body = document.createElement("tbody");
  const shown = table.rows.slice(1, MAX_ROWS);
  shown.forEach((row, index) => {
    const tr = document.createElement("tr");
    const num = document.createElement("td");
    num.className = "csv-rownum";
    num.textContent = String(index + 1);
    tr.appendChild(num);
    for (let column = 0; column < columns; column++) {
      const td = document.createElement("td");
      td.textContent = row[column] ?? "";
      tr.appendChild(td);
    }
    body.appendChild(tr);
  });
  el.appendChild(body);
  wrap.appendChild(el);

  if (table.totalRows > MAX_ROWS) {
    const note = document.createElement("div");
    note.className = "csv-truncated";
    note.textContent = `数据量较大，仅显示前 ${MAX_ROWS} 行（共 ${table.totalRows} 行）`;
    wrap.appendChild(note);
  }
  host.replaceChildren(wrap);
}
