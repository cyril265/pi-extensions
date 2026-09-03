@echo off
if "%PI_SIMPLE_SUBAGENT_ENDPOINT%"=="" goto unavailable
if "%PI_SIMPLE_SUBAGENT_TOKEN%"=="" goto unavailable
if "%PI_SIMPLE_SUBAGENT_NODE%"=="" goto unavailable
"%PI_SIMPLE_SUBAGENT_NODE%" "%~dp0subagent.mjs" %*
exit /b %ERRORLEVEL%

:unavailable
echo subagent: available only inside a live Pi session 1>&2
exit /b 1
