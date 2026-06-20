#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
APP_DIR="$ROOT_DIR/apps/desktop/src-tauri/target/release/bundle/macos/sayiiwhat.app"
RESOURCE_DIR="$APP_DIR/Contents/Resources/resources/bin/macos"
SOURCE_DIR="$ROOT_DIR/apps/desktop/src-tauri/resources/bin/macos"
MODEL_RESOURCE_DIR="$APP_DIR/Contents/Resources/resources/models"
MODEL_SOURCE_DIR="$ROOT_DIR/apps/desktop/src-tauri/resources/models"
DMG_PATH="$ROOT_DIR/apps/desktop/src-tauri/target/release/bundle/macos/sayiiwhat_0.1.0_aarch64.dmg"

if [[ ! -d "$APP_DIR" ]]; then
  echo "missing app bundle: $APP_DIR" >&2
  exit 1
fi

mkdir -p "$RESOURCE_DIR"
rsync -a "$SOURCE_DIR/" "$RESOURCE_DIR/"
mkdir -p "$MODEL_RESOURCE_DIR"
rsync -a "$MODEL_SOURCE_DIR/" "$MODEL_RESOURCE_DIR/"
chmod +x "$RESOURCE_DIR/ffmpeg" "$RESOURCE_DIR/ffprobe" "$RESOURCE_DIR/whisper-cli" || true
chmod +x "$RESOURCE_DIR"/*.dylib || true

rm -f "$DMG_PATH"
hdiutil create -volname sayiiwhat -srcfolder "$APP_DIR" -ov -format UDZO "$DMG_PATH"
echo "$DMG_PATH"
