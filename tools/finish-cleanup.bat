@echo off
rem One-time finisher: removes the last 3 locked files after closing TimeMark + WorkBuddy
del /q "E:\T-Minus\apps\windows\release\TimeMark-Portable-0.4.3.exe" 2>nul
rd /s /q "E:\T-Minus\apps\windows\rb_tmp" 2>nul
rd /s /q "E:\T-Minus\apps\windows\release25" 2>nul
echo.
echo Remaining release dirs:
dir /b /ad "E:\T-Minus\apps\windows\release*"
echo Remaining files in release:
dir /b "E:\T-Minus\apps\windows\release"
echo.
pause
