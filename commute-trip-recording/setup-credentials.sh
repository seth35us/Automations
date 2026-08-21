#!/bin/zsh

set -eu

PROJECT_DIR="${0:A:h}"
ENV_FILE="$PROJECT_DIR/.env"

read "commute_email?Commute with Enterprise email: "
read -s "commute_password?Commute with Enterprise password (hidden): "
echo

if [[ -z "$commute_email" || -z "$commute_password" ]]; then
  echo "Email and password are required." >&2
  exit 1
fi

escape_env_value() {
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
}

umask 077
{
  printf "COMMUTE_EMAIL='%s'\n" "$(escape_env_value "$commute_email")"
  printf "COMMUTE_PASSWORD='%s'\n" "$(escape_env_value "$commute_password")"
} > "$ENV_FILE"

chmod 600 "$ENV_FILE"
unset commute_password

echo "Credentials saved to $ENV_FILE with owner-only permissions."
