#!/usr/bin/env sh
set -eu

INSTALL_ROOT="${HOME}/.codex-mcp/npm"

if [ ! -e "$INSTALL_ROOT" ]; then
  printf '%s\n' "codex-mcp 程序已经不在这台电脑上了。"
  exit 0
fi

rm -rf "$INSTALL_ROOT"

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

printf '%s\n' "✓ codex-mcp 程序已删除。"
printf '%s\n' ""
printf '%s\n' "你的配置、连接密码和 Tunnel 信息仍保留在："
printf '  %s\n' "${HOME}/.codex-mcp"
printf '%s\n' ""
printf '%s\n' "以后重新安装 codex-mcp 时可以继续使用这些配置。"
