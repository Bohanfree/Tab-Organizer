#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require(process.argv[1]).version" "$ROOT_DIR/manifest.json")"
mkdir -p "$ROOT_DIR/packages"
ZIP_FILE="$ROOT_DIR/packages/atlas-tab-organizer-chromium-v${VERSION}.zip"
rm -f "$ZIP_FILE"
cd "$ROOT_DIR"
zip -qr "$ZIP_FILE" manifest.json popup.html popup.css popup.js service-worker.js icons
printf 'Chromium package built at: %s\n' "$ZIP_FILE"
