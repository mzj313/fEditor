#!/usr/bin/env bash
# macOS / Linux 启动脚本
set -euo pipefail

# 脚本位于 scripts/ 下，先切到项目根目录
cd "$(dirname "$0")/.."

# 终端直接运行时，Homebrew 与 Rust 的安装目录可能不在 PATH 中
for bin in "$HOME/.cargo/bin" "/opt/homebrew/bin" "/usr/local/bin"; do
  if [ -d "$bin" ]; then
    PATH="$bin:$PATH"
  fi
done
export PATH

find_app() {
  find src-tauri/target/release/bundle/macos -maxdepth 1 -name '*.app' -print -quit 2>/dev/null || true
}

APP="$(find_app)"

# 产物缺失，或源码比产物新（改过代码）时，需要重新构建
needs_build() {
  if [ -z "$APP" ]; then
    return 0
  fi
  local newer
  newer="$(
    find src index.html package.json src-tauri/src src-tauri/Cargo.toml src-tauri/tauri.conf.json \
      -newer "$APP" -print -quit 2>/dev/null || true
  )"
  [ -n "$newer" ]
}

if ! needs_build; then
  echo "启动 fEditor（release）..."
  exec open "$APP"
fi

if [ ! -f "package.json" ]; then
  echo "工程尚未初始化，请先完成 S1 骨架搭建。"
  exit 1
fi

for tool in node pnpm cargo; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "未找到 ${tool}，请先安装后再运行。"
    exit 1
  fi
done

if [ ! -d "node_modules" ]; then
  echo "安装依赖..."
  pnpm install
fi

# 只构建 release：开发模式（debug）启动快但产物不用于日常使用
echo "构建 release 版本（首次构建或源码有改动），请稍候..."
pnpm tauri build --bundles app

APP="$(find_app)"
if [ -z "$APP" ]; then
  echo "构建完成但未找到 .app 产物，请检查上方日志。"
  exit 1
fi

echo "启动 fEditor（release）..."
exec open "$APP"
