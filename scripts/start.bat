@echo off
setlocal

rem Script lives in scripts\, move to the project root first
cd /d "%~dp0.."

rem Rust is installed outside the default PATH on this machine
set "CARGO_BIN=%USERPROFILE%\.cargo\bin"
if exist "%CARGO_BIN%" set "PATH=%CARGO_BIN%;%PATH%"
set "CARGO=%USERPROFILE%\.cargo\bin\cargo.exe"
if not exist "%CARGO%" set "CARGO=cargo"

rem Only the release configuration is used: the window always shows the
rem latest code. Debug/dev mode is intentionally not offered here.

tasklist /fi "imagename eq file-editor.exe" 2>nul | find /i "file-editor.exe" >nul
if not errorlevel 1 (
  echo [ERROR] fEditor is running. Please close it and try again.
  pause
  exit /b 1
)

set "EXE=%~dp0..\src-tauri\target\release\file-editor.exe"

rem Skip the build when the release binary is newer than every tracked source.
rem dist 必须纳入检查：cargo 不会因前端资源变化而重编，漏掉会用旧 exe。
if not exist "%EXE%" goto :build
if not exist "dist\index.html" goto :build
set "STALE="
for /f "usebackq delims=" %%R in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$exe=(Get-Item -LiteralPath '%EXE%').LastWriteTimeUtc; $paths=@('src','dist','src-tauri\src','index.html','package.json','src-tauri\Cargo.toml','src-tauri\tauri.conf.json'); $newer=$paths ^| ForEach-Object { Get-Item -LiteralPath $_ -ErrorAction SilentlyContinue } ^| ForEach-Object { if ($_.PSIsContainer) { Get-ChildItem -LiteralPath $_.FullName -Recurse -File -ErrorAction SilentlyContinue } else { $_ } } ^| Where-Object { $_.LastWriteTimeUtc -gt $exe } ^| Select-Object -First 1; if ($newer) { 'stale' }"`) do set "STALE=%%R"
if not defined STALE (
  echo Source unchanged, skipping build.
  goto :start
)

:build
if not exist "node_modules" (
  echo [1/4] Installing dependencies ...
  call pnpm install
  if errorlevel 1 goto :error
)

echo [2/4] Building frontend ...
call pnpm run build
if errorlevel 1 goto :error

echo [3/4] Building desktop binary (release) ...
call "%CARGO%" build --release --features tauri/custom-protocol --manifest-path src-tauri\Cargo.toml
if errorlevel 1 goto :error

if not exist "%EXE%" (
  echo [ERROR] Build finished but the binary is missing: %EXE%
  pause
  exit /b 1
)

:start
echo [4/4] Starting fEditor ...
start "" "%EXE%"
goto :eof

:error
echo.
echo Startup failed. See the messages above.
pause
exit /b 1
