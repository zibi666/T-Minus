@echo off
rem TimeMark release cleanup v2: keep ONLY release25 (v0.4.4), rename it to "release"
rem Run AFTER closing WorkBuddy and TimeMark
cd /d "E:\T-Minus\apps\windows"

for /d %%D in (release*) do if /I not "%%D"=="release25" rd /s /q "%%D"

if exist release25 (
  if not exist release ren release25 release
)

echo.
echo Done. Remaining directories:
dir /b /ad release* 2>nul
echo.
pause
