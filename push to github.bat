@echo off
setlocal EnableExtensions

cd /d "%~dp0"
set "REMOTE_URL=https://github.com/NavineDevs/Navion.git"
set "DEFAULT_MESSAGE=Update Navion core"

git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 (
  echo This folder is not a git repository.
  exit /b 1
)

git remote get-url origin >nul 2>nul
if errorlevel 1 (
  git remote add origin "%REMOTE_URL%"
) else (
  git remote set-url origin "%REMOTE_URL%"
)

for /f "delims=" %%B in ('git branch --show-current') do set "BRANCH=%%B"
if not defined BRANCH set "BRANCH=main"

set /p "COMMIT_MESSAGE=Commit message [%DEFAULT_MESSAGE%]: "
if not defined COMMIT_MESSAGE set "COMMIT_MESSAGE=%DEFAULT_MESSAGE%"

git status --short
git add -A
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "%COMMIT_MESSAGE%"
) else (
  echo Nothing to commit.
)

git push -u origin "%BRANCH%"
if errorlevel 1 exit /b 1

echo Push complete.
endlocal
