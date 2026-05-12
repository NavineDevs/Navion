@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Git is not installed or not in PATH.','Push to GitHub') | Out-Null"
  exit /b 1
)

for /f "delims=" %%I in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "BRANCH=%%I"
if not defined BRANCH set "BRANCH=main"

for /f "delims=" %%I in ('powershell -NoProfile -Command "[void][Reflection.Assembly]::LoadWithPartialName('Microsoft.VisualBasic'); [Microsoft.VisualBasic.Interaction]::InputBox('Commit message','Push to GitHub','update navion') "') do set "MSG=%%I"
if not defined MSG exit /b 0

git add -A
git diff --cached --quiet
if %errorlevel%==0 (
  powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('No changes to commit.','Push to GitHub') | Out-Null"
  exit /b 0
)

git commit -m "%MSG%"
if errorlevel 1 (
  powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Commit failed. Check terminal output.','Push to GitHub') | Out-Null"
  exit /b 1
)

git push origin %BRANCH%
if errorlevel 1 (
  powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Push failed. Check terminal output.','Push to GitHub') | Out-Null"
  exit /b 1
)

powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Push completed successfully.','Push to GitHub') | Out-Null"
exit /b 0
