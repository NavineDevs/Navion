@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Git is not installed or not in PATH.','Push to GitHub') | Out-Null"
  exit /b 1
)

set "SAFE_DIR=%cd%"
set "REMOTE_URL=https://github.com/NavineDevs/Navion.git"

git -c safe.directory="%SAFE_DIR%" remote get-url origin >nul 2>nul
if errorlevel 1 (
  git -c safe.directory="%SAFE_DIR%" remote add origin %REMOTE_URL%
) else (
  git -c safe.directory="%SAFE_DIR%" remote set-url origin %REMOTE_URL%
)

for /f "delims=" %%I in ('git -c safe.directory^="%SAFE_DIR%" rev-parse --abbrev-ref HEAD 2^>nul') do set "BRANCH=%%I"
if not defined BRANCH set "BRANCH=main"
if /I "%BRANCH%"=="HEAD" set "BRANCH=main"

for /f "delims=" %%I in ('powershell -NoProfile -Command "[void][Reflection.Assembly]::LoadWithPartialName('Microsoft.VisualBasic'); [Microsoft.VisualBasic.Interaction]::InputBox('Commit message','Push to GitHub','update navion') "') do set "MSG=%%I"
if not defined MSG exit /b 0

git -c safe.directory="%SAFE_DIR%" add -A
git -c safe.directory="%SAFE_DIR%" diff --cached --quiet
if %errorlevel%==0 (
  powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('No changes to commit.','Push to GitHub') | Out-Null"
  exit /b 0
)

git -c safe.directory="%SAFE_DIR%" commit -m "%MSG%"
if errorlevel 1 (
  powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Commit failed. Check terminal output.','Push to GitHub') | Out-Null"
  exit /b 1
)

git -c safe.directory="%SAFE_DIR%" pull --rebase origin %BRANCH%
if errorlevel 1 (
  powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Sync failed. Resolve rebase conflicts, then run again.','Push to GitHub') | Out-Null"
  exit /b 1
)

git -c safe.directory="%SAFE_DIR%" push origin HEAD:refs/heads/%BRANCH%
if errorlevel 1 (
  powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Push failed. Check terminal output.','Push to GitHub') | Out-Null"
  exit /b 1
)

powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Push completed successfully.','Push to GitHub') | Out-Null"
exit /b 0
