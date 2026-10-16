#!/usr/bin/env bash
# Ubuntu/Debian prerequisites for building and driving the real Tauri window.
# The package list follows Tauri 2's Linux + WebDriver CI prerequisites.
set -euo pipefail

if [[ -f "$HOME/.cargo/env" ]]; then
  # rustup does not update the current non-login shell automatically.
  source "$HOME/.cargo/env"
fi

if [[ $(uname -s) != Linux ]] || ! command -v apt-get >/dev/null; then
  echo "This setup script currently supports Debian/Ubuntu Linux."
  exit 2
fi

sudo apt-get update
sudo apt-get install -y \
  build-essential \
  curl \
  file \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libssl-dev \
  libwebkit2gtk-4.1-dev \
  libxdo-dev \
  sqlite3 \
  webkit2gtk-driver \
  wget \
  xvfb

command -v cargo >/dev/null || {
  echo "Rust is missing. Install stable Rust from https://rustup.rs, then rerun."
  exit 1
}
command -v npm >/dev/null || {
  echo "Node/npm is missing. Install Node 20 or newer, then rerun."
  exit 1
}

npm ci
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium
cargo build -p calendar-app
echo "Linux native E2E setup complete. Run: npm run test:e2e:app"
echo "(headless under Xvfb; CAL_E2E_DISPLAY=\$DISPLAY npm run test:e2e:app to watch the window)"
