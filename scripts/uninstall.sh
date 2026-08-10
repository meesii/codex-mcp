#!/usr/bin/env sh
set -eu

INSTALL_ROOT="${HOME}/.codex-mcp/npm"
MANAGED_BIN="${HOME}/.codex-mcp/bin"

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

success() {
  status '✓' '32' "$1"
}

if [ ! -e "$INSTALL_ROOT" ] && [ ! -e "$MANAGED_BIN" ]; then
  info "codex-mcp 程序已经不在这台电脑上了。"
  exit 0
fi

rm -rf "$INSTALL_ROOT" "$MANAGED_BIN"

remove_path_line() {
  profile="$1"
  [ -f "$profile" ] || return 0
  tmp="${profile}.codex-mcp.tmp.$$"
  cp -p "$profile" "$tmp"
  awk '$0 != "# codex-mcp" && $0 != "export PATH=\"$HOME/.codex-mcp/npm/bin:$PATH\""' "$profile" > "$tmp"
  mv "$tmp" "$profile"
}

remove_path_line "${HOME}/.zshrc"
remove_path_line "${HOME}/.bashrc"
remove_path_line "${HOME}/.bash_profile"
remove_path_line "${HOME}/.profile"

success "codex-mcp 程序已删除。"
printf '%s\n' ""
info "你的配置、连接密码和 Tunnel 信息仍保留在：${HOME}/.codex-mcp"
info "以后重新安装 codex-mcp 时可以继续使用这些配置。"
