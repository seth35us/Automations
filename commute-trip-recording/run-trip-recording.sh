#!/bin/zsh

set -u

PROJECT_DIR="${0:A:h}"
NODE_BIN="/Users/sethstarr/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
export NODE_PATH="/Users/sethstarr/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules"

cd "$PROJECT_DIR"
exec "$NODE_BIN" "$PROJECT_DIR/record-trips.cjs" "$@"
