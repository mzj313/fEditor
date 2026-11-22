//! 单词发音：调用系统语音合成，离线运行，不打包音频。
//!
//! 朗读是「点一下响一遍」的一次性动作，命令启动子进程后立即返回；
//! 同一时刻只保留一路声音，新的点击会把上一段掐掉。

#[cfg(any(target_os = "macos", windows))]
use std::process::Child;
#[cfg(any(target_os = "macos", windows))]
use std::sync::Mutex;

#[cfg(any(target_os = "macos", windows))]
static CURRENT: Mutex<Option<Child>> = Mutex::new(None);

#[tauri::command]
pub fn speak_word(word: String) -> Result<(), String> {
    let text = sanitize(&word)?;
    imp::speak(&text)
}

/// 只接受英文单词。词典条目本身就是这种形式，这里再收一次口，
/// 避免把任意文本原样交给系统命令。
fn sanitize(word: &str) -> Result<String, String> {
    let text = word.trim();
    if text.is_empty() || text.len() > 64 {
        return Err("没有可朗读的内容".into());
    }
    if !text
        .chars()
        .all(|c| c.is_ascii_alphabetic() || c == '\'' || c == '-' || c == ' ')
    {
        return Err("只支持英文单词发音".into());
    }
    Ok(text.to_string())
}

/// 换上新进程前先结束上一段朗读，避免两次发音叠在一起
#[cfg(any(target_os = "macos", windows))]
fn replace(next: Child) {
    if let Ok(mut slot) = CURRENT.lock() {
        if let Some(mut previous) = slot.take() {
            let _ = previous.kill();
            let _ = previous.wait();
        }
        *slot = Some(next);
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::process::{Command, Stdio};
    use std::sync::OnceLock;

    pub fn speak(text: &str) -> Result<(), String> {
        let mut command = Command::new("say");
        command.arg("-r").arg("165");
        if let Some(voice) = english_voice() {
            command.arg("-v").arg(voice);
        }
        let child = command
            .arg(text)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("启动系统语音失败：{error}"))?;
        super::replace(child);
        Ok(())
    }

    /// 系统默认音色可能是中文，读英文会很怪；优先挑一个英文音色。
    /// 列表格式为「名称 + 语言 + # 示例」，名称本身可能带空格，
    /// 中文系统下还会跟着本地化的语言名。
    fn english_voice() -> Option<&'static str> {
        /// 优先选自然人声，避开 Albert、Bad News 这类列表里更靠前的趣味音色
        const PREFERRED: [&str; 12] = [
            "Samantha", "Ava", "Allison", "Susan", "Tom", "Alex", "Daniel", "Karen", "Moira",
            "Serena", "Tessa", "Fiona",
        ];

        static VOICE: OnceLock<Option<String>> = OnceLock::new();
        VOICE
            .get_or_init(|| {
                let output = Command::new("say").arg("-v").arg("?").output().ok()?;
                if !output.status.success() {
                    return None;
                }
                let listing = String::from_utf8_lossy(&output.stdout);
                let mut first_us = None;
                let mut first_en = None;
                for line in listing.lines() {
                    let entry = line.split('#').next().unwrap_or("").trim();
                    let parts: Vec<&str> = entry.split_whitespace().collect();
                    let Some(locale_at) = parts
                        .iter()
                        .position(|part| part.starts_with("en_") || part.starts_with("en-"))
                    else {
                        continue;
                    };
                    let name = parts[..locale_at].join(" ");
                    if name.is_empty() {
                        continue;
                    }
                    let base = parts[0];
                    if PREFERRED.contains(&base) {
                        return Some(name);
                    }
                    if parts[locale_at] == "en_US" {
                        first_us.get_or_insert(name);
                    } else {
                        first_en.get_or_insert(name);
                    }
                }
                first_us.or(first_en)
            })
            .as_deref()
    }
}

#[cfg(windows)]
mod imp {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    /// 不弹出控制台窗口
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    pub fn speak(text: &str) -> Result<(), String> {
        // 词通过环境变量传入，不拼进脚本，省掉引号转义问题。
        // 默认音色可能不是英文，这里挑第一个已启用的英文语音。
        let script = "Add-Type -AssemblyName System.Speech; \
            $tts = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
            $en = $tts.GetInstalledVoices() | \
                Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'en-*' } | \
                Select-Object -First 1; \
            if ($en) { $tts.SelectVoice($en.VoiceInfo.Name) }; \
            $tts.Speak($env:FEDITOR_SPEAK_WORD)";
        let child = Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                script,
            ])
            .env("FEDITOR_SPEAK_WORD", text)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| format!("启动系统语音失败：{error}"))?;
        super::replace(child);
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    pub fn speak(_text: &str) -> Result<(), String> {
        Err("当前平台暂不支持语音朗读".into())
    }
}

#[cfg(test)]
mod tests {
    use super::sanitize;

    #[test]
    fn accepts_english_words() {
        for word in ["hello", "don't", "well-known", "New York"] {
            assert!(sanitize(word).is_ok(), "{word} 应该被接受");
        }
    }

    #[test]
    fn rejects_non_english() {
        assert!(sanitize("你好").is_err());
        assert!(sanitize("   ").is_err());
        assert!(sanitize("hello; rm -rf /").is_err());
        assert!(sanitize(&"a".repeat(65)).is_err());
    }
}
