#!/usr/bin/env bash
# Install Markdown Editor Pro on Linux
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
APP_NAME="markdown-editor-pro"
APP_DIR="/opt/${APP_NAME}"
INSTALL_BIN="/usr/local/bin/${APP_NAME}"
INSTALL_ICON="/usr/local/share/icons/hicolor/512x512/apps/${APP_NAME}.png"
INSTALL_DESKTOP="/usr/local/share/applications/${APP_NAME}.desktop"
USER_DESKTOP="${XDG_DATA_HOME:-$HOME/.local/share}/applications/${APP_NAME}.desktop"
DIST_DIR="${PROJECT_DIR}/dist/linux-unpacked"
MIME_XML="${PROJECT_DIR}/build/file-associations/markdown-editor-pro.xml"
INSTALL_MIME_DIR="/usr/local/share/mime"
INSTALL_MIME_PACKAGE="${INSTALL_MIME_DIR}/packages/markdown-editor-pro.xml"
INSTALL_MIME_ICON_DIR="/usr/local/share/icons/hicolor"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

write_desktop_entry() {
  local target="$1"
  # Prefer the /usr/local/bin wrapper so sandbox argv flags are applied.
  local exec_path="${2:-$INSTALL_BIN}"
  local icon_value="${3:-$APP_NAME}"
  # Desktop files must not use shell scripts with relative paths; absolute only.
  cat > "${target}.tmp" << DESKTOP_EOF
[Desktop Entry]
Name=Markdown Editor Pro
Comment=A professional Markdown editor
Exec=${exec_path} %F
TryExec=${exec_path}
Icon=${icon_value}
Terminal=false
Type=Application
Categories=Office;TextEditor;Utility;
MimeType=text/markdown;text/x-markdown;
StartupWMClass=${APP_NAME}
StartupNotify=true
Keywords=markdown;editor;text;document;
DESKTOP_EOF
  if [[ "$target" == /usr/* ]] || [[ "$target" == /opt/* ]]; then
    sudo mv "${target}.tmp" "$target"
  else
    mv "${target}.tmp" "$target"
  fi
}

install_mime_icon() {
  local size="$1"
  local source="$2"
  local icon_name="$3"
  local target="${INSTALL_MIME_ICON_DIR}/${size}x${size}/mimetypes/${icon_name}.png"
  if [ -f "$source" ]; then
    sudo mkdir -p "$(dirname "$target")"
    sudo cp "$source" "$target"
  fi
}

echo -e "${GREEN}=== Markdown Editor Pro - Linux Installer ===${NC}"
echo ""

# Step 1: Check if build exists
if [ ! -f "${DIST_DIR}/${APP_NAME}" ]; then
    echo -e "${YELLOW}No build found. Building first...${NC}"
    cd "${PROJECT_DIR}"

    if ! command -v node &> /dev/null; then
        echo -e "${RED}Error: Node.js is required but not installed.${NC}"
        echo "Install it with: sudo apt install nodejs npm"
        exit 1
    fi

    echo "Installing dependencies..."
    npm install --legacy-peer-deps

    echo "Building application..."
    npx electron-vite build
    npx electron-builder --linux --dir --config electron-builder.config.mjs

    if [ ! -f "${DIST_DIR}/${APP_NAME}" ]; then
        echo -e "${RED}Build failed. Please check the errors above.${NC}"
        exit 1
    fi
fi

# Step 2: Remove old installation if exists
if [ -d "${APP_DIR}" ]; then
    echo "Removing previous installation..."
    sudo rm -rf "${APP_DIR}"
fi

# Step 3: Copy entire app directory to /opt
echo ""
echo "Installing application to ${APP_DIR} ..."
sudo mkdir -p "${APP_DIR}"
sudo cp -a "${DIST_DIR}/." "${APP_DIR}/"
sudo chmod +x "${APP_DIR}/${APP_NAME}"
echo -e "${GREEN}✓${NC} Copied application files"

# Step 4: Fix chrome-sandbox permissions (required for desktop-menu launches)
if [ -f "${APP_DIR}/chrome-sandbox" ]; then
    sudo chown root:root "${APP_DIR}/chrome-sandbox"
    sudo chmod 4755 "${APP_DIR}/chrome-sandbox"
    echo -e "${GREEN}✓${NC} Fixed chrome-sandbox permissions (root + setuid)"
else
    echo -e "${YELLOW}⚠${NC} chrome-sandbox missing — app will run with --no-sandbox fallback"
fi

# Step 5: Install launcher wrapper (must NOT be a symlink to the raw binary).
# Chromium may FATAL before app JS runs if chrome-sandbox is not root+setuid.
sudo rm -f "${INSTALL_BIN}"
sudo install -m 755 "${SCRIPT_DIR}/linux-launcher.sh" "${INSTALL_BIN}"
echo -e "${GREEN}✓${NC} Installed launcher wrapper ${INSTALL_BIN}"

# Step 6: Install icon
if [ -f "${PROJECT_DIR}/build/icons/512x512.png" ]; then
    sudo mkdir -p "$(dirname "${INSTALL_ICON}")"
    sudo cp "${PROJECT_DIR}/build/icons/512x512.png" "${INSTALL_ICON}"
    # Also drop a copy next to the binary for window icon resolution
    sudo cp "${PROJECT_DIR}/build/icons/512x512.png" "${APP_DIR}/icon.png" 2>/dev/null || true
    echo -e "${GREEN}✓${NC} Installed icon"
elif [ -f "${PROJECT_DIR}/build/icon.png" ]; then
    sudo mkdir -p "$(dirname "${INSTALL_ICON}")"
    sudo cp "${PROJECT_DIR}/build/icon.png" "${INSTALL_ICON}"
    sudo cp "${PROJECT_DIR}/build/icon.png" "${APP_DIR}/icon.png" 2>/dev/null || true
    echo -e "${GREEN}✓${NC} Installed icon"
else
    echo -e "${YELLOW}⚠${NC} No icon found to install"
fi

# Step 7: System desktop entry — use the wrapper in /usr/local/bin (never project dist/)
sudo mkdir -p "$(dirname "${INSTALL_DESKTOP}")"
write_desktop_entry "${INSTALL_DESKTOP}" "${INSTALL_BIN}" "${APP_NAME}"
echo -e "${GREEN}✓${NC} Installed system desktop entry -> ${INSTALL_BIN}"

# Step 8: Always overwrite user desktop entry (GNOME prefers ~/.local).
mkdir -p "$(dirname "${USER_DESKTOP}")"
if [ -f "${USER_DESKTOP}" ]; then
    echo -e "${YELLOW}!${NC} Replacing user desktop entry (was):"
    grep -n '^Exec=' "${USER_DESKTOP}" 2>/dev/null || true
fi
write_desktop_entry "${USER_DESKTOP}" "${INSTALL_BIN}" "${APP_NAME}"
chmod 644 "${USER_DESKTOP}"
echo -e "${GREEN}✓${NC} User desktop entry now points to ${INSTALL_BIN}"

# Verify launcher is a script, not a bare ELF symlink (common install mistake).
if file "${INSTALL_BIN}" | grep -qi 'ELF'; then
    echo -e "${RED}Error: ${INSTALL_BIN} is still a raw binary/symlink. Re-run install.${NC}"
    exit 1
fi

# Step 9: Install MIME metadata and icons so .md / .markdown files keep custom icons.
if [ -f "${MIME_XML}" ]; then
    sudo mkdir -p "$(dirname "${INSTALL_MIME_PACKAGE}")"
    sudo cp "${MIME_XML}" "${INSTALL_MIME_PACKAGE}"
    for icon_name in text-markdown text-x-markdown; do
        install_mime_icon 64 "${PROJECT_DIR}/build/file-associations/text-markdown-64.png" "${icon_name}"
        install_mime_icon 128 "${PROJECT_DIR}/build/file-associations/text-markdown-128.png" "${icon_name}"
        install_mime_icon 256 "${PROJECT_DIR}/build/file-associations/text-markdown-256.png" "${icon_name}"
        install_mime_icon 512 "${PROJECT_DIR}/build/file-associations/text-markdown-512.png" "${icon_name}"
    done
    if command -v update-mime-database &> /dev/null; then
        sudo update-mime-database "${INSTALL_MIME_DIR}" 2>/dev/null || true
    fi
    echo -e "${GREEN}✓${NC} Installed Markdown MIME type and icons"
fi

# Step 10: Update desktop / icon caches
if command -v update-desktop-database &> /dev/null; then
    sudo update-desktop-database /usr/local/share/applications/ 2>/dev/null || true
    update-desktop-database "$(dirname "${USER_DESKTOP}")" 2>/dev/null || true
fi
if command -v gtk-update-icon-cache &> /dev/null; then
    sudo gtk-update-icon-cache -f /usr/local/share/icons/hicolor 2>/dev/null || true
fi

echo ""
echo -e "${GREEN}=== Installation complete! ===${NC}"
echo ""
echo "You can now:"
echo "  • Run from terminal:  ${APP_NAME}"
echo "  • Find it in your application menu under 'Markdown Editor Pro'"
echo "  • Open .md files with: ${APP_NAME} <file.md>"
echo ""
echo -e "${YELLOW}If the menu still fails to open the app:${NC}"
echo "  1. Log out/in (or run: update-desktop-database ~/.local/share/applications)"
echo "  2. Confirm Exec points to /opt (not dist/linux-unpacked):"
echo "       grep ^Exec= ~/.local/share/applications/${APP_NAME}.desktop"
echo "  3. Test: gtk-launch ${APP_NAME}"
echo ""
echo -e "${YELLOW}To uninstall, run:${NC}"
echo "  sudo rm -rf ${APP_DIR} ${INSTALL_BIN} ${INSTALL_ICON} ${INSTALL_DESKTOP}"
echo "  sudo rm -f ${INSTALL_MIME_PACKAGE}"
echo "  sudo find ${INSTALL_MIME_ICON_DIR} -path '*/mimetypes/text-*-markdown.png' -delete"
echo "  rm -f ${USER_DESKTOP}"
