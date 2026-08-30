#!/bin/zsh

set -u

PROJECT_DIR="${0:A:h}"

pause_and_exit() {
  local exit_code="$1"
  echo
  if (( exit_code == 0 )); then
    echo "Installation finished successfully."
  else
    echo "Installation stopped with an error. Review the message above."
  fi
  read "unused?Press Return to close this window..."
  exit "$exit_code"
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer requires macOS."
  pause_and_exit 1
fi

clear
echo "Chandler Racquetball Reservation Installer"
echo "=========================================="
echo
echo "This installer can add Homebrew, Node.js, Playwright, and the selected browser if needed."
echo "It will then collect your Chandler settings and install the 5:00 AM scheduler."
echo

if [[ ! -f "$PROJECT_DIR/package.json" ]]; then
  if [[ -f "$PROJECT_DIR/package-friend-mac.json" ]]; then
    echo "Creating package.json from package-friend-mac.json..."
    cp "$PROJECT_DIR/package-friend-mac.json" "$PROJECT_DIR/package.json"
  else
    echo "Missing package.json and package-friend-mac.json in $PROJECT_DIR."
    pause_and_exit 1
  fi
fi

if ! command -v brew >/dev/null 2>&1; then
  read "brew_choice?Homebrew is required to install missing dependencies. Install it from the official Homebrew project now? [Y/n]: "
  if [[ "${brew_choice:-y}" != [yY] && "${brew_choice:-y}" != [yY][eE][sS] ]]; then
    echo "Homebrew installation was declined."
    pause_and_exit 1
  fi

  if ! /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; then
    echo "Homebrew installation failed."
    pause_and_exit 1
  fi
fi

if [[ -x "/opt/homebrew/bin/brew" ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [[ -x "/usr/local/bin/brew" ]]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is installed but could not be added to this Terminal session."
  pause_and_exit 1
fi

node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 || (( node_major < 20 )); then
  echo
  echo "Installing the current Node.js release..."
  if brew list node >/dev/null 2>&1; then
    node_install_command=(brew upgrade node)
  else
    node_install_command=(brew install node)
  fi
  if ! "${node_install_command[@]}"; then
    echo "Node.js installation failed."
    pause_and_exit 1
  fi
fi

chmod +x "$PROJECT_DIR/setup-mac.sh" "$PROJECT_DIR/run-reservation.sh" "$PROJECT_DIR/run-reservation-portable.sh"
if ! "$PROJECT_DIR/setup-mac.sh"; then
  pause_and_exit 1
fi

pause_and_exit 0
