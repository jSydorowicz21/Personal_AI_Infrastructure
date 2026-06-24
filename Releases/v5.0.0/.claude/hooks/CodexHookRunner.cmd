@echo off
setlocal

set "PAI_FRAMEWORK=%~1"
set "PAI_HOOK_TARGET=%~2"
set "PAI_HOOK_TIMEOUT_MS=%~3"
set "PAI_DATA_DIR=%~4"
set "PAI_CONFIG_DIR=%~5"

if "%PAI_FRAMEWORK%"=="" set "PAI_FRAMEWORK=codex"
if "%PAI_HOOK_TIMEOUT_MS%"=="" set "PAI_HOOK_TIMEOUT_MS=10000"

set "PAI_HOOKS_DIR=%~dp0"
for %%I in ("%PAI_HOOKS_DIR%..") do set "PAI_FRAMEWORK_DIR=%%~fI"

set "PAI_DIR=%PAI_FRAMEWORK_DIR%\PAI"
set "PAI_SETTINGS_PATH=%PAI_FRAMEWORK_DIR%\settings.json"
if "%PAI_DATA_DIR%"=="" set "PAI_DATA_DIR=%USERPROFILE%\.pai"
if "%PAI_CONFIG_DIR%"=="" set "PAI_CONFIG_DIR=%USERPROFILE%\.config\PAI"

bun "%PAI_HOOKS_DIR%FrameworkHookAdapter.ts" --framework "%PAI_FRAMEWORK%" --target "%PAI_HOOK_TARGET%" --timeout-ms "%PAI_HOOK_TIMEOUT_MS%"
exit /b %ERRORLEVEL%
