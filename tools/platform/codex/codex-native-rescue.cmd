@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem AICC Native rescue for Windows. This is intentionally independent of
rem OCX, Web GPT, the 17841 router, and the Codex Desktop UI.
if not defined CODEX_HOME set "CODEX_HOME=%USERPROFILE%\.codex"
if not defined AICC_STATE_ROOT set "AICC_STATE_ROOT=%USERPROFILE%\.ai-control-center"
if not defined AICC_NATIVE_RESCUE_MODEL set "AICC_NATIVE_RESCUE_MODEL=gpt-5.6-sol"
set "NATIVE_ENDPOINT=https://chatgpt.com/backend-api/codex"
set "NATIVE_CATALOG=%AICC_STATE_ROOT%\native-rescue\models.json"
set "NATIVE_CODEX="

if defined AICC_NATIVE_CODEX_EXECUTABLE set "NATIVE_CODEX=%AICC_NATIVE_CODEX_EXECUTABLE%"
if not defined NATIVE_CODEX if exist "%CODEX_HOME%\packages\standalone\current\bin\codex.exe" set "NATIVE_CODEX=%CODEX_HOME%\packages\standalone\current\bin\codex.exe"
if not defined NATIVE_CODEX if exist "%LOCALAPPDATA%\OpenAI\Codex\bin" for /f "delims=" %%D in ('dir /b /ad /o-n "%LOCALAPPDATA%\OpenAI\Codex\bin" 2^>nul') do if not defined NATIVE_CODEX if exist "%LOCALAPPDATA%\OpenAI\Codex\bin\%%D\codex.exe" set "NATIVE_CODEX=%LOCALAPPDATA%\OpenAI\Codex\bin\%%D\codex.exe"

if not defined NATIVE_CODEX (
  echo codex-native-rescue: an official Codex binary was not found 1>&2
  exit /b 69
)
if not exist "%NATIVE_CODEX%" (
  echo codex-native-rescue: official Codex binary is not executable: %NATIVE_CODEX% 1>&2
  exit /b 69
)
if not exist "%NATIVE_CATALOG%" (
  echo codex-native-rescue: AICC-owned native catalog is unavailable: %NATIVE_CATALOG% 1>&2
  exit /b 78
)

if /i "%~1"=="--status" (
  echo native_codex=%NATIVE_CODEX%
  echo endpoint=%NATIVE_ENDPOINT%
  echo provider=openai
  echo model=%AICC_NATIVE_RESCUE_MODEL%
  echo catalog=%NATIVE_CATALOG%
  echo independent_of=17841,10100
  exit /b 0
)

rem Keep the route/model lock aligned with the POSIX rescue wrapper.
for %%A in (%*) do (
  if /i "%%~A"=="-c" (set "BAD_ARG=%%~A"&goto :reject_override)
  if /i "%%~A"=="--config" (set "BAD_ARG=%%~A"&goto :reject_override)
  if /i "%%~A"=="-p" (set "BAD_ARG=%%~A"&goto :reject_override)
  if /i "%%~A"=="--profile" (set "BAD_ARG=%%~A"&goto :reject_override)
  if /i "%%~A"=="-m" (set "BAD_ARG=%%~A"&goto :reject_override)
  if /i "%%~A"=="--model" (set "BAD_ARG=%%~A"&goto :reject_override)
  if /i "%%~A"=="--oss" (set "BAD_ARG=%%~A"&goto :reject_override)
  if /i "%%~A"=="--local-provider" (set "BAD_ARG=%%~A"&goto :reject_override)
  if /i "%%~A"=="--remote" (set "BAD_ARG=%%~A"&goto :reject_override)
  if /i "%%~A"=="--remote-auth-token-env" (set "BAD_ARG=%%~A"&goto :reject_override)
)

"%NATIVE_CODEX%" -c "openai_base_url=%NATIVE_ENDPOINT%" -c "model_provider=openai" -c "model_catalog_json=%NATIVE_CATALOG%" -m "%AICC_NATIVE_RESCUE_MODEL%" %*
exit /b %ERRORLEVEL%

:reject_override
echo codex-native-rescue: route/model override is not allowed 1>&2
exit /b 64
