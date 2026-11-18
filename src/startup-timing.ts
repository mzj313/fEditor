import { invoke } from "@tauri-apps/api/core";

/** 启动分段计时的基准点：此刻依赖脚本已完成解析与求值 */
const bootT0 = performance.now();
/** 各启动阶段的相对耗时，启动完成后统一落盘（见 finishStartupTiming） */
const startupMarks: string[] = [];
/** 只有启动期间才采集，避免用户后续切换标签污染计时 */
let startupPhase = true;

export function markStartup(name: string): void {
  if (!startupPhase) return;
  startupMarks.push(`${name}: +${(performance.now() - bootT0).toFixed(1)}ms`);
}

/** 等首帧绘制完成后把分段计时写盘；仅用于排查启动性能，失败时静默忽略 */
export function finishStartupTiming(): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      markStartup("首帧绘制");
      startupPhase = false;
      const nav = performance.getEntriesByType("navigation")[0] as
        | PerformanceNavigationTiming
        | undefined;
      const head = nav
        ? `导航: responseEnd=${nav.responseEnd.toFixed(1)}ms domContentLoaded=${nav.domContentLoadedEventEnd.toFixed(1)}ms`
        : "导航: 无数据";
      // timeOrigin 是导航开始的 Unix 时间戳，用来和进程启动时刻对齐
      const content = [
        head,
        `导航起点: ${performance.timeOrigin.toFixed(0)}`,
        `脚本求值起点: ${bootT0.toFixed(1)}ms`,
        ...startupMarks,
      ].join("\n");
      void invoke("write_startup_log", { content }).catch(() => {});
    }),
  );
}
