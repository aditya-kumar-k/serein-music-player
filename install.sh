#!/bin/bash
# Adds Serien Music Player to your application launcher (installs a .desktop entry for this folder).
set -e
APP_DIR="$(dirname "$(readlink -f "$0")")"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$DEST"
sed "s|@APP_DIR@|$APP_DIR|g" "$APP_DIR/music-player.desktop.in" > "$DEST/serien-music-player.desktop"
chmod +x "$APP_DIR/launch.sh"
command -v update-desktop-database >/dev/null && update-desktop-database "$DEST" 2>/dev/null || true
echo "Installed: $DEST/serien-music-player.desktop"
