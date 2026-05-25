<#
.SYNOPSIS
  Build the DeckLink native addon (decklink_addon.node) on Windows.

.DESCRIPTION
  One-shot helper that:
    1. Verifies prerequisites (Node.js, MSVC, MIDL)
    2. Runs cmake-js with the right BMD_SDK_DIR
    3. Copies the resulting .node into build/decklink_addon-windows-x64.node
       (the suffix matches the GitHub release asset name)

  Run from the repo root in a "x64 Native Tools Command Prompt for VS"
  PowerShell session, or from a regular PowerShell after running
  scripts/Enter-VsDevShell-x64.ps1 once.

.PARAMETER SdkPath
  Path to the unpacked DeckLink SDK's Win/include directory. Must contain
  DeckLinkAPI.idl. Example:
    C:\Blackmagic DeckLink SDK 12.4\Win\include

.PARAMETER OutputDir
  Optional. Where to drop the built .node. Default: <repo>/build/

.EXAMPLE
  pwsh scripts/build-decklink-windows.ps1 -SdkPath "C:\BMD-SDK\Win\include"

.EXAMPLE
  pwsh scripts/build-decklink-windows.ps1 -SdkPath "$HOME\Downloads\BMD-SDK-12.4\Win\include" -OutputDir "C:\artifacts"
#>

param(
    [Parameter(Mandatory = $true)]
    [string] $SdkPath,

    [string] $OutputDir = (Join-Path $PSScriptRoot '..\build')
)

$ErrorActionPreference = 'Stop'

Write-Host ""
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host "  Community Captioner - Windows native build" -ForegroundColor Cyan
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host ""

# Resolve repo root (script lives in <repo>/scripts/)
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$AddonDir = Join-Path $RepoRoot 'native\decklink'
$BuildDir = Join-Path $AddonDir 'build'

Write-Host "Repo:    $RepoRoot"
Write-Host "Addon:   $AddonDir"

# 1. Validate SDK path
$SdkPath = (Resolve-Path $SdkPath).Path
Write-Host "SDK:     $SdkPath"

if (-not (Test-Path (Join-Path $SdkPath 'DeckLinkAPI.idl'))) {
    Write-Host ""
    Write-Error "DeckLinkAPI.idl not found in $SdkPath. Make sure -SdkPath points at the SDK's Win\include directory."
    exit 1
}

# 2. Check Node.js
try {
    $nodeVersion = (& node --version 2>$null).Trim()
    Write-Host "Node:    $nodeVersion"
    $major = [int]($nodeVersion -replace '^v(\d+)\..*', '$1')
    if ($major -lt 18) {
        Write-Warning "Node.js $nodeVersion is older than v18. cmake-js may fail. Install Node 20 from https://nodejs.org/"
    }
} catch {
    Write-Error "Node.js not found in PATH. Install Node 20 from https://nodejs.org/ and retry."
    exit 1
}

# 3. Check MSVC (cl.exe)
# Use Get-Command rather than running cl.exe directly: in Windows PowerShell 5.1,
# `cl 2>&1` wraps stderr lines as ErrorRecords and trips $ErrorActionPreference='Stop'
# even when cl is installed (cl with no args writes its banner to stderr).
try {
    $clPath = (Get-Command cl -ErrorAction Stop).Source
    Write-Host "MSVC:    $clPath"
} catch {
    Write-Host ""
    Write-Error @"
cl.exe (MSVC compiler) not found in PATH.

You must run this script from one of:
  - 'x64 Native Tools Command Prompt for VS 2022' (then 'powershell')
  - A PowerShell session after running Enter-VsDevShell -Arch x64

Install Visual Studio Build Tools 2022 from:
  https://visualstudio.microsoft.com/visual-cpp-build-tools/
Be sure to select the 'Desktop development with C++' workload.
"@
    exit 1
}

# 4. Check midl.exe
try {
    $midlPath = (Get-Command midl -ErrorAction Stop).Source
    Write-Host "MIDL:    $midlPath"
} catch {
    Write-Error "midl.exe not found. It ships with the Windows SDK component of Visual Studio Build Tools."
    exit 1
}

Write-Host ""
Write-Host "=== Installing npm dependencies ===" -ForegroundColor Yellow
Push-Location $RepoRoot
try {
    & npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "=== Cleaning previous build ===" -ForegroundColor Yellow
if (Test-Path $BuildDir) { Remove-Item -Recurse -Force $BuildDir }

Write-Host ""
Write-Host "=== Compiling decklink_addon.node ===" -ForegroundColor Yellow
Write-Host "Passing -DBMD_SDK_DIR=$SdkPath to cmake-js"

Push-Location $RepoRoot
try {
    & npx cmake-js compile --directory $AddonDir "--CDBMD_SDK_DIR=$SdkPath" --config Release
    if ($LASTEXITCODE -ne 0) { throw "cmake-js compile failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

# 5. Find and stage the output
$produced = Join-Path $BuildDir 'Release\decklink_addon.node'
if (-not (Test-Path $produced)) {
    Write-Error "Build succeeded but $produced doesn't exist. Inspect $BuildDir."
    exit 1
}

if (-not (Test-Path $OutputDir)) { New-Item -ItemType Directory -Path $OutputDir | Out-Null }
$staged = Join-Path $OutputDir 'decklink_addon-windows-x64.node'
Copy-Item $produced $staged -Force

$size = [math]::Round((Get-Item $staged).Length / 1KB, 1)
$sha = (Get-FileHash $staged -Algorithm SHA256).Hash

Write-Host ""
Write-Host "===============================================" -ForegroundColor Green
Write-Host "  SUCCESS" -ForegroundColor Green
Write-Host "===============================================" -ForegroundColor Green
Write-Host ""
Write-Host "Built: $staged ($size KB)"
Write-Host "SHA256: $sha"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Test locally:"
Write-Host "       Copy $staged next to CommunityCaptioner.exe as decklink_addon.node"
Write-Host "       (drop the -windows-x64 suffix), then launch the .exe."
Write-Host ""
Write-Host "  2. Attach to the GitHub release so other users can download it:"
Write-Host "       gh release upload v6.3.1 `"$staged`" --clobber"
Write-Host ""
