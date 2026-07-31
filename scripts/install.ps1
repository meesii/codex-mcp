# Install a user-local `codex-mcp` command (Windows).
# Usage: pwsh -File scripts/install.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

npm run build

$binDir = Join-Path $env:USERPROFILE ".codex-mcp\bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$distCli = Join-Path $root "dist\cli.js"
$cmdPath = Join-Path $binDir "codex-mcp.cmd"
$cmd = @"
@echo off
node "$distCli" %*
"@
Set-Content -Path $cmdPath -Value $cmd -Encoding ASCII

$pathEntry = $binDir
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $userPath) { $userPath = "" }
$parts = $userPath -split ";" | Where-Object { $_ -and $_.Trim() -ne "" }
if ($parts -notcontains $pathEntry) {
    $newPath = ($parts + $pathEntry) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    $env:Path = "$pathEntry;$env:Path"
    Write-Host "Added to user PATH: $pathEntry"
    Write-Host "Open a new terminal for PATH to apply everywhere."
} else {
    Write-Host "PATH already contains: $pathEntry"
}

Write-Host "Installed: $cmdPath"
Write-Host "Try: codex-mcp --help"
