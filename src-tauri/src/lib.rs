mod clipboard;
mod desktop_lyrics;
mod dict;
mod fs_service;
mod http_client;
mod media;
mod print_service;
mod session;
mod shell_integration;
mod speech;
mod terminal;
mod updater;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

/// 任务栏按 AppUserModelID 归组。启动器与本程序使用同一个 ID，
/// 这样即使每次打包把程序解包到新的 rt-<指纹> 目录，任务栏里
/// 已固定的一项也不会分裂出第二个图标。
/// 取值与 tauri.conf.json 的 identifier 保持一致。
const APP_USER_MODEL_ID: &str = "com.mzj.file-editor";

#[cfg(windows)]
fn set_app_user_model_id(id: &str) {
    #[link(name = "shell32")]
    unsafe extern "system" {
        fn SetCurrentProcessExplicitAppUserModelID(app_id: *const u16) -> i32;
    }
    let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        SetCurrentProcessExplicitAppUserModelID(wide.as_ptr());
    }
}

#[cfg(not(windows))]
fn set_app_user_model_id(_id: &str) {}

/// macOS 会自动往「编辑」菜单末尾追加「开始听写」和「表情与符号」，
/// 这两项是系统文本输入服务，桌面编辑器用不上。AppKit 认下面两个
/// UserDefaults 键，启动时置为 true 即可不再注入；AutoFill 没有公开开关。
#[cfg(target_os = "macos")]
fn hide_system_edit_menu_extras() {
    use objc2_foundation::{NSString, NSUserDefaults};
    let defaults = NSUserDefaults::standardUserDefaults();
    defaults.setBool_forKey(true, &NSString::from_str("NSDisabledDictationMenuItem"));
    defaults.setBool_forKey(
        true,
        &NSString::from_str("NSDisabledCharacterPaletteMenuItem"),
    );
}

#[cfg(not(target_os = "macos"))]
fn hide_system_edit_menu_extras() {}

/// 打开 WebView2 的捏合与 Ctrl+滚轮缩放开关。
///
/// 经运行时日志证实：WebView2 会把触摸板双指捏合转成 ctrl + wheel 像素流送进页面
/// （单次 delta 只有几像素），页面的 wheel 监听（ui-zoom.ts）preventDefault 后
/// 内核不会真正执行整页缩放，缩放完全由前端 transform 完成。
/// 这里只负责保证手势开关是打开的；不要在内核 ZoomFactorChanged 回调里改倍率
/// （官方明确警告会重入，且实测该回调在捏合转 ctrl+wheel 的路径下根本不触发）。
#[cfg(target_os = "windows")]
fn enable_pinch_zoom(app: &tauri::App) {
    use tauri::Manager;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings5;
    use windows::core::Interface;

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.with_webview(|webview| unsafe {
        let controller = webview.controller();
        let Ok(core) = controller.CoreWebView2() else {
            return;
        };
        let Ok(settings) = core.Settings() else {
            return;
        };
        // 缩放开关需要打开，捏合手势才会被内核识别并转成 ctrl + wheel
        let _ = settings.SetIsZoomControlEnabled(true);
        // 捏合开关位于后来新增的 Settings5 接口上，需要做一次接口升级
        if let Ok(settings5) = settings.cast::<ICoreWebView2Settings5>() {
            let _ = settings5.SetIsPinchZoomEnabled(true);
        }
    });
}

#[cfg(not(target_os = "windows"))]
fn enable_pinch_zoom(_app: &tauri::App) {}

