@echo off
setlocal enabledelayedexpansion

REM Community Captioner — Windows DeckLink Setup
REM Downloads the prebuilt decklink_addon.node from the latest GitHub release
REM and drops it next to CommunityCaptioner.exe so SDI caption injection works.

echo.
echo ===============================================
echo   Community Captioner - DeckLink Setup
echo ===============================================
echo.
echo This will download the DeckLink driver addon
echo and place it next to CommunityCaptioner.exe.
echo.
echo Prerequisites:
echo   - Blackmagic Desktop Video drivers installed
echo     (https://www.blackmagicdesign.com/support)
echo   - A Blackmagic DeckLink card connected
echo.
pause

set "TARGET=%~dp0decklink_addon.node"
set "URL=https://github.com/amateurmenace/community-captioner-v10/releases/latest/download/decklink_addon-windows-x64.node"

echo.
echo Downloading from:
echo   %URL%
echo.
echo Saving to:
echo   %TARGET%
echo.

REM Use PowerShell to download (curl.exe also works on Windows 10+ but PS is more portable)
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -Uri '%URL%' -OutFile '%TARGET%' -UseBasicParsing; exit 0 } catch { Write-Host $_.Exception.Message; exit 1 }"

if errorlevel 1 (
    echo.
    echo ===============================================
    echo   Download FAILED
    echo ===============================================
    echo.
    echo Possible reasons:
    echo   1. No prebuilt addon is published yet for this release.
    echo      Check: https://github.com/amateurmenace/community-captioner-v10/releases
    echo   2. No internet connection.
    echo   3. Corporate firewall blocking GitHub.
    echo.
    echo You can also build the addon from source. See SETUP.md.
    echo.
    pause
    exit /b 1
)

echo.
echo ===============================================
echo   SUCCESS
echo ===============================================
echo.
echo decklink_addon.node has been placed next to CommunityCaptioner.exe.
echo.
echo Now restart the app (if it's running) and open Caption Injection.
echo The "DeckLink Addon Not Loaded" message should be gone.
echo.
pause
