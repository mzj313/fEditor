//! 磁盘健康：调用 Windows 自带的存储 API（Get-PhysicalDisk /
//! Get-StorageReliabilityCounter）读取型号、容量、健康度、温度等。
//!
//! 普通权限下可靠性计数器不可用（Access to a CIM resource was not available），
//! 温度 / 磨损 / 通电时间只能通过一次提权读取拿到，所以提供两个命令：
//! - read_disk_health：普通权限，只读基础信息
//! - read_disk_health_elevated：弹一次 UAC，提权进程把完整结果写临时文件后读回

use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiskHealth {
    pub name: String,
    pub size: u64,
    pub bus_type: String,
    pub media_type: String,
    pub health: String,
    pub firmware: String,
    pub serial: String,
    /// 摄氏度；不支持的盘或未提权时为 None
    pub temperature: Option<i64>,
    /// 磨损百分比 0-100；健康度 = 100 - wear
    pub wear: Option<i64>,
    pub power_on_hours: Option<i64>,
}

/// 系统信息概览：一次调用同时返回 CPU/内存与磁盘基础信息，
/// 避免前端串起两次 PowerShell，打开面板少等一次进程启动
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub system: SystemInfo,
    pub disks: Vec<DiskHealth>,
}

/// 静态信息（CPU 型号、磁盘型号/容量）几乎不变，缓存后刷新只查使用率与内存
struct StaticInfo {
    cpus: Vec<CpuInfo>,
    disks: Vec<DiskHealth>,
}

static STATIC_CACHE: std::sync::Mutex<Option<(std::time::Instant, StaticInfo)>> =
    std::sync::Mutex::new(None);
const STATIC_TTL_SECS: u64 = 600;

#[tauri::command]
pub async fn read_overview() -> Result<Overview, String> {
    tauri::async_runtime::spawn_blocking(read_overview_blocking)
        .await
        .map_err(|e| format!("读取系统信息失败：{e}"))?
}

/// 提权读取：会弹一次 UAC，成功后温度 / 磨损 / 通电时间可用
#[tauri::command]
pub async fn read_disk_health_elevated() -> Result<Vec<DiskHealth>, String> {
    tauri::async_runtime::spawn_blocking(read_disk_health_elevated_blocking)
        .await
        .map_err(|e| format!("读取磁盘信息失败：{e}"))?
}

/// 详细采集（提权用）：Get-PhysicalDisk 能带出温度、磨损、通电时间，
/// 但模块加载和可靠性计数器都很慢，只在用户授权后跑一次
#[cfg(target_os = "windows")]
const DETAIL_COLLECT_SCRIPT: &str = r#"
$disks = Get-PhysicalDisk | ForEach-Object {
  $counter = $_ | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue
  [pscustomobject]@{
    name = $_.FriendlyName
    size = $_.Size
    busType = [string]$_.BusType
    mediaType = [string]$_.MediaType
    health = [string]$_.HealthStatus
    firmware = $_.FirmwareVersion
    serial = $_.SerialNumber
    temperature = $counter.Temperature
    wear = $counter.Wear
    powerOnHours = $counter.PowerOnHours
  }
}
"#;

/// 首次调用：静态信息 + 动态信息一次拿全
#[cfg(target_os = "windows")]
const FULL_SCRIPT: &str = r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$cpus = Get-CimInstance Win32_Processor | ForEach-Object {
  [pscustomobject]@{
    name = $_.Name.Trim()
    cores = $_.NumberOfCores
    threads = $_.NumberOfLogicalProcessors
    maxClockMhz = $_.MaxClockSpeed
  }
}
$perf = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -ErrorAction SilentlyContinue
$os = Get-CimInstance Win32_OperatingSystem
$disks = Get-CimInstance Win32_DiskDrive | ForEach-Object {
  [pscustomobject]@{
    name = $_.Model
    size = $_.Size
    busType = [string]$_.InterfaceType
    mediaType = [string]$_.MediaType
    health = [string]$_.Status
    firmware = $_.FirmwareRevision
    serial = $_.SerialNumber
  }
}
[pscustomobject]@{
  cpus = @($cpus)
  cpuUsage = if ($perf) { [int]$perf.PercentProcessorTime } else { 0 }
  totalMemory = [long]$os.TotalVisibleMemorySize * 1024
  freeMemory = [long]$os.FreePhysicalMemory * 1024
  disks = @($disks)
} | ConvertTo-Json -Compress -Depth 4
"#;

