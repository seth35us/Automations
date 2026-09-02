#!/bin/zsh

set -u

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

BUNDLED_NODE="$PROJECT_DIR/runtime/node/bin/node"
if [[ ! -f "$BUNDLED_NODE" || -L "$BUNDLED_NODE" || ! -x "$BUNDLED_NODE" ]]; then
  echo "The bundled Node runtime is missing or invalid. Run ./setup-mac.sh to reinstall it." >&2
  exit 1
fi

NODE_BIN="$BUNDLED_NODE"
NODE_MAJOR="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if (( NODE_MAJOR < 20 )); then
  echo "The bundled Node runtime is too old. Run ./setup-mac.sh to reinstall it." >&2
  exit 1
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$PROJECT_DIR/runtime/playwright-browsers"

cd "$PROJECT_DIR"

# Allow the site's 5:00 AM inventory window a few seconds to open. Manual runs
# begin immediately; launchd supplies --scheduled.
if [[ " $* " == *" --scheduled "* ]]; then
  sleep 5
fi

retry_delays=(0 10 30 60)
attempt=1

for delay in "${retry_delays[@]}"; do
  if (( delay > 0 )); then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Retrying in ${delay} seconds (attempt ${attempt} of ${#retry_delays[@]})."
    sleep "$delay"
  fi

  "$NODE_BIN" "$PROJECT_DIR/reserve-racquetball.cjs" "$@"
  exit_code=$?
  if (( exit_code == 0 )); then
    exit 0
  fi

  # Exit 2 means unavailable or submission status uncertain. Retrying could
  # either be pointless or create a duplicate reservation.
  if (( exit_code == 2 )); then
    break
  fi
  ((attempt += 1))
done

message="Racquetball reservation failed. Check racquetball.log and the latest screenshot in artifacts."
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $message" >&2
/usr/bin/osascript -e "display notification \"$message\" with title \"Court reservation\"" >/dev/null 2>&1 || true
exit "$exit_code"
