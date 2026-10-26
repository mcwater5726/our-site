@echo off
cd /d "%~dp0"
node launcher.mjs stop
if errorlevel 1 pause
