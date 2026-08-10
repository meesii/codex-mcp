$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Package = $env:CODEX_MCP_PACKAGE
if (-not $Package) {
    $Package = "https://github.com/meesii/codex-mcp/releases/latest/download/codex-mcp.tgz"
}

function Fail([string]$Message) {
    Write-Error "安装失败：$Message"
    exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "没有找到 Node.js。请先安装 Node.js 22 或更高版本。"
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Fail "没有找到 npm。重新安装 Node.js 通常可以解决。"
}

$nodeMajor = [int](& node -p 'Number(process.versions.node.split(".")[0])')
if ($nodeMajor -lt 22) {
    Fail "当前 Node.js 版本是 $(& node -v)，需要 22 或更高版本。"
}

$installRoot = Join-Path $env:USERPROFILE ".codex-mcp\npm"
New-Item -ItemType Directory -Force -Path $installRoot | Out-Null

Write-Host "正在安装 codex-mcp…"
& npm install --global --prefix $installRoot $Package
if ($LASTEXITCODE -ne 0) {
    Fail "npm 安装没有完成。请检查上面的错误信息。"
}

$cmdPath = Join-Path $installRoot "codex-mcp.cmd"
if (-not (Test-Path -LiteralPath $cmdPath)) {
    Fail "安装完成，但没有找到 codex-mcp 命令：$cmdPath"
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $userPath) { $userPath = "" }
$parts = $userPath -split ";" | Where-Object { $_ -and $_.Trim() -ne "" }
if ($parts -notcontains $installRoot) {
    $newPath = ($parts + $installRoot) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
}
$env:Path = "$installRoot;$env:Path"

$version = & $cmdPath --version 2>$null
Write-Host ""
Write-Host "✓ codex-mcp $version"
Write-Host "✓ 命令目录已加入 PATH：$installRoot"
Write-Host ""
Write-Host "第一次使用请运行："
Write-Host "  codex-mcp setup"
Write-Host ""
Write-Host "如果其它终端窗口还找不到 codex-mcp，请重新打开终端。"
