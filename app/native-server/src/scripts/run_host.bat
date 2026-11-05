@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "NODE_SCRIPT=%SCRIPT_DIR%\index.js"
set "NODE_EXEC=%CHROME_SHELL_NODE_PATH%"

if defined NODE_EXEC if exist "%NODE_EXEC%\*" set "NODE_EXEC=%NODE_EXEC%\node.exe"
if defined NODE_EXEC if not exist "%NODE_EXEC%" set "NODE_EXEC="

if not defined NODE_EXEC if exist "%SCRIPT_DIR%\node_path.txt" (
    set /p NODE_EXEC=<"%SCRIPT_DIR%\node_path.txt"
)
if defined NODE_EXEC if not exist "%NODE_EXEC%" set "NODE_EXEC="

if not defined NODE_EXEC (
    for /f "delims=" %%i in ('where node.exe 2^>nul') do if not defined NODE_EXEC set "NODE_EXEC=%%i"
)

if not defined NODE_EXEC exit /B 1
if not exist "%NODE_SCRIPT%" exit /B 1

set "LOG_DIR=%LOCALAPPDATA%\chrome-semantic-shell\logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" 2>nul
if exist "%LOG_DIR%" (
    "%NODE_EXEC%" "%NODE_SCRIPT%" 2>> "%LOG_DIR%\native-host.log"
) else (
    "%NODE_EXEC%" "%NODE_SCRIPT%" 2>nul
)

set "EXIT_CODE=%ERRORLEVEL%"
endlocal
exit /B %EXIT_CODE%
