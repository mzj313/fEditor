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

rem A running app locks the release binary, so refuse to build until it is closed
tasklist /fi "imagename eq file-editor.exe" 2>nul | find /i "file-editor.exe" >nul
if not errorlevel 1 (
  echo [ERROR] fEditor is running. Please close it and try again.
  call :finish 1
  exit /b 1
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

set "TOO_BIG="
for %%f in (dist-build\fEditor.exe) do (
  echo Done: %%~ff  %%~zf bytes
  rem dist is never cleared, so stale chunks slowly inflate the exe.
  rem Past 10 MB (10485760 bytes), drop dist after packaging: the next
  rem build starts from scratch and drops back to normal size.
  if %%~zf GTR 10485760 set "TOO_BIG=1"
)
if defined TOO_BIG (
  echo [INFO] fEditor.exe is larger than 10 MB. Clearing dist so the next build is clean.
  if exist dist rmdir /s /q dist
  echo [INFO] The current exe still carries the stale chunks. Run this script once more to get a smaller one.
)
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
