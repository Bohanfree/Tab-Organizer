#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist/firefox"
UNPACKED_DIR="$ROOT_DIR/firefox-unpacked"
PACKAGE_DIR="$ROOT_DIR/packages"
VERSION="$(node -e "const fs = require('fs'); console.log(JSON.parse(fs.readFileSync(process.argv[1], 'utf8')).version)" "$ROOT_DIR/manifest.firefox.json")"
ZIP_FILE="$PACKAGE_DIR/tab-organizer-firefox-v${VERSION}.zip"
XPI_FILE="$PACKAGE_DIR/tab-organizer-firefox-v${VERSION}.xpi"

mkdir -p "$PACKAGE_DIR"

copy_firefox_files() {
  local target_dir="$1"

  rm -rf "$target_dir"
  mkdir -p "$target_dir"

  cp "$ROOT_DIR/manifest.firefox.json" "$target_dir/manifest.json"
  cp "$ROOT_DIR/popup.html" "$target_dir/popup.html"
  cp "$ROOT_DIR/popup.css" "$target_dir/popup.css"
  cp "$ROOT_DIR/popup.js" "$target_dir/popup.js"
  cp "$ROOT_DIR/service-worker.js" "$target_dir/service-worker.js"
}

copy_firefox_files "$DIST_DIR"
copy_firefox_files "$UNPACKED_DIR"

echo "Firefox extension built at: $DIST_DIR"
echo "Firefox unpacked extension built at: $UNPACKED_DIR"

rm -f "$ZIP_FILE" "$XPI_FILE"
(
  cd "$UNPACKED_DIR"
  zip -qr "$ZIP_FILE" .
  zip -qr "$XPI_FILE" .
)

echo "Firefox zip package built at: $ZIP_FILE"
echo "Firefox xpi package built at: $XPI_FILE"
