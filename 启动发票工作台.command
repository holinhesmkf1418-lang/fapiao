#!/bin/zsh
set -u

SCRIPT_DIR="${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd "$SCRIPT_DIR" || exit 1

if ! node scripts/start.mjs; then
  echo
  read "?启动失败，按回车键关闭窗口……"
  exit 1
fi
