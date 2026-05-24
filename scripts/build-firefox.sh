#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist/firefox"

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

cp "$ROOT_DIR/manifest.firefox.json" "$DIST_DIR/manifest.json"
cp "$ROOT_DIR/popup.html" "$DIST_DIR/popup.html"
cp "$ROOT_DIR/popup.css" "$DIST_DIR/popup.css"
cp "$ROOT_DIR/popup.js" "$DIST_DIR/popup.js"
cp "$ROOT_DIR/service-worker.js" "$DIST_DIR/service-worker.js"

echo "Firefox extension built at: $DIST_DIR"
