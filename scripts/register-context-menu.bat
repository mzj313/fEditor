@echo off
setlocal
rem fEditor 资源管理器右键菜单注册（只写 HKCU，无需管理员权限）
rem 用法：
rem   register-context-menu.bat                            注册，默认指向 dist-build\fEditor.exe
rem   register-context-menu.bat "D:\Tools\fEditor.exe"     指定其他位置的 exe
rem   register-context-menu.bat /remove                    移除全部注册项
rem   register-context-menu.bat --no-pause                 结尾不等待按键（供脚本调用）
rem
rem 本文件以 UTF-8 保存，必须先切到 65001，否则 cmd 会按本地代码页解析，中文字面量会损坏
chcp 65001 >nul

set "NOPAUSE="
for %%a in (%*) do if /i "%%~a"=="--no-pause" set "NOPAUSE=1"

rem Script lives in scripts\, move to the project root first
cd /d "%~dp0.."

set "LABEL=用 fEditor 打开"
rem 第一个参数若不是开关（/ 或 - 开头）才当作 exe 路径
set "EXE="
set "ARG1=%~1"
if not "%ARG1%"=="" if not "%ARG1:~0,1%"=="/" if not "%ARG1:~0,1%"=="-" set "EXE=%ARG1%"

if /i "%ARG1%"=="/remove" goto :remove

if "%EXE%"=="" set "EXE=%~dp0..\dist-build\fEditor.exe"
rem 统一成绝对路径，注册表里必须是固定位置
for %%f in ("%EXE%") do set "EXE=%%~ff"

if not exist "%EXE%" (
  echo [ERROR] 找不到 exe: %EXE%
  echo 请先运行 scripts\build-single.bat，或把 exe 路径作为第一个参数传入。
  call :finish 1
  exit /b 1
)

rem 文件右键
reg add "HKCU\Software\Classes\*\shell\fEditor" /ve /d "%LABEL%" /f >nul
if errorlevel 1 goto :fail
reg add "HKCU\Software\Classes\*\shell\fEditor" /v Icon /d "%EXE%,0" /f >nul
if errorlevel 1 goto :fail
reg add "HKCU\Software\Classes\*\shell\fEditor\command" /ve /d "\"%EXE%\" \"%%1\"" /f >nul
if errorlevel 1 goto :fail
echo [已注册] 文件右键

rem 文件夹右键
reg add "HKCU\Software\Classes\Directory\shell\fEditor" /ve /d "%LABEL%" /f >nul
if errorlevel 1 goto :fail
reg add "HKCU\Software\Classes\Directory\shell\fEditor" /v Icon /d "%EXE%,0" /f >nul
if errorlevel 1 goto :fail
reg add "HKCU\Software\Classes\Directory\shell\fEditor\command" /ve /d "\"%EXE%\" \"%%1\"" /f >nul
if errorlevel 1 goto :fail
echo [已注册] 文件夹右键

rem 文件夹空白处右键（%%V 是当前目录）
reg add "HKCU\Software\Classes\Directory\Background\shell\fEditor" /ve /d "%LABEL%" /f >nul
if errorlevel 1 goto :fail
reg add "HKCU\Software\Classes\Directory\Background\shell\fEditor" /v Icon /d "%EXE%,0" /f >nul
if errorlevel 1 goto :fail
reg add "HKCU\Software\Classes\Directory\Background\shell\fEditor\command" /ve /d "\"%EXE%\" \"%%V\"" /f >nul
if errorlevel 1 goto :fail
echo [已注册] 文件夹空白处右键

rem 加入「打开方式」候选列表
reg add "HKCU\Software\Classes\Applications\fEditor.exe\shell\open\command" /ve /d "\"%EXE%\" \"%%1\"" /f >nul
if errorlevel 1 goto :fail
reg add "HKCU\Software\Classes\Applications\fEditor.exe" /v FriendlyAppName /d "fEditor" /f >nul
if errorlevel 1 goto :fail
echo [已注册] 打开方式列表

echo.
echo 完成，exe 路径: %EXE%
echo 注意：Windows 11 需在右键的「显示更多选项」里查找（或按 Shift+F10）。
call :finish 0
exit /b 0

:remove
reg delete "HKCU\Software\Classes\*\shell\fEditor" /f >nul 2>nul
reg delete "HKCU\Software\Classes\Directory\shell\fEditor" /f >nul 2>nul
reg delete "HKCU\Software\Classes\Directory\Background\shell\fEditor" /f >nul 2>nul
reg delete "HKCU\Software\Classes\Applications\fEditor.exe" /f >nul 2>nul
echo 已移除 fEditor 的全部右键菜单注册项。
echo 资源管理器若仍显示旧菜单，重启 explorer 或注销重登即可。
call :finish 0
exit /b 0

:fail
echo.
echo 注册失败，请检查是否有权限限制或注册表被策略锁定。
call :finish 1
exit /b 1

:finish
if not defined NOPAUSE pause
exit /b %1
