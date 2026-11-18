use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// 一个 PTY 会话：master 负责读取/尺寸调整，writer 负责写入，child 用于终止进程。
/// 三者必须一起持有，drop 时由 portable-pty 负责释放对应句柄。
struct Session {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct TerminalState {
    sessions: Mutex<HashMap<u32, Session>>,
    seq: AtomicU32,
}

#[derive(Clone, Serialize)]
struct OutputPayload {
    id: u32,
    /// 直接传原始字节，前端按 Uint8Array 交给 xterm，
    /// 避免在这里做编码转换导致中文输出乱码
    data: Vec<u8>,
}

#[derive(Clone, Serialize)]
pub struct GitRepoInfo {
    /// 仓库根目录，用于确认该路径确实处于 git 托管下
    root: String,
}

#[derive(Serialize)]
pub struct OpenedTerminal {
    id: u32,
    /// 返回 shell 名称，前端据此决定切换目录的命令写法
    shell: String,
}

/// 优先 pwsh（PowerShell 7，默认 UTF-8），退回 Windows PowerShell，最后用 cmd。
#[cfg(windows)]
fn pick_shell() -> (String, Vec<String>) {
    if std::process::Command::new("pwsh")
        .arg("-NoLogo")
        .arg("-Command")
        .arg("exit 0")
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
    {
        return (
            "pwsh".to_string(),
            vec![
                "-NoLogo".into(),
                "-NoExit".into(),
                "-Command".into(),
                "[Console]::OutputEncoding=[Console]::InputEncoding=[System.Text.Encoding]::UTF8".into(),
            ],
        );
    }
    let ps = std::path::Path::new(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe");
    if ps.exists() {
        return (
            ps.to_string_lossy().to_string(),
            vec![
                "-NoLogo".into(),
                "-NoExit".into(),
                "-Command".into(),
                "chcp 65001 > $null; [Console]::OutputEncoding=[Console]::InputEncoding=[System.Text.Encoding]::UTF8".into(),
            ],
        );
    }
    ("cmd.exe".to_string(), vec!["/K".into(), "chcp 65001 > nul".into()])
}

/// macOS / Linux：用登录 shell，保证 PATH 来自用户配置（Homebrew、nvm 等）。
/// 优先 $SHELL，取不到时退回 zsh（macOS 默认），再退回 bash。
#[cfg(not(windows))]
fn pick_shell() -> (String, Vec<String>) {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|value| !value.is_empty() && std::path::Path::new(value).exists())
        .or_else(|| {
            ["/bin/zsh", "/bin/bash"]
                .into_iter()
                .find(|value| std::path::Path::new(value).exists())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "/bin/sh".to_string());
    (shell, vec!["-l".into()])
}

#[tauri::command]
pub fn terminal_open(
    app: AppHandle,
    state: State<'_, TerminalState>,
    cwd: String,
) -> Result<OpenedTerminal, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 20,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("创建终端失败：{error}"))?;

    let (shell, args) = pick_shell();
    let mut command = CommandBuilder::new(&shell);
    for arg in args {
        command.arg(arg);
    }
    command.env("TERM", "xterm-256color");
    if !cwd.is_empty() {
        command.cwd(&cwd);
    }

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("启动终端进程失败：{error}"))?;
    // slave 在 spawn 后即可释放，否则会占住句柄导致读取线程拿不到 EOF
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("读取终端输出失败：{error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("连接终端输入失败：{error}"))?;

    let id = state.seq.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut sessions = state.sessions.lock().map_err(|_| "终端状态异常")?;
        sessions.insert(
            id,
            Session {
                master: pair.master,
                writer,
                child,
            },
        );
    }

    // 独立线程持续把 PTY 输出推给前端，会话关闭时 read 返回 0 自然退出
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    let payload = OutputPayload {
                        id,
                        data: buffer[..size].to_vec(),
                    };
                    if app_handle.emit("terminal-output", payload).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    Ok(OpenedTerminal { id, shell })
}

#[tauri::command]
pub fn terminal_write(
    state: State<'_, TerminalState>,
    id: u32,
    data: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| "终端状态异常")?;
    let session = sessions.get_mut(&id).ok_or("终端会话已关闭")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|error| format!("写入终端失败：{error}"))?;
    session
        .writer
        .flush()
        .map_err(|error| format!("写入终端失败：{error}"))
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, TerminalState>,
    id: u32,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| "终端状态异常")?;
    let session = sessions.get(&id).ok_or("终端会话已关闭")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("调整终端尺寸失败：{error}"))
}

#[tauri::command]
pub fn terminal_close(state: State<'_, TerminalState>, id: u32) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| "终端状态异常")?;
    if let Some(mut session) = sessions.remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}

#[cfg(windows)]
fn git_command() -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut command = std::process::Command::new("git");
    // 后台调用 git 时不要闪黑框
    command.creation_flags(0x0800_0000);
    command
}

#[cfg(not(windows))]
fn git_command() -> std::process::Command {
    std::process::Command::new("git")
}

/// 判断目录是否处于 git 仓库中，返回仓库根目录（不是仓库时返回 None）
#[tauri::command]
pub fn git_repo_info(path: String) -> Result<Option<GitRepoInfo>, String> {
    let output = git_command()
        .arg("-C")
        .arg(&path)
        .args(["rev-parse", "--show-toplevel"])
        .output();

    let Ok(output) = output else {
        // 没装 git 或无法执行时按"非仓库"处理，不影响其它功能
        return Ok(None);
    };
    if !output.status.success() {
        return Ok(None);
    }
    let root = String::from_utf8_lossy(&output.stdout).trim().replace('\\', "/");
    if root.is_empty() {
        return Ok(None);
    }
    Ok(Some(GitRepoInfo { root }))
}
