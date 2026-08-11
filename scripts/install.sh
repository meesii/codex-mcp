#!/usr/bin/env sh
set -eu

PACKAGE="${CODEX_MCP_PACKAGE:-https://github.com/meesii/codex-mcp/releases/latest/download/codex-mcp.tgz}"
INSTALL_ROOT="${HOME}/.codex-mcp/npm"
BIN_DIR="${INSTALL_ROOT}/bin"

say() {
  printf '%s\n' "$1"
}

status() {
  marker="$1"
  color="$2"
  message="$3"
  if [ -t 1 ] && [ -z "${NO_COLOR+x}" ]; then
    printf '\033[%sm%s %s\033[0m\n' "$color" "$marker" "$message"
  else
    printf '%s %s\n' "$marker" "$message"
  fi
}

info() {
  status 'ℹ' '36' "$1"
}

warn() {
  status '!' '33' "$1"
}

success() {
  status '✓' '32' "$1"
}

fail() {
  if [ -t 2 ] && [ -z "${NO_COLOR+x}" ]; then
    printf '\033[31m✗ 安装失败：%s\033[0m\n' "$1" >&2
  else
    printf '✗ 安装失败：%s\n' "$1" >&2
  fi
  exit 1
}

command -v node >/dev/null 2>&1 || fail "没有找到 Node.js。请先安装 Node.js 22 或更高版本。"
command -v npm >/dev/null 2>&1 || fail "没有找到 npm。重新安装 Node.js 通常可以解决。"

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge 22 ] || fail "当前 Node.js 版本是 $(node -v)，需要 22 或更高版本。"

if [ "${CODEX_MCP_UPDATE:-}" = "1" ]; then
  info "正在更新 codex-mcp…"
else
  info "正在安装 codex-mcp…"
fi
mkdir -p "$INSTALL_ROOT"
npm install --global --prefix "$INSTALL_ROOT" "$PACKAGE"

[ -x "$BIN_DIR/codex-mcp" ] || fail "安装完成，但没有找到 codex-mcp 命令。"

TOOLS_CLI="$INSTALL_ROOT/lib/node_modules/codex-mcp/dist/managed-tools-cli.js"
[ -f "$TOOLS_CLI" ] || fail "安装完成，但缺少运行组件管理程序。"
info "正在准备必要组件…"
node "$TOOLS_CLI" bootstrap || fail "必要组件准备失败。请检查网络后重新运行安装。"
success "必要组件已准备"

add_path_line() {
  profile="$1"
  line='export PATH="$HOME/.codex-mcp/npm/bin:$PATH"'
  if [ -f "$profile" ] && grep -F '.codex-mcp/npm/bin' "$profile" >/dev/null 2>&1; then
    return
  fi
  printf '\n# codex-mcp\n%s\n' "$line" >> "$profile"
}

SHELL_NAME="$(basename "${SHELL:-sh}")"
case "$SHELL_NAME" in
  zsh) PROFILE="${HOME}/.zshrc" ;;
  bash)
    if [ "$(uname -s 2>/dev/null || true)" = "Darwin" ]; then
      PROFILE="${HOME}/.bash_profile"
    else
      PROFILE="${HOME}/.bashrc"
    fi
    ;;
  *) PROFILE="${HOME}/.profile" ;;
esac

add_path_line "$PROFILE"
export PATH="$BIN_DIR:$PATH"

VERSION="$(codex-mcp --version 2>/dev/null || true)"
say ""
success "codex-mcp ${VERSION:-已安装}"
success "命令目录已加入 PATH：${BIN_DIR}"
say ""
if [ "${CODEX_MCP_UPDATE:-}" = "1" ]; then
  success "更新完成。配置、连接密码和 Tunnel 信息保持不变。"
  warn "如果 codex-mcp 服务正在运行，请重启它；现有进程不会自动加载更新后的 core tool schema。"
else
  info "第一次使用请运行：codex-mcp setup"
  warn "如果当前终端还找不到 codex-mcp，请重新打开一个终端窗口。"
fi