/// 缓存命中后的刷新：只查会变化的使用率与内存
#[cfg(target_os = "windows")]
const DYNAMIC_SCRIPT: &str = r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$perf = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -ErrorAction SilentlyContinue
$os = Get-CimInstance Win32_OperatingSystem
[pscustomobject]@{
  cpuUsage = if ($perf) { [int]$perf.PercentProcessorTime } else { 0 }
  totalMemory = [long]$os.TotalVisibleMemorySize * 1024
  freeMemory = [long]$os.FreePhysicalMemory * 1024
} | ConvertTo-Json -Compress
"#;

#[cfg(target_os = "windows")]
fn run_powershell(script: &str) -> Result<serde_json::Value, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    // 不弹出控制台窗口
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("无法调用 PowerShell：{e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("读取系统信息失败：{}", stderr.trim()));
    }

    let text = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(text.trim_start_matches('\u{feff}').trim())
        .map_err(|e| format!("解析系统信息失败：{e}"))
}

#[cfg(target_os = "windows")]
fn read_overview_blocking() -> Result<Overview, String> {
    let cached = STATIC_CACHE.lock().ok().and_then(|guard| {
        guard.as_ref().and_then(|(at, info)| {
            (at.elapsed().as_secs() < STATIC_TTL_SECS).then(|| StaticInfo {
                cpus: info.cpus.clone(),
                disks: info.disks.clone(),
            })
        })
    });

    // 缓存有效：只跑动态脚本，省掉最慢的磁盘与 CPU 型号查询
    if let Some(info) = cached {
        let value = run_powershell(DYNAMIC_SCRIPT)?;
        return Ok(Overview {
            system: SystemInfo {
                cpus: info.cpus,
                cpu_usage: json_num(&value, "cpuUsage").unwrap_or(0),
                total_memory: value.get("totalMemory").and_then(|v| v.as_u64()).unwrap_or(0),
                free_memory: value.get("freeMemory").and_then(|v| v.as_u64()).unwrap_or(0),
            },
            disks: info.disks,
        });
    }

    let value = run_powershell(FULL_SCRIPT)?;
    let cpus = parse_cpus(&value);
    let disks = parse_disks_value(&value);
    // 写缓存失败不影响本次结果
    if let Ok(mut guard) = STATIC_CACHE.lock() {
        *guard = Some((
            std::time::Instant::now(),
            StaticInfo {
                cpus: cpus.clone(),
                disks: disks.clone(),
            },
        ));
    }
    Ok(Overview {
        system: SystemInfo {
            cpus,
            cpu_usage: json_num(&value, "cpuUsage").unwrap_or(0),
            total_memory: value.get("totalMemory").and_then(|v| v.as_u64()).unwrap_or(0),
            free_memory: value.get("freeMemory").and_then(|v| v.as_u64()).unwrap_or(0),
        },
        disks,
    })
}