fn setup_menu(app: &tauri::App) -> tauri::Result<()> {
    // macOS 菜单栏第一项固定显示应用名，把退出单独放进这个应用菜单，
    // 后面的「文件」才不会被吞掉
    #[cfg(target_os = "macos")]
    let app_menu = Submenu::with_items(
        app,
        "fEditor",
        true,
        &[&PredefinedMenuItem::quit(app, Some("退出 fEditor"))?],
    )?;

    // 「最近」用网页下拉面板展示：原生菜单项只是文本标签，
    // 做不了悬停显示删除按钮这类交互，前端点击此项后自行弹出面板
    let file_menu = Submenu::with_items(
        app,
        "文件",
        true,
        &[
            &MenuItem::with_id(app, "file.new", "新建", true, Some("CmdOrCtrl+N"))?,
            &MenuItem::with_id(app, "file.canvas", "新建画板", true, Some("CmdOrCtrl+Shift+N"))?,
            &MenuItem::with_id(app, "file.open", "打开文件…", true, Some("CmdOrCtrl+O"))?,
            &MenuItem::with_id(
                app,
                "folder.open",
                "打开文件夹…",
                true,
                Some("CmdOrCtrl+Shift+O"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "file.recent", "最近…", true, Some("CmdOrCtrl+Alt+R"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "file.save", "保存", true, Some("CmdOrCtrl+S"))?,
            &MenuItem::with_id(
                app,
                "file.print",
                "打印预览",
                true,
                Some("CmdOrCtrl+Alt+P"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "file.reopen",
                "重新打开关闭的标签",
                true,
                Some("CmdOrCtrl+Shift+T"),
            )?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &MenuItem::with_id(app, "edit.undo", "撤销", true, Some("CmdOrCtrl+Z"))?,
            &MenuItem::with_id(app, "edit.redo", "重做", true, Some("CmdOrCtrl+Shift+Z"))?,
            &PredefinedMenuItem::separator(app)?,
            // 预定义菜单项默认文案是英文，显式传中文才能与其余菜单保持一致
            &PredefinedMenuItem::cut(app, Some("剪切"))?,
            &PredefinedMenuItem::copy(app, Some("复制"))?,
            &PredefinedMenuItem::paste(app, Some("粘贴"))?,
            &PredefinedMenuItem::select_all(app, Some("全选"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "edit.find", "查找", true, Some("CmdOrCtrl+F"))?,
            &MenuItem::with_id(app, "edit.replace", "替换", true, Some("CmdOrCtrl+H"))?,
            &MenuItem::with_id(
                app,
                "edit.findInFiles",
                "在文件中查找…",
                true,
                Some("CmdOrCtrl+Shift+F"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "edit.block", "列块模式", true, Some("CmdOrCtrl+Alt+B"))?,
        ],
    )?;

    let format_menu = Submenu::with_items(
        app,
        "格式",
        true,
        &[
            &MenuItem::with_id(app, "format.bold", "加粗", true, Some("CmdOrCtrl+B"))?,
            &MenuItem::with_id(
                app,
                "format.italic",
                "斜体",
                true,
                Some("CmdOrCtrl+Alt+I"),
            )?,
            &MenuItem::with_id(
                app,
                "format.strike",
                "删除线",
                true,
                Some("CmdOrCtrl+Shift+X"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "format.h1", "标题 1", true, Some("CmdOrCtrl+Alt+1"))?,
            &MenuItem::with_id(app, "format.h2", "标题 2", true, Some("CmdOrCtrl+Alt+2"))?,
            &MenuItem::with_id(app, "format.h3", "标题 3", true, Some("CmdOrCtrl+Alt+3"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "format.bullet",
                "无序列表",
                true,
                Some("CmdOrCtrl+Alt+L"),
            )?,
            &MenuItem::with_id(
                app,
                "format.ordered",
                "有序列表",
                true,
                Some("CmdOrCtrl+Alt+O"),
            )?,
            &MenuItem::with_id(app, "format.quote", "引用", true, Some("CmdOrCtrl+Alt+Q"))?,
            &MenuItem::with_id(app, "format.link", "链接", true, Some("CmdOrCtrl+Alt+K"))?,
            &MenuItem::with_id(
                app,
                "format.code",
                "行内代码",
                true,
                Some("CmdOrCtrl+Alt+C"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "format.document",
                "格式化文档（JSON/YAML/TOML）",
                true,
                Some("CmdOrCtrl+Alt+J"),
            )?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "视图",
        true,
        &[
            &MenuItem::with_id(
                app,
                "view.tree",
                "资源管理器",
                true,
                Some("CmdOrCtrl+Shift+E"),
            )?,
            // 反引号加速键在部分平台解析会失败，且 WebView2 下原生加速键本就不触发，
            // 快捷键统一由前端 bindShortcuts 处理，这里不声明
            &MenuItem::with_id(
                app,
                "view.terminal",
                "集成终端",
                true,
                Some("CmdOrCtrl+T"),
            )?,
            // 侧栏面板 / 预览 / 目录分三类，视觉上用分割线隔开
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "view.preview",
                "切换预览",
                true,
                Some("CmdOrCtrl+E"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "view.toc",
                "文档目录",
                true,
                Some("CmdOrCtrl+Shift+M"),
            )?,
        ],
    )?;

    // 工具类功能（对比、调试等）统一收进这里，视图菜单只保留显示/隐藏开关
    let tools_menu = Submenu::with_items(
        app,
        "工具",
        true,
        &[
            &MenuItem::with_id(
                app,
                "tools.timestamp",
                "时间戳转换…",
                true,
                Some("CmdOrCtrl+Shift+U"),
            )?,
            &MenuItem::with_id(
                app,
                "tools.jwt",
                "JWT 解码…",
                true,
                Some("CmdOrCtrl+Shift+J"),
            )?,
            &MenuItem::with_id(
                app,
                "tools.convert",
                "配置格式互转…",
                true,
                Some("CmdOrCtrl+Shift+Y"),
            )?,
            &MenuItem::with_id(
                app,
                "tools.encoding",
                "编码转换箱…",
                true,
                Some("CmdOrCtrl+Shift+G"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "tools.diff",
                "文本对比…",
                true,
                Some("CmdOrCtrl+Shift+D"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "tools.http",
                "HTTP 调试…",
                true,
                Some("CmdOrCtrl+Shift+H"),
            )?,
            &MenuItem::with_id(
                app,
                "tools.regex",
                "正则测试器…",
                true,
                Some("CmdOrCtrl+Shift+R"),
            )?,
            &MenuItem::with_id(
                app,
                "tools.color",
                "取色器…",
                true,
                Some("CmdOrCtrl+Shift+K"),
            )?,
        ],
    )?;

    // 设置类功能统一收进这个菜单，后续新增的偏好项都往这里放。
    let settings_menu = Submenu::with_items(
        app,
        "设置",
        true,
        &[
            &MenuItem::with_id(app, "settings.open", "设置…", true, Some("CmdOrCtrl+Comma"))?,
        ],
    )?;


    let help_menu = Submenu::with_items(
        app,
        "帮助",
        true,
        &[
            &MenuItem::with_id(app, "help.features", "功能说明", true, None::<&str>)?,
            &MenuItem::with_id(app, "help.update", "检查更新", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "help.about", "关于 fEditor", true, None::<&str>)?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    let menu = Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &format_menu,
            &tools_menu,
            &view_menu,
            &settings_menu,
            &help_menu,
        ],
    )?;
    #[cfg(not(target_os = "macos"))]
    let menu = Menu::with_items(
        app,
        &[
            &file_menu,
            &edit_menu,
            &format_menu,
            &tools_menu,
            &view_menu,
            &settings_menu,
            &help_menu,
        ],
    )?;
    // macOS 的菜单属于整个应用，Window::set_menu 在这里是空操作，
    // 必须挂到 App 上才会替换掉 Tauri 的默认菜单；Windows/Linux 仍只挂主窗口，
    // 避免桌面歌词等小窗也莫名其妙多出一条菜单栏
    #[cfg(target_os = "macos")]
    app.set_menu(menu)?;
    #[cfg(not(target_os = "macos"))]
    if let Some(main) = app.get_webview_window("main") {
        main.set_menu(menu)?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    hide_system_edit_menu_extras();
    // 必须在创建任何窗口之前设置，否则 Windows 会拒绝修改
    // （之后调用会返回失败，任务栏仍按 exe 路径归组）
    set_app_user_model_id(APP_USER_MODEL_ID);
    tauri::Builder::default()
        // 单实例插件必须最先注册：第二个进程启动时会转交参数并自行退出，
        // 本实例收到事件后把文件/目录转给前端打开
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let argv: Vec<String> = args.iter().skip(1).cloned().collect();
            let payload = serde_json::json!({
                "files": fs_service::files_from_args(&argv),
                "dir": fs_service::dir_from_args(&argv),
            });
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit("second-instance-args", payload);
                // 已最小化或被遮挡时把窗口带回来
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        // 只恢复位置、大小和最大化状态：可见性由前端控制，
        // 一旦被插件恢复成可见，就会出现首帧白屏
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .register_uri_scheme_protocol(media::SCHEME, |_app, request| media::handle(request))
        .manage(fs_service::AppState::default())
        .manage(terminal::TerminalState::default())
        .manage(print_service::PrintState::default())
        .setup(|app| {
            setup_menu(app)?;
            enable_pinch_zoom(app);
            // 窗口初始隐藏，由前端在首帧渲染后显示；万一前端脚本加载失败，
            // 这里做兜底，避免程序只剩一个看不见的进程
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                if let Some(window) = handle.get_webview_window("main") {
                    if !window.is_visible().unwrap_or(true) {
                        let _ = window.show();
                    }
                }
            });
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("menu-action", event.id().as_ref().to_string());
        })
        // 主窗口销毁后直接退出：桌面歌词等附属窗口不应让进程继续留在后台
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            fs_service::read_file,
            fs_service::read_file_base64,
            fs_service::save_asset,
            fs_service::read_file_with_encoding,
            fs_service::save_file,
            fs_service::path_exists,
            fs_service::create_entry,
            fs_service::rename_entry,
            fs_service::delete_entry,
            fs_service::cli_files,
            fs_service::cli_dir,
            fs_service::list_audio_siblings,
            fs_service::find_lyrics,
            desktop_lyrics::toggle_desktop_lyrics,
            desktop_lyrics::set_desktop_lyrics_size,
            fs_service::pick_open_files,
            fs_service::pick_save_path,
            fs_service::pick_open_folder,
            fs_service::set_root,
            fs_service::read_tree,
            fs_service::search_files,
            fs_service::search_content,
            fs_service::inspect_path,
            fs_service::write_startup_log,
            http_client::http_send,
            print_service::print_markdown,
            print_service::print_take_job,
            print_service::print_capture,
            session::load_session,
            session::save_session,
            shell_integration::context_menu_status,
            shell_integration::set_context_menu,
            terminal::terminal_open,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            terminal::git_repo_info,
            terminal::git_status,
            clipboard::clipboard_read,
            clipboard::clipboard_write,
            dict::dict_lookup,
            dict::dict_lookup_online,
            updater::update_check,
            updater::update_download,
            updater::update_restart,
            updater::open_release_page,
            speech::speak_word,
        ])
        .run(tauri::generate_context!())
        .expect("error while running fEditor");
}
