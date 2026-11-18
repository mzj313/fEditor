use std::fs;
use std::io::Write;

use serde_json::Value;
use tauri::Manager;

fn session_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法取得配置目录：{e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建配置目录：{e}"))?;
    Ok(dir.join("session.json"))
}

#[tauri::command]
pub fn load_session(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    let file = session_path(&app)?;
    if !file.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&file).map_err(|e| format!("读取会话失败：{e}"))?;
    match serde_json::from_str::<Value>(&raw) {
        Ok(value) if value.get("version").and_then(|v| v.as_u64()) == Some(1) => Ok(Some(value)),
        _ => Ok(None),
    }
}

#[tauri::command]
pub fn save_session(app: tauri::AppHandle, data: Value) -> Result<(), String> {
    let file = session_path(&app)?;
    let dir = file.parent().ok_or_else(|| "会话路径无上级目录".to_string())?;
    let text = serde_json::to_vec_pretty(&data).map_err(|e| format!("序列化会话失败：{e}"))?;

    let mut tmp = tempfile::Builder::new()
        .prefix(".session-")
        .tempfile_in(dir)
        .map_err(|e| format!("创建会话临时文件失败：{e}"))?;
    tmp.write_all(&text)
        .map_err(|e| format!("写入会话失败：{e}"))?;
    tmp.as_file()
        .sync_all()
        .map_err(|e| format!("会话落盘失败：{e}"))?;
    tmp.persist(&file)
        .map_err(|e| format!("会话替换失败：{e}"))?;
    Ok(())
}
