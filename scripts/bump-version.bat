@echo off
rem bump-version.bat -- Windows entry point. The implementation is
rem scripts/bump-version.mjs (one script for every platform); this only
rem forwards to it so a cmd.exe or PowerShell user can type the same command.
node "%~dp0bump-version.mjs" %*
