@echo off
setlocal
rem Script lives in scripts\, move to the project root first
cd /d "%~dp0.."

rem Pass --no-pause to skip the final prompt (for CLI or CI usage)
set "NOPAUSE="
if /i "%~1"=="--no-pause" set "NOPAUSE=1"

rem Rust and MSYS2 windres are installed outside the default PATH on this machine
set "CARGO_BIN=%USERPROFILE%\.cargo\bin"
if exist "%CARGO_BIN%" set "PATH=%CARGO_BIN%;%PATH%"
if exist "C:\msys64\mingw64\bin" set "PATH=C:\msys64\mingw64\bin;%PATH%"

rem Call cargo by absolute path when possible: PATH lookups can fail intermittently
set "CARGO=cargo"
if exist "%CARGO_BIN%\cargo.exe" set "CARGO=%CARGO_BIN%\cargo.exe"

rem A running app locks the release binary, so close it first automatically.
rem Kill both the app process and the launcher, then re-check: only fail
rem if something still holds the binary after the kill attempt.
tasklist /fi "imagename eq file-editor.exe" 2>nul | find /i "file-editor.exe" >nul
if not errorlevel 1 (
  echo [INFO] fEditor is running. Closing it automatically ...
  taskkill /f /im file-editor.exe >nul 2>&1
  taskkill /f /im fEditor.exe >nul 2>&1
  rem Give Windows a moment to release the file locks
  timeout /t 2 /nobreak >nul
  tasklist /fi "imagename eq file-editor.exe" 2>nul | find /i "file-editor.exe" >nul
  if not errorlevel 1 (
    echo [ERROR] Failed to close fEditor. Please close it manually and try again.
    call :finish 1
    exit /b 1
  )
  echo [INFO] fEditor closed.
)

echo [1/4] Building frontend into dist ...
call pnpm build
if errorlevel 1 goto :fail

echo [2/4] Building desktop app (embeds dist, needs custom-protocol) ...
"%CARGO%" build --release --features tauri/custom-protocol --manifest-path src-tauri\Cargo.toml
if errorlevel 1 goto :fail

echo [3/4] Building single-file launcher (embeds app + WebView2Loader.dll) ...
"%CARGO%" build --release --manifest-path launcher\Cargo.toml
if errorlevel 1 goto :fail

echo [4/4] Copying result to dist-build and stable launcher path ...
if not exist dist-build mkdir dist-build
copy /y launcher\target\release\fEditor.exe dist-build\fEditor.exe >nul
if errorlevel 1 goto :fail

rem Keep a stable launcher outside the repository. The taskbar shortcut must
rem point at this file: every build overwrites it, so the pinned icon always
rem runs the launcher first and the launcher unpacks the newest app.
rem Do not pin the extracted copy under rt\ - it never updates by itself.
set "STABLE_DIR=%LOCALAPPDATA%\fEditor"
if not exist "%STABLE_DIR%" mkdir "%STABLE_DIR%"
copy /y launcher\target\release\fEditor.exe "%STABLE_DIR%\fEditor.exe" >nul
if errorlevel 1 (
  echo [WARN] Could not update "%STABLE_DIR%\fEditor.exe" - close the running launcher and rebuild.
) else (
  echo Stable launcher: %STABLE_DIR%\fEditor.exe
)

for %%f in (dist-build\fEditor.exe) do (
  echo Done: %%~ff  %%~zf bytes
)
rem dist 不在这里清理：vite 已开启 emptyOutDir，每次构建都会清空，
rem 删掉 dist 只会让下次 start.bat 误判为「需要重新构建」。
rem Interactive runs: offer to launch the freshly built exe, then close the window.
rem Enter alone means yes: pre-set Y and only bail out when N is typed.
if defined NOPAUSE goto :note

echo.
set "LAUNCH=Y"
set /p "LAUNCH=Open fEditor.exe now? [Y/n] "
if /i "%LAUNCH%"=="n" goto :note
echo [INFO] Opening dist-build\fEditor.exe ...
start "" "dist-build\fEditor.exe"
rem Close the console window right after launching
exit /b 0

:note
echo.
echo NOTE: frontend-only changes also require this script, assets are embedded.
call :finish 0
exit /b 0

:fail
echo.
echo Build failed. See the messages above.
call :finish 1
exit /b 1

:finish
if not defined NOPAUSE pause
exit /b %1
