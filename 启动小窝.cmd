@echo off
cd /d "%~dp0"
node launcher.mjs start
if errorlevel 1 pause
