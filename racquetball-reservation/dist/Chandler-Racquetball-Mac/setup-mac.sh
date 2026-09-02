#!/bin/zsh

set -eu

PROJECT_DIR="${0:A:h}"
LABEL="com.${USER}.racquetball-reservation"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
RUN_SCRIPT="$PROJECT_DIR/run-reservation.sh"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This setup script requires macOS."
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Install the current Node.js LTS release from https://nodejs.org/ and run this setup again."
  exit 1
fi

cd "$PROJECT_DIR"
if [[ ! -f "$PROJECT_DIR/package.json" ]]; then
  if [[ -f "$PROJECT_DIR/package-friend-mac.json" ]]; then
    echo "Creating package.json from package-friend-mac.json..."
    cp "$PROJECT_DIR/package-friend-mac.json" "$PROJECT_DIR/package.json"
  else
    echo "Missing package.json and package-friend-mac.json in $PROJECT_DIR."
    exit 1
  fi
fi

echo "Installing the local Playwright dependency..."
mkdir -p "$PROJECT_DIR/runtime/node/bin"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
npm install --omit=dev

echo "Installing the verified project-local Node.js runtime..."
bundled_node_version="v24.19.0"
case "$(uname -m)" in
  arm64) bundled_node_arch="arm64" ;;
  x86_64) bundled_node_arch="x64" ;;
  *) echo "Unsupported Mac architecture: $(uname -m)"; exit 1 ;;
esac
bundled_node_archive="node-${bundled_node_version}-darwin-${bundled_node_arch}.tar.gz"
bundled_node_temp="$(mktemp -d)"
trap 'rm -rf "$bundled_node_temp"' EXIT
curl -fsSL "https://nodejs.org/dist/${bundled_node_version}/SHASUMS256.txt" -o "$bundled_node_temp/SHASUMS256.txt"
curl -fsSL "https://nodejs.org/dist/${bundled_node_version}/${bundled_node_archive}" -o "$bundled_node_temp/$bundled_node_archive"
expected_sha="$(awk -v archive="$bundled_node_archive" '$2 == archive { print $1 }' "$bundled_node_temp/SHASUMS256.txt")"
actual_sha="$(shasum -a 256 "$bundled_node_temp/$bundled_node_archive" | awk '{ print $1 }')"
if [[ -z "$expected_sha" || "$actual_sha" != "$expected_sha" ]]; then
  echo "Node.js checksum verification failed."
  exit 1
fi
tar -xzf "$bundled_node_temp/$bundled_node_archive" -C "$bundled_node_temp"
rm -f "$PROJECT_DIR/runtime/node/bin/node"
install -m 755 "$bundled_node_temp/node-${bundled_node_version}-darwin-${bundled_node_arch}/bin/node" "$PROJECT_DIR/runtime/node/bin/node"
cp "$bundled_node_temp/node-${bundled_node_version}-darwin-${bundled_node_arch}/LICENSE" "$PROJECT_DIR/runtime/node/LICENSE"
printf '%s\n' "$bundled_node_version" > "$PROJECT_DIR/runtime/node/VERSION"
trap - EXIT
rm -rf "$bundled_node_temp"
printf '%s\n' "$PROJECT_DIR/runtime/node/bin/node" > "$PROJECT_DIR/.node-bin"
chmod 600 "$PROJECT_DIR/.node-bin"

echo
echo "Choose the browser this automation should use:"
echo "  1) Microsoft Edge"
echo "  2) Google Chrome"
read "browser_choice?Browser [1]: "
case "${browser_choice:-1}" in
  1|edge|Edge)
    browser_channel="msedge"
    browser_name="Microsoft Edge"
    browser_executable="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    browser_download_url="https://www.microsoft.com/edge"
    ;;
  2|chrome|Chrome)
    browser_channel="chrome"
    browser_name="Google Chrome"
    browser_executable="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    browser_download_url="https://www.google.com/chrome/"
    ;;
  *)
    echo "Choose 1 for Edge or 2 for Chrome. Safari is not supported by this automation."
    exit 1
    ;;
esac

if [[ ! -x "$browser_executable" ]]; then
  echo "$browser_name is not installed in /Applications."
  if command -v brew >/dev/null 2>&1; then
    read "install_browser?Install $browser_name automatically now? [Y/n]: "
    if [[ "${install_browser:-y}" == [yY] || "${install_browser:-y}" == [yY][eE][sS] ]]; then
      if [[ "$browser_channel" == "msedge" ]]; then
        brew install --cask microsoft-edge
      else
        brew install --cask google-chrome
      fi
    else
      echo "Install it from $browser_download_url and run this setup again."
      exit 1
    fi
  else
    echo "Install it from $browser_download_url and run this setup again."
    exit 1
  fi
fi

