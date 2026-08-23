#!/usr/bin/env bash
set -euo pipefail

# The install script elevates individual copy operations.  Building as root
# leaves out/ and dist/ owned by root and breaks later user-owned builds.
if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
    exec sudo -u "$SUDO_USER" npm run build:linux:dir
fi

exec npm run build:linux:dir
