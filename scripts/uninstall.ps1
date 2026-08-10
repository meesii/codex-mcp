$ErrorActionPreference = "Stop"

function Write-Status([string]$Marker, [ConsoleColor]$Color, [string]$Message) {
    $text = "$Marker $Message"
    if (Test-Path Env:NO_COLOR) {
        Write-Host $text
    } else {
        Write-Host $text -ForegroundColor $Color
    }
}

function Info([string]$Message) {
    Write-Status "ℹ" Cyan $Message
}

function Success([string]$Message) {
    Write-Status "✓" Green $Message
}

$installRoot = Join-Path $env:USERPROFILE ".codex-mcp\npm"

if (Test-Path -LiteralPath $installRoot) {
    Remove-Item -LiteralPath $installRoot -Recurse -Force
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath) {
    $installRootNormalized = $installRoot.TrimEnd('\')
    $parts = $userPath -split ";" | Where-Object {
        $_ -and
        $_.Trim() -ne "" -and
        -not [string]::Equals(
            $_.Trim().TrimEnd('\'),
            $installRootNormalized,
            [System.StringComparison]::OrdinalIgnoreCase
        )
    }
    [Environment]::SetEnvironmentVariable("Path", ($parts -join ";"), "User")
}

Success "codex-mcp 程序已删除。"
Write-Host ""
Info "你的配置、连接密码和 Tunnel 信息仍保留在：$env:USERPROFILE\.codex-mcp"
Info "以后重新安装 codex-mcp 时可以继续使用这些配置。"
