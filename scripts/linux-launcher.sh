#!/usr/bin/env bash
# Installed to /usr/local/bin/marivell by install-linux.sh
# Injects Chromium flags *before* Electron starts (JS appendSwitch is too late
# for a misconfigured chrome-sandbox FATAL).
set -euo pipefail

APP_DIR="/opt/marivell"
BIN="${APP_DIR}/marivell"
SANDBOX="${APP_DIR}/chrome-sandbox"
EXTRA=(--disable-gpu-sandbox)

if [[ ! -x "$BIN" ]]; then
  echo "Marivell binary not found: $BIN" >&2
  echo "Re-run: bash scripts/install-linux.sh" >&2
  exit 1
fi

if [[ -e "$SANDBOX" ]]; then
  owner="$(stat -c '%u' "$SANDBOX" 2>/dev/null || echo '')"
  mode="$(stat -c '%a' "$SANDBOX" 2>/dev/null || echo '')"
  # Expect root-owned setuid (mode starts with 4, e.g. 4755)
  if [[ "$owner" != "0" || "${mode:0:1}" != "4" ]]; then
    EXTRA+=(--no-sandbox --disable-setuid-sandbox)
  fi
fi

exec "$BIN" "${EXTRA[@]}" "$@"
