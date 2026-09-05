#!/bin/zsh

set -u

PROJECT_DIR="${0:A:h}"
LABEL="com.sethstarr.racquetball-once-20260907-1330"
STATE_FILE="$PROJECT_DIR/.one-time-2026-09-07-1330.state"

unload_self() {
  /usr/bin/nohup /bin/zsh -c "/bin/sleep 2; /bin/launchctl bootout gui/$(id -u)/$LABEL" \
    >/dev/null 2>&1 &
}

if [[ -f "$STATE_FILE" ]]; then
  unload_self
  exit 0
fi

"$PROJECT_DIR/run-reservation.sh" \
  --headed \
  --scheduled \
  --date 2026-09-07 \
  --time "1:30 PM"
exit_code=$?

{
  print -r -- "attempted_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  print -r -- "exit_code=$exit_code"
} > "$STATE_FILE"
chmod 600 "$STATE_FILE"

unload_self
exit "$exit_code"
