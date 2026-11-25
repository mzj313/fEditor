//! 桌面歌词：独立透明置顶小窗，可自由拖动
//! 歌词内容由主窗口通过 desktop-lyric 事件推送，本模块只负责窗口与位置记忆

use std::fs;

use tauri::{
    AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

const LABEL: &str = "desktop-lyrics";
const WIDTH: f64 = 760.0;
const HEIGHT: f64 = 140.0;
/// 允许在右键菜单里调整窗口大小，这里做范围兜底，避免拖出无法操作的尺寸
/// 最小高度要放得下右键菜单，避免菜单被窗口裁掉
const MIN_WIDTH: f64 = 300.0;
const MAX_WIDTH: f64 = 2000.0;
const MIN_HEIGHT: f64 = 140.0;
const MAX_HEIGHT: f64 = 500.0;
/// 记忆上次拖动后的位置，避免每次开启都回到屏幕上方
const POSITION_FILE: &str = "desktop-lyrics.pos";

fn lyrics_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

fn save_position(app: &AppHandle) {
    let Some(window) = lyrics_window(app) else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let _ = fs::create_dir_all(&dir);
    let _ = fs::write(
        dir.join(POSITION_FILE),
        format!("{},{}", position.x, position.y),
    );
}

fn load_position(app: &AppHandle) -> Option<PhysicalPosition<i32>> {
    let dir = app.path().app_config_dir().ok()?;
    let raw = fs::read_to_string(dir.join(POSITION_FILE)).ok()?;
    let (x, y) = raw.split_once(',')?;
    let x: i32 = x.trim().parse().ok()?;
    let y: i32 = y.trim().parse().ok()?;
    // 显示器拔插或分辨率变化后，旧坐标可能落在屏幕外，
    // 那样窗口建出来也看不到，宁可回退到默认位置
    let monitors = app.available_monitors().unwrap_or_default();
    let visible = monitors.iter().any(|monitor| {
        let origin = monitor.position();
        let size = monitor.size();
        x + WIDTH as i32 > origin.x
            && x < origin.x + size.width as i32
            && y + HEIGHT as i32 > origin.y
            && y < origin.y + size.height as i32
    });
    visible.then(|| PhysicalPosition::new(x, y))
}

fn create_window(app: &AppHandle) -> Result<(), String> {
    let mut builder = WebviewWindowBuilder::new(
        app,
        LABEL,
        WebviewUrl::App("src/pages/desktop-lyrics.html".into()),
    )
    .title("桌面歌词")
    .inner_size(WIDTH, HEIGHT)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(true)
    .focused(false)
    .shadow(false);

    if let Some(position) = load_position(app) {
        // 记住的是物理像素，builder.position 收的是逻辑像素；
        // 高 DPI 屏（如 macOS Retina）不换算会偏到屏幕另一角
        let scale = app
            .monitor_from_point(position.x as f64, position.y as f64)
            .ok()
            .flatten()
            .map(|monitor| monitor.scale_factor())
            .unwrap_or(1.0);
        builder = builder.position(position.x as f64 / scale, position.y as f64 / scale);
    } else if let Ok(Some(monitor)) = app.primary_monitor() {
        // 首次开启放在屏幕上方居中；用逻辑坐标，避免高 DPI 下偏移
        let scale = monitor.scale_factor();
        let size = monitor.size();
        let x = (size.width as f64 / scale - WIDTH) / 2.0;
        builder = builder.position(x.max(0.0), 72.0);
    }

    builder.build().map_err(|error| error.to_string())?;
    Ok(())
}

/// 显示/隐藏桌面歌词，返回切换后的可见状态
/// 必须是 async：同步命令跑在主线程上，而下面会调用需要事件循环响应的窗口接口
/// （outer_position / show / hide），在主线程里等待自己会造成死锁，整个应用失去响应
#[tauri::command]
pub async fn toggle_desktop_lyrics(app: AppHandle) -> Result<bool, String> {
    if let Some(window) = lyrics_window(&app) {
        if window.is_visible().map_err(|error| error.to_string())? {
            save_position(&app);
            window.hide().map_err(|error| error.to_string())?;
            return Ok(false);
        }
        window.show().map_err(|error| error.to_string())?;
        return Ok(true);
    }
    create_window(&app)?;
    Ok(true)
}

/// 调整桌面歌词窗口尺寸；前端在右键菜单里拖动滑块时调用
/// 同样必须是 async，原因与 toggle 相同：窗口接口需要事件循环响应
#[tauri::command]
pub async fn set_desktop_lyrics_size(
    app: AppHandle,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let Some(window) = lyrics_window(&app) else {
        return Ok(());
    };
    let width = width.clamp(MIN_WIDTH, MAX_WIDTH);
    let height = height.clamp(MIN_HEIGHT, MAX_HEIGHT);
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|error| error.to_string())
}
