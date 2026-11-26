//! 系统信息：CPU、内存概览 + 物理磁盘健康。
//! CPU/内存在普通权限下即可读取；磁盘的温度 / 磨损 / 通电时间
//! 需要管理员权限，点「读取详细数据」授权一次即可。
//! 数据全部来自本机，不上传任何内容。

import { invoke } from "@tauri-apps/api/core";
import type { PluginContext, ToolPlugin } from "../types";
import "./disk.css";

interface CpuInfo {
  name: string;
  cores: number;
  threads: number;
  maxClockMhz: number;
}

interface SystemInfo {
  cpus: CpuInfo[];
  cpuUsage: number;
  totalMemory: number;
  freeMemory: number;
}

interface DiskHealth {
  name: string;
  size: number;
  busType: string;
  mediaType: string;
  health: string;
  firmware: string;
  serial: string;
  temperature: number | null;
  wear: number | null;
  powerOnHours: number | null;
}

/** 自动刷新间隔：读一次要拉起 PowerShell，30 秒足够及时又不浪费 */
const REFRESH_INTERVAL = 30_000;

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

function formatBytes(bytes: number): string {
  if (!bytes) return "—";
  const gb = bytes / 1024 ** 3;
  return gb >= 1024 ? `${(gb / 1024).toFixed(2)} TB` : `${gb.toFixed(1)} GB`;
}

function formatHours(hours: number | null): string {
  if (hours === null || hours <= 0) return "—";
  const days = Math.floor(hours / 24);
  return days > 0 ? `${hours} 小时（${days} 天）` : `${hours} 小时`;
}

/** 使用率条：超过 85% 标红 */
function usageBar(percent: number): HTMLElement {
  const wrap = el("div", "sys-bar");
  const fill = el("div", percent >= 85 ? "sys-bar-fill hot" : "sys-bar-fill");
  fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  wrap.append(fill);
  return wrap;
}

function renderCpuCard(sys: SystemInfo): HTMLElement {
  const card = el("div", "sys-card");
  const head = el("div", "sys-head");
  head.append(el("span", "sys-title", "CPU"), el("span", "sys-usage", `${sys.cpuUsage}%`));

  // 多路 CPU 只展示第一颗的名称，核心/线程数按全部处理器累加更直观
  const first = sys.cpus[0];
  const cores = sys.cpus.reduce((sum, cpu) => sum + cpu.cores, 0);
  const threads = sys.cpus.reduce((sum, cpu) => sum + cpu.threads, 0);
  const clock = first
    ? first.maxClockMhz >= 1000
      ? `${(first.maxClockMhz / 1000).toFixed(2)} GHz`
      : `${first.maxClockMhz} MHz`
    : "";

  card.append(
    head,
    el("div", "sys-detail", first?.name ?? "未读取到处理器"),
    el("div", "sys-detail dim", first ? `${cores} 核 ${threads} 线程 · ${clock}` : ""),
    usageBar(sys.cpuUsage),
  );
  return card;
}

function renderMemoryCard(sys: SystemInfo): HTMLElement {
  const used = Math.max(0, sys.totalMemory - sys.freeMemory);
  const percent = sys.totalMemory > 0 ? Math.round((used / sys.totalMemory) * 100) : 0;

  const card = el("div", "sys-card");
  const head = el("div", "sys-head");
  head.append(el("span", "sys-title", "内存"), el("span", "sys-usage", `${percent}%`));

  card.append(
    head,
    el("div", "sys-detail", `${formatBytes(used)} / ${formatBytes(sys.totalMemory)} 已用`),
    el("div", "sys-detail dim", `可用 ${formatBytes(sys.freeMemory)}`),
    usageBar(percent),
  );
  return card;
}

/** 卡片里的一行「标签 + 值」 */
function row(label: string, value: string): HTMLDivElement {
  const line = el("div", "disk-row");
  line.append(el("span", "disk-label", label), el("span", "disk-value", value));
  return line;
}

function renderDiskCard(disk: DiskHealth): HTMLElement {
  const card = el("div", "disk-card");

  const head = el("div", "disk-head");
  head.append(
    el("div", "disk-name", disk.name || "未知磁盘"),
    el("div", "disk-size", formatBytes(disk.size)),
  );

  // 健康度由磨损比例换算：NVMe 的 Wear 是已用寿命百分比
  const health = disk.wear === null ? null : Math.max(0, 100 - disk.wear);
  const temperature = disk.temperature ?? null;

  const stats = el("div", "disk-stats");

  const healthBox = el("div", "disk-stat");
  healthBox.append(
    el("div", "disk-stat-label", "健康度"),
    el(
      "div",
      health !== null && health < 80 ? "disk-stat-value warn" : "disk-stat-value",
      health === null ? "—" : `${health}%`,
    ),
  );

  const tempBox = el("div", "disk-stat");
  tempBox.append(
    el("div", "disk-stat-label", "温度"),
    el(
      "div",
      temperature !== null && temperature >= 60 ? "disk-stat-value hot" : "disk-stat-value",
      temperature === null || temperature <= 0 ? "—" : `${temperature}℃`,
    ),
  );

  stats.append(healthBox, tempBox);
  card.append(head, stats);
  card.append(
    row("状态", disk.health || "—"),
    row("总线", disk.busType || "—"),
    row("固件", disk.firmware || "—"),
    row("序列号", disk.serial || "—"),
    row("通电时间", formatHours(disk.powerOnHours)),
  );
  return card;
}

