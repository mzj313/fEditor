//! 资源管理器右键菜单集成：只读写 HKCU，不需要管理员权限。
//! 注册目标必须是单文件启动器而不是当前运行的主程序，
//! 否则更新代码后右键打开的仍是解包出来的旧副本。

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// 右键菜单文案与 scripts\register-context-menu.bat 保持一致
const LABEL: &str = "用 fEditor 打开";
/// 需要写入或清理的注册表键，全部位于 HKCU
const KEYS: [&str; 4] = [
    r"HKCU\Software\Classes\*\shell\fEditor",
    r"HKCU\Software\Classes\Directory\shell\fEditor",
    r"HKCU\Software\Classes\Directory\Background\shell\fEditor",
    r"HKCU\Software\Classes\Applications\fEditor.exe",
];

#[derive(serde::Serialize)]
pub struct ContextMenuStatus {
    /// 当前用户是否已注册右键菜单
    pub registered: bool,
    /// 已注册的可执行文件路径；未注册时为空
    pub exe_path: String,
}

/// 解析启动器路径：启动器会通过环境变量告知自身位置；
/// 直接运行主程序时回退到构建脚本维护的固定路径。
fn launcher_path() -> Result<PathBuf, String> {
    if let Ok(raw) = std::env::var("FEDITOR_LAUNCHER") {
        if !raw.is_empty() {
            return Ok(PathBuf::from(raw));
        }
    }
    let base = std::env::var("LOCALAPPDATA")
        .map_err(|_| "无法获取 LOCALAPPDATA 环境变量".to_string())?;
    Ok(Path::new(&base).join("fEditor").join("fEditor.exe"))
}

/// 执行 reg.exe 并隐藏控制台窗口，避免闪黑框
fn reg(args: &[&str]) -> Result<Output, String> {
    let mut command = Command::new("reg");
    command.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
        .output()
        .map_err(|error| format!("无法执行 reg.exe：{error}"))
}

/// 写一个字符串值；name 为 None 时写默认值
fn add(key: &str, name: Option<&str>, data: &str) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["add", key];
    match name {
        Some(value_name) => args.extend(["/v", value_name]),
        None => args.push("/ve"),
    }
    args.extend(["/d", data, "/f"]);

    let output = reg(&args)?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(format!("写入注册表失败：{key}\n{}", stderr.trim()))
}

/// 注册文件、文件夹、文件夹空白处与「打开方式」
fn register(exe: &Path) -> Result<(), String> {
    let exe_text = exe.display().to_string();
    let icon = format!("{exe_text},0");
    let open_file = format!("\"{exe_text}\" \"%1\"");
    let open_folder = format!("\"{exe_text}\" \"%V\"");

    // 文件右键
    add(KEYS[0], None, LABEL)?;
    add(KEYS[0], Some("Icon"), &icon)?;
    add(&format!("{}\\command", KEYS[0]), None, &open_file)?;

    // 文件夹右键
    add(KEYS[1], None, LABEL)?;
    add(KEYS[1], Some("Icon"), &icon)?;
    add(&format!("{}\\command", KEYS[1]), None, &open_file)?;

    // 文件夹空白处右键：%V 是当前目录
    add(KEYS[2], None, LABEL)?;
    add(KEYS[2], Some("Icon"), &icon)?;
    add(&format!("{}\\command", KEYS[2]), None, &open_folder)?;

    // 「打开方式」候选列表
    add(KEYS[3], Some("FriendlyAppName"), "fEditor")?;
    add(&format!("{}\\shell\\open\\command", KEYS[3]), None, &open_file)?;
    Ok(())
}

/// 移除全部注册项；键本来就不存在时忽略错误
fn unregister() {
    for key in KEYS {
        let _ = reg(&["delete", key, "/f"]);
    }
}

/// 从命令值中取出可执行文件路径：兼容带引号（标准写法）与
/// 不带引号的历史注册项
fn parse_exe(command_line: &str) -> String {
    let text = command_line.trim();
    if let Some(rest) = text.strip_prefix('"') {
        if let Some(end) = rest.find('"') {
            return rest[..end].to_string();
        }
    }
    // 没有引号时只能取第一段；路径含空格必须靠引号，这里仅作兼容
    text.split_whitespace().next().unwrap_or("").to_string()
}

/// 读取当前注册状态，开关初始值以此为准，避免与实际注册表不一致
fn status() -> ContextMenuStatus {
    let key = format!("{}\\command", KEYS[0]);
    let output = match reg(&["query", &key, "/ve"]) {
        Ok(value) if value.status.success() => value,
        _ => {
            return ContextMenuStatus {
                registered: false,
                exe_path: String::new(),
            }
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let exe_path = stdout
        .lines()
        .find_map(|line| line.split("REG_SZ").nth(1))
        .map(|value| parse_exe(value.trim()))
        .unwrap_or_default();
    ContextMenuStatus {
        registered: true,
        exe_path,
    }
}

#[tauri::command]
pub fn context_menu_status() -> ContextMenuStatus {
    status()
}

#[tauri::command]
pub fn set_context_menu(enabled: bool) -> Result<ContextMenuStatus, String> {
    if enabled {
        let exe = launcher_path()?;
        if !exe.exists() {
            return Err(format!(
                "未找到启动器 {}，请先运行 scripts\\build-single.bat",
                exe.display()
            ));
        }
        register(&exe)?;
    } else {
        unregister();
    }
    Ok(status())
}
