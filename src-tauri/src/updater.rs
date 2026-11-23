//! 自动更新：从 Gitee release 检查新版本，下载新启动器并在重启时替换。
//! 更新对象是启动器（launcher 启动主程序时通过 FEDITOR_LAUNCHER 环境变量
//! 告知自身位置），重启后由新启动器解包最新主程序，主程序副本无需单独更新。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const RELEASE_API: &str = "https://gitee.com/api/v5/repos/mzj313/fEditor/releases/latest";
const RELEASE_PAGE: &str = "https://gitee.com/mzj313/fEditor/releases/latest";

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    assets: Vec<ReleaseAsset>,
}

#[derive(Deserialize, Clone)]
struct ReleaseAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

#[derive(Serialize)]
pub struct UpdateInfo {
    has_update: bool,
    current: String,
    latest: String,
    changelog: String,
    download_url: Option<String>,
    asset_size: Option<u64>,
    /// 启动器位置；直接运行主程序（开发模式）时为 None，无法自动替换
    launcher_path: Option<String>,
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("网络客户端创建失败：{e}"))
}

/// 把 "v1.2.3" 或 "1.2.3" 拆成数字段；解析失败返回 None
fn parse_version(text: &str) -> Option<Vec<u32>> {
    let core = text.trim().trim_start_matches('v');
    core.split('.')
        .map(|p| p.trim().parse().ok())
        .collect::<Option<Vec<_>>>()
}

/// 逐段比较版本号，缺失的段按 0 处理
fn version_newer(latest: &str, current: &str) -> bool {
    let (Some(a), Some(b)) = (parse_version(latest), parse_version(current)) else {
        return false;
    };
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

/// 启动器位置来自 launcher 启动主程序时注入的环境变量
fn launcher_path() -> Option<PathBuf> {
    std::env::var("FEDITOR_LAUNCHER").ok().map(PathBuf::from)
}

/// 查询 Gitee 最新 release，与当前版本比较
#[tauri::command]
pub fn update_check(app: AppHandle) -> Result<UpdateInfo, String> {
    let body = client()?
        .get(RELEASE_API)
        .send()
        .map_err(|e| format!("查询更新失败：{e}"))?
        .text()
        .map_err(|e| format!("查询更新失败：{e}"))?;
    let release: Release =
        serde_json::from_str(&body).map_err(|e| format!("解析更新信息失败：{e}"))?;

    let current = app.package_info().version.to_string();
    let asset = release
        .assets
        .iter()
        .find(|a| a.name.to_ascii_lowercase().ends_with(".exe"))
        .cloned();
    Ok(UpdateInfo {
        has_update: version_newer(&release.tag_name, &current),
        current,
        latest: release.tag_name,
        changelog: release.body,
        download_url: asset.as_ref().map(|a| a.browser_download_url.clone()),
        asset_size: asset.as_ref().map(|a| a.size),
        launcher_path: launcher_path().map(|p| p.to_string_lossy().into_owned()),
    })
}

/// 下载新启动器并就地替换：先下载到临时文件，再把运行中的旧文件改名腾位
#[tauri::command]
pub fn update_download(url: String, launcher: String) -> Result<(), String> {
    let target = PathBuf::from(&launcher);
    let dir = target
        .parent()
        .ok_or_else(|| "启动器路径异常".to_string())?;
    let new_file = dir.join("fEditor.update.exe");
    let old_file = dir.join("fEditor.old.exe");

    let bytes = client()?
        .get(&url)
        .send()
        .map_err(|e| format!("下载失败：{e}"))?
        .bytes()
        .map_err(|e| format!("下载失败：{e}"))?;
    std::fs::write(&new_file, &bytes).map_err(|e| format!("写入更新文件失败：{e}"))?;

    // Windows 允许重命名运行中的 exe：旧启动器挪开，新文件顶到原名
    let _ = std::fs::remove_file(&old_file);
    std::fs::rename(&target, &old_file).map_err(|e| format!("替换启动器失败：{e}"))?;
    if let Err(e) = std::fs::rename(&new_file, &target) {
        // 回滚：把旧文件还原，避免下次启动找不到启动器
        let _ = std::fs::rename(&old_file, &target);
        return Err(format!("替换启动器失败：{e}"));
    }
    Ok(())
}

/// 用新启动器重启应用：拉起新进程后退出当前实例
#[tauri::command]
pub fn update_restart(launcher: String, app: AppHandle) -> Result<(), String> {
    std::process::Command::new(&launcher)
        .spawn()
        .map_err(|e| format!("启动新版本失败：{e}"))?;
    app.exit(0);
    Ok(())
}

/// 自动更新不可用（开发模式直接运行主程序）时，打开 release 页面手动下载
#[tauri::command]
pub fn open_release_page() -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/c", "start", "", RELEASE_PAGE])
        .spawn()
        .map_err(|e| format!("打开浏览器失败：{e}"))?;
    Ok(())
}