/** 提权读到的详细字段：按磁盘名缓存，普通刷新时合并展示，避免温度被冲掉 */
const detailed = new Map<
  string,
  Pick<DiskHealth, "temperature" | "wear" | "powerOnHours">
>();

/** 上次提权读取的时间：打开面板自动提权时用它防抖，60 秒内不重复申请 */
let elevatedAt = 0;

export default {
  id: "system",
  title: "系统信息",
  menuId: "tools.system",
  shortcut: "Ctrl+Shift+I",
  preferredHeight: 380,
  mount(host, ctx: PluginContext) {
    host.replaceChildren();
    host.classList.add("disk-root");

    const bar = el("div", "disk-bar");
    const refresh = el("button", "disk-refresh", "刷新");
    const detail = el("button", "disk-refresh", "读取详细数据（需授权）");
    detail.title = "温度与健康度需要管理员权限，点击会弹出一次 UAC 确认";
    const autoLabel = el("label", "disk-auto");
    const autoInput = el("input");
    autoInput.type = "checkbox";
    autoLabel.append(autoInput, document.createTextNode("自动刷新（30 秒）"));
    const stamp = el("span", "disk-stamp");
    bar.append(refresh, detail, autoLabel, stamp);

    const sysGrid = el("div", "sys-grid");
    const list = el("div", "disk-list");
    host.append(bar, sysGrid, list);

    let system: SystemInfo | null = null;
    let latest: DiskHealth[] = [];
    let timer: number | null = null;
    let loading = false;

    const merged = (disk: DiskHealth): DiskHealth => {
      const extra = detailed.get(disk.name);
      return extra ? { ...disk, ...extra } : disk;
    };

    const renderSystem = (): void => {
      sysGrid.replaceChildren();
      if (system) sysGrid.append(renderCpuCard(system), renderMemoryCard(system));
    };

    const renderDisks = (): void => {
      list.replaceChildren();
      if (latest.length === 0) {
        list.append(el("div", "disk-empty", "没有读取到物理磁盘"));
        return;
      }
      for (const disk of latest) list.append(renderDiskCard(merged(disk)));
    };

    const load = async (): Promise<void> => {
      if (loading) return;
      loading = true;
      refresh.disabled = true;
      refresh.textContent = "读取中…";
      // CPU/内存与磁盘互不依赖，并行拉取缩短等待；任一失败不影响另一部分
      const [sysResult, diskResult] = await Promise.allSettled([
        invoke<SystemInfo>("read_system_info"),
        invoke<DiskHealth[]>("read_disk_health"),
      ]);
      if (sysResult.status === "fulfilled") system = sysResult.value;
      if (diskResult.status === "fulfilled") {
        latest = diskResult.value;
        stamp.textContent = `更新于 ${new Date().toLocaleTimeString()}`;
      } else {
        latest = [];
        stamp.textContent = String(diskResult.reason);
      }
      renderSystem();
      renderDisks();
      loading = false;
      refresh.disabled = false;
      refresh.textContent = "刷新";
    };

    const loadDetailed = async (manual = false): Promise<void> => {
      detail.disabled = true;
      detail.textContent = "等待授权…";
      try {
        const disks = await invoke<DiskHealth[]>("read_disk_health_elevated");
        elevatedAt = Date.now();
        for (const disk of disks) {
          detailed.set(disk.name, {
            temperature: disk.temperature,
            wear: disk.wear,
            powerOnHours: disk.powerOnHours,
          });
        }
        latest = disks;
        renderDisks();
        stamp.textContent = `详细数据更新于 ${new Date().toLocaleTimeString()}`;
        if (manual) ctx.showStatus("已读取磁盘详细数据");
      } catch (error) {
        stamp.textContent = String(error);
        if (manual) ctx.showStatus(String(error));
      } finally {
        detail.disabled = false;
        detail.textContent = "读取详细数据（需授权）";
      }
    };

    const setAuto = (enabled: boolean): void => {
      if (timer !== null) window.clearInterval(timer);
      timer = enabled ? window.setInterval(() => void load(), REFRESH_INTERVAL) : null;
    };

    refresh.addEventListener("click", () => void load());
    detail.addEventListener("click", () => void loadDetailed(true));
    autoInput.addEventListener("change", () => setAuto(autoInput.checked));

    void load();
    // 打开面板直接申请一次提权，温度/健康度不用再点按钮；
    // 60 秒内重复打开不再申请，避免频繁打扰
    if (Date.now() - elevatedAt > 60_000) void loadDetailed();

    return () => {
      if (timer !== null) window.clearInterval(timer);
      host.classList.remove("disk-root");
    };
  },
} satisfies ToolPlugin;
