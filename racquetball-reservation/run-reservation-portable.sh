#!/bin/zsh

set -u

PROJECT_DIR="${0:A:h}"

if [[ -f "$PROJECT_DIR/.node-bin" ]]; then
  NODE_BIN="$(<"$PROJECT_DIR/.node-bin")"
else
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "Node.js is not installed or is not available in PATH." >&2
  exit 1
fi

cd "$PROJECT_DIR"

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
  if (( exit_code == 2 )); then
    break
  fi
  ((attempt += 1))
done

message="Racquetball reservation failed. Check racquetball.log and the latest screenshot in artifacts."
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $message" >&2
/usr/bin/osascript -e "display notification \"$message\" with title \"Court reservation\"" >/dev/null 2>&1 || true
exit "$exit_code"
