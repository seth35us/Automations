#!/bin/zsh

set -u

PROJECT_DIR="${0:A:h}"
NODE_BIN="/Users/sethstarr/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
export NODE_PATH="/Users/sethstarr/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules"
export PLAYWRIGHT_BROWSERS_PATH="$PROJECT_DIR/.playwright-browsers"

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
