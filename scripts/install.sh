#!/usr/bin/env sh
set -eu

PACKAGE="${CODEX_MCP_PACKAGE:-https://github.com/meesii/codex-mcp/releases/latest/download/codex-mcp.tgz}"
INSTALL_ROOT="${HOME}/.codex-mcp/npm"
BIN_DIR="${INSTALL_ROOT}/bin"

say() {
  printf '%s\n' "$1"
}

fail() {
  printf '安装失败：%s\n' "$1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "没有找到 Node.js。请先安装 Node.js 22 或更高版本。"
command -v npm >/dev/null 2>&1 || fail "没有找到 npm。重新安装 Node.js 通常可以解决。"

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge 22 ] || fail "当前 Node.js 版本是 $(node -v)，需要 22 或更高版本。"

say "正在安装 codex-mcp…"
mkdir -p "$INSTALL_ROOT"
npm install --global --prefix "$INSTALL_ROOT" "$PACKAGE"

[ -x "$BIN_DIR/codex-mcp" ] || fail "安装完成，但没有找到 codex-mcp 命令。"

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
say "✓ codex-mcp ${VERSION:-已安装}"
say "✓ 命令目录已加入 PATH：${BIN_DIR}"
say ""
say "第一次使用请运行："
say "  codex-mcp setup"
say ""
say "如果当前终端还找不到 codex-mcp，请重新打开一个终端窗口。"