#[cfg(target_os = "windows")]
fn read_disk_health_elevated_blocking() -> Result<Vec<DiskHealth>, String> {
    use std::ffi::c_void;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    // 直接调 ShellExecuteW 发起 runas；比嵌套 PowerShell 更可靠，
    // 且返回值能明确区分「用户取消 UAC」和「启动失败」
    #[link(name = "shell32")]
    unsafe extern "system" {
        fn ShellExecuteW(
            hwnd: *mut c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show: i32,
        ) -> *mut c_void;
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let temp = std::env::temp_dir();
    let out_path = temp.join(format!("feditor-disk-{stamp}.json"));
    let script_path = temp.join(format!("feditor-disk-{stamp}.ps1"));

    // 提权脚本：把 JSON 写到临时文件（runas 拿不到子进程 stdout）
    let script = format!(
        "$ErrorActionPreference = 'Stop'\r\n{DETAIL_COLLECT_SCRIPT}\r\n$json = ConvertTo-Json -InputObject @($disks) -Compress\r\n[IO.File]::WriteAllText('{out}', $json, (New-Object System.Text.UTF8Encoding($false)))",
        out = out_path.to_string_lossy().replace('\'', "''")
    );
    std::fs::write(&script_path, script).map_err(|e| format!("无法写入临时脚本：{e}"))?;

    let operation = wide("runas");
    let file = wide("powershell.exe");
    let parameters = wide(&format!(
        "-NoProfile -ExecutionPolicy Bypass -File \"{}\"",
        script_path.display()
    ));
    // SW_HIDE = 0：提权 PowerShell 不显示黑窗，UAC 确认框由系统弹出
    let launched = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            parameters.as_ptr(),
            std::ptr::null(),
            0,
        )
    };

    // ShellExecuteW 返回值 <= 32 表示失败，用户取消 UAC 时通常是 5 / 1223
    if launched as isize <= 32 {
        let _ = std::fs::remove_file(&script_path);
        return Err("已取消管理员授权".to_string());
    }

    // 提权进程在后台异步执行，轮询等待结果文件
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if out_path.exists() {
            let text =
                std::fs::read_to_string(&out_path).map_err(|e| format!("读取结果失败：{e}"))?;
            let _ = std::fs::remove_file(&out_path);
            let _ = std::fs::remove_file(&script_path);
            // PowerShell 5.1 的 UTF8 可能带 BOM，解析前去掉
            return parse_disks(text.trim_start_matches('\u{feff}').trim());
        }
        if Instant::now() > deadline {
            let _ = std::fs::remove_file(&script_path);
            return Err("提权读取超时".to_string());
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

/// JSON 对象转磁盘结构；单块盘与数组共用同一套字段映射
#[cfg(target_os = "windows")]
fn disk_from_value(item: &serde_json::Value) -> DiskHealth {
    DiskHealth {
        name: json_str(item, "name"),
        size: item.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
        bus_type: json_str(item, "busType"),
        media_type: json_str(item, "mediaType"),
        health: json_str(item, "health"),
        firmware: json_str(item, "firmware"),
        serial: json_str(item, "serial"),
        temperature: json_num(item, "temperature"),
        wear: json_num(item, "wear"),
        power_on_hours: json_num(item, "powerOnHours"),
    }
}

#[cfg(target_os = "windows")]
fn parse_disks(text: &str) -> Result<Vec<DiskHealth>, String> {
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("解析磁盘信息失败：{e}"))?;
    // 单块磁盘时 ConvertTo-Json 可能给对象而不是数组，这里统一成数组
    Ok(match value {
        serde_json::Value::Array(items) => items.iter().map(disk_from_value).collect(),
        other => vec![disk_from_value(&other)],
    })
}

/// 从概览结果里取磁盘数组，同样兼容单块盘被序列化成对象的情况
#[cfg(target_os = "windows")]
fn parse_disks_value(value: &serde_json::Value) -> Vec<DiskHealth> {
    match value.get("disks") {
        Some(serde_json::Value::Array(items)) => items.iter().map(disk_from_value).collect(),
        Some(other) => vec![disk_from_value(other)],
        None => Vec::new(),
    }
}

#[cfg(target_os = "windows")]
fn parse_cpus(value: &serde_json::Value) -> Vec<CpuInfo> {
    value
        .get("cpus")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .map(|item| CpuInfo {
                    name: json_str(item, "name"),
                    cores: json_num(item, "cores").unwrap_or(0),
                    threads: json_num(item, "threads").unwrap_or(0),
                    max_clock_mhz: json_num(item, "maxClockMhz").unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn json_str(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

#[cfg(target_os = "windows")]
fn json_num(value: &serde_json::Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|v| v.as_i64())
}

#[cfg(not(target_os = "windows"))]
fn read_overview_blocking() -> Result<Overview, String> {
    Err("当前系统暂不支持系统信息读取（仅 Windows）".to_string())
}

#[cfg(not(target_os = "windows"))]
fn read_disk_health_elevated_blocking() -> Result<Vec<DiskHealth>, String> {
    Err("当前系统暂不支持磁盘健康读取（仅 Windows）".to_string())
}

/* ---------------- CPU / 内存 ---------------- */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CpuInfo {
    pub name: String,
    pub cores: i64,
    pub threads: i64,
    pub max_clock_mhz: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub cpus: Vec<CpuInfo>,
    /// 总 CPU 使用率 0-100，来自性能计数器的采样窗口平均值
    pub cpu_usage: i64,
    pub total_memory: u64,
    pub free_memory: u64,
}
