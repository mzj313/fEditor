#!/usr/bin/env bash
# macOS 双击启动入口：Finder 会把 .command 文件交给终端执行
set -euo pipefail

cd "$(dirname "$0")"
exec ./start.sh