if [[ ! -x "$browser_executable" ]]; then
  echo "$browser_name installation could not be verified."
  exit 1
fi

echo
echo "Choose the court preference order:"
echo "  1) Court B first, then Court A"
echo "  2) Court A first, then Court B"
read "court_choice?Court order [1]: "
case "${court_choice:-1}" in
  1|B|b)
    court_order="B,A"
    court_description="Court B first, then Court A"
    ;;
  2|A|a)
    court_order="A,B"
    court_description="Court A first, then Court B"
    ;;
  *)
    echo "Choose 1 for B then A, or 2 for A then B."
    exit 1
    ;;
esac

read "email?Chandler Online email: "
read -s "password?Chandler Online password (hidden): "
echo
read "reservation_name?Reservation/event name: "
read "initials?Waiver initials: "
echo
read "capsolver_key?CapSolver API key (leave blank to skip reCAPTCHA solving): "
echo
echo "Each booking requires acceptance of Chandler's Rec Facility Rental Waiver."
read "waiver_consent?Allow this automation to accept that waiver using these initials? [y/N]: "
if [[ "$waiver_consent" != [yY] && "$waiver_consent" != [yY][eE][sS] ]]; then
  echo "Setup stopped because waiver consent was not granted."
  exit 1
fi

if [[ -z "$email" || -z "$password" || -z "$reservation_name" || -z "$initials" ]]; then
  echo "Email, password, reservation name, and initials are all required."
  exit 1
fi

umask 077
{
  printf 'ACTIVE_COMMUNITIES_EMAIL=%s\n' "$email"
  printf 'ACTIVE_COMMUNITIES_PASSWORD=%s\n' "$password"
  printf 'RESERVATION_NAME=%s\n' "$reservation_name"
  printf 'RESERVATION_INITIALS=%s\n' "$initials"
  printf 'ACCEPT_RENTAL_WAIVER=true\n'
  printf 'BROWSER_CHANNEL=%s\n' "$browser_channel"
  printf 'COURT_ORDER=%s\n' "$court_order"
  if [[ -n "$capsolver_key" ]]; then
    printf 'CAPSOLVER_API_KEY=%s\n' "$capsolver_key"
    printf 'CAPSOLVER_ENABLED=true\n'
  else
    printf 'CAPSOLVER_ENABLED=false\n'
  fi
} > "$PROJECT_DIR/.env"
chmod 600 "$PROJECT_DIR/.env"
chmod +x "$RUN_SCRIPT" "$PROJECT_DIR/setup-mac.sh"

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

escaped_project="$(xml_escape "$PROJECT_DIR")"
escaped_run="$(xml_escape "$RUN_SCRIPT")"
escaped_label="$(xml_escape "$LABEL")"
mkdir -p "$HOME/Library/LaunchAgents"

printf '%s\n' \
  '<?xml version="1.0" encoding="UTF-8"?>' \
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
  '<plist version="1.0">' \
  '<dict>' \
  '  <key>Label</key>' \
  "  <string>$escaped_label</string>" \
  '  <key>ProgramArguments</key>' \
  '  <array>' \
  "    <string>$escaped_run</string>" \
  '    <string>--headed</string>' \
  '    <string>--scheduled</string>' \
  '  </array>' \
  '  <key>WorkingDirectory</key>' \
  "  <string>$escaped_project</string>" \
  '  <key>StartCalendarInterval</key>' \
  '  <dict>' \
  '    <key>Hour</key><integer>5</integer>' \
  '    <key>Minute</key><integer>0</integer>' \
  '  </dict>' \
  '  <key>StandardOutPath</key>' \
  "  <string>$escaped_project/racquetball.log</string>" \
  '  <key>StandardErrorPath</key>' \
  "  <string>$escaped_project/racquetball-error.log</string>" \
  '</dict>' \
  '</plist>' > "$PLIST"

plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo
echo "The reservation task is installed for 5:00 AM local Mac time."

if pmset -g sched | grep -q '^Repeating power events:'; then
  echo "An existing repeating Mac power schedule was found, so setup did not replace it."
  echo "Review it with: pmset -g sched"
else
  read "wake_choice?Also wake this Mac every day at 4:58 AM? This requires administrator approval. [y/N]: "
  if [[ "$wake_choice" == [yY] || "$wake_choice" == [yY][eE][sS] ]]; then
    /usr/bin/osascript -e 'do shell script "/usr/bin/pmset repeat wakeorpoweron MTWRFSU 04:58:00" with administrator privileges'
    echo "Daily 4:58 AM wake schedule installed."
  fi
fi

echo
echo "Setup complete. Keep the Mac plugged in, awake-capable, and logged in."
echo "Automation browser: $browser_name"
echo "Court preference: $court_description"
echo "Test without submitting: ./run-reservation.sh --headed --dry-run --date YYYY-MM-DD"
