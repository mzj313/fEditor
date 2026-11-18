use std::path::PathBuf;
use std::process::Command;

fn main() {
    // 只有 Windows 目标才需要嵌入图标资源
    let target = std::env::var("TARGET").unwrap_or_default();
    if !target.contains("windows") {
        return;
    }

    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("缺少 OUT_DIR"));
    let icon = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("src-tauri")
        .join("icons")
        .join("icon.ico");

    if !icon.exists() {
        println!("cargo:warning=未找到图标文件，跳过图标嵌入");
        return;
    }

    // windres 用正斜杠路径更稳，避免反斜杠被当成转义字符
    let icon_path = icon.to_string_lossy().replace('\\', "/");
    let rc_path = out_dir.join("launcher.rc");
    let res_path = out_dir.join("launcher_res.o");
    let rc_content = format!("1 ICON \"{}\"\n", icon_path);
    std::fs::write(&rc_path, rc_content).expect("写入 rc 文件失败");

    let windres = locate_windres().expect("未找到 windres，无法嵌入图标");
    let status = Command::new(windres)
        .args([
            rc_path.to_string_lossy().as_ref(),
            "-O",
            "coff",
            "-o",
            res_path.to_string_lossy().as_ref(),
        ])
        .status()
        .expect("执行 windres 失败");

    if !status.success() {
        panic!("windres 编译资源失败");
    }

    // 把资源对象文件作为链接参数交给 rustc，图标才会进入最终的 exe
    println!("cargo:rustc-link-arg={}", res_path.display());
    println!("cargo:rerun-if-changed={}", icon.display());
}

/// 依次尝试 PATH 上的 windres 与常见 MSYS2 安装位置
fn locate_windres() -> Option<String> {
    let candidates = [
        "windres.exe",
        "C:/msys64/mingw64/bin/windres.exe",
        "C:/msys64/mingw64/x86_64-w64-mingw32/bin/windres.exe",
    ];
    candidates
        .iter()
        .find(|c| Command::new(*c).arg("--version").output().is_ok())
        .map(|c| c.to_string())
}
