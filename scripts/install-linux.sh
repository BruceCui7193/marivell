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
DIST_DIR="${PROJECT_DIR}/dist/linux-unpacked"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}=== Markdown Editor Pro - Linux Installer ===${NC}"
echo ""

# Step 1: Check if build exists
if [ ! -f "${DIST_DIR}/${APP_NAME}" ]; then
    echo -e "${YELLOW}No build found. Building first...${NC}"
    cd "${PROJECT_DIR}"

    # Check node
    if ! command -v node &> /dev/null; then
        echo -e "${RED}Error: Node.js is required but not installed.${NC}"
        echo "Install it with: sudo apt install nodejs npm"
        exit 1
    fi

    # Install dependencies
    echo "Installing dependencies..."
    npm install

    # Build
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
sudo cp -r "${DIST_DIR}/"* "${APP_DIR}/"
sudo chmod +x "${APP_DIR}/${APP_NAME}"
echo -e "${GREEN}✓${NC} Copied application files"

# Step 4: Fix chrome-sandbox permissions
if [ -f "${APP_DIR}/chrome-sandbox" ]; then
    sudo chown root:root "${APP_DIR}/chrome-sandbox" 2>/dev/null || true
    sudo chmod 4755 "${APP_DIR}/chrome-sandbox" 2>/dev/null || true
    echo -e "${GREEN}✓${NC} Fixed chrome-sandbox permissions"
fi

# Step 5: Create symlink in /usr/local/bin
sudo rm -f "${INSTALL_BIN}"
sudo ln -sf "${APP_DIR}/${APP_NAME}" "${INSTALL_BIN}"
echo -e "${GREEN}✓${NC} Created symlink ${INSTALL_BIN} -> ${APP_DIR}/${APP_NAME}"

# Step 6: Install icon
if [ -f "${PROJECT_DIR}/build/icons/512x512.png" ]; then
    sudo mkdir -p "$(dirname "${INSTALL_ICON}")"
    sudo cp "${PROJECT_DIR}/build/icons/512x512.png" "${INSTALL_ICON}"
    echo -e "${GREEN}✓${NC} Installed icon"
elif [ -f "${PROJECT_DIR}/build/icon.png" ]; then
    sudo mkdir -p "$(dirname "${INSTALL_ICON}")"
    sudo cp "${PROJECT_DIR}/build/icon.png" "${INSTALL_ICON}"
    echo -e "${GREEN}✓${NC} Installed icon"
else
    echo -e "${YELLOW}⚠${NC} No icon found to install"
fi

# Step 7: Install .desktop entry (pointing to /opt)
sudo mkdir -p "$(dirname "${INSTALL_DESKTOP}")"
cat << DESKTOP_EOF | sudo tee "${INSTALL_DESKTOP}" > /dev/null
[Desktop Entry]
Name=Markdown Editor Pro
Comment=A professional Markdown editor
Exec=${APP_DIR}/${APP_NAME} %F
Icon=${APP_NAME}
Terminal=false
Type=Application
Categories=Office;TextEditor;
MimeType=text/markdown;
StartupWMClass=${APP_NAME}
Keywords=markdown;editor;text;document;
DESKTOP_EOF
echo -e "${GREEN}✓${NC} Installed desktop entry"

# Step 8: Update desktop database
if command -v update-desktop-database &> /dev/null; then
    sudo update-desktop-database /usr/local/share/applications/ 2>/dev/null || true
fi

echo ""
echo -e "${GREEN}=== Installation complete! ===${NC}"
echo ""
echo "You can now:"
echo "  • Run from terminal:  ${APP_NAME}"
echo "  • Find it in your application menu under 'Markdown Editor Pro'"
echo "  • Open .md files with: ${APP_NAME} <file.md>"
echo ""
echo -e "${YELLOW}To uninstall, run:${NC}"
echo "  sudo rm -rf ${APP_DIR} ${INSTALL_BIN} ${INSTALL_ICON} ${INSTALL_DESKTOP}"
