#!/bin/zsh

set -u

PROJECT_DIR="${0:A:h}"
PORTABLE_RUNNER="$PROJECT_DIR/run-reservation-portable.sh"

if [[ ! -x "$PORTABLE_RUNNER" ]]; then
  chmod +x "$PORTABLE_RUNNER"
fi

exec "$PORTABLE_RUNNER" "$@"
