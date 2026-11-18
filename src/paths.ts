/** 与平台无关的路径小工具，从 main.ts 拆出的纯函数 */

/** 取文件的父目录，Windows 盘符根目录要补斜杠 */
export function parentDir(path: string): string {
  const unified = path.replace(/\\/g, "/");
  const cut = unified.lastIndexOf("/");
  if (cut <= 0) return path;
  const parent = unified.slice(0, cut);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent;
}

/** 把根目录路径拆成逐级可点的段，Windows 盘符单独作为第一段 */
export function splitPath(path: string): Array<{ label: string; path: string }> {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return [];
  const windows = /^[A-Za-z]:/.test(path);
  const result: Array<{ label: string; path: string }> = [];
  if (windows) {
    const first = `${parts[0]}\\`;
    result.push({ label: first, path: first });
    let current = first;
    for (const part of parts.slice(1)) {
      current = `${current}${part}\\`;
      result.push({ label: part, path: current });
    }
    return result;
  }
  // POSIX 路径没有盘符：第一段是根 "/"，所有分段都要拼进去，
  // 否则 /Users/xxx 会丢掉首段，面包屑和「上一级」会得到 /xxx 这种错路径
  result.push({ label: "/", path: "/" });
  let current = "";
  for (const part of parts) {
    current = `${current}/${part}`;
    result.push({ label: part, path: current });
  }
  return result;
}
