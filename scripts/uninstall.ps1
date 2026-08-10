$ErrorActionPreference = "Stop"

$installRoot = Join-Path $env:USERPROFILE ".codex-mcp\npm"

if (Test-Path -LiteralPath $installRoot) {
    Remove-Item -LiteralPath $installRoot -Recurse -Force
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath) {
    $parts = $userPath -split ";" | Where-Object {
        $_ -and $_.Trim() -ne "" -and $_.TrimEnd("\\") -ne $installRoot.TrimEnd("\\")
    }
    [Environment]::SetEnvironmentVariable("Path", ($parts -join ";"), "User")
}

Write-Host "✓ codex-mcp 程序已删除。"
Write-Host ""
Write-Host "你的配置、连接密码和 Tunnel 信息仍保留在："
Write-Host "  $env:USERPROFILE\.codex-mcp"
Write-Host ""
Write-Host "以后重新安装 codex-mcp 时可以继续使用这些配置。"
