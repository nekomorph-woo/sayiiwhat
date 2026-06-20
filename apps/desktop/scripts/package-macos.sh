#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
TAURI_CONF="$ROOT_DIR/apps/desktop/src-tauri/tauri.conf.json"
PRODUCT_NAME="$(node -e "const c=require(process.argv[1]); console.log(c.productName)" "$TAURI_CONF")"
VERSION="$(node -e "const c=require(process.argv[1]); console.log(c.version)" "$TAURI_CONF")"
ARCH="$(uname -m)"
if [[ "$ARCH" == "arm64" ]]; then
  TAURI_ARCH="aarch64"
else
  TAURI_ARCH="$ARCH"
fi

APP_DIR="$ROOT_DIR/apps/desktop/src-tauri/target/release/bundle/macos/${PRODUCT_NAME}.app"
RESOURCE_DIR="$APP_DIR/Contents/Resources/resources/bin/macos"
SOURCE_DIR="$ROOT_DIR/apps/desktop/src-tauri/resources/bin/macos"
MODEL_RESOURCE_DIR="$APP_DIR/Contents/Resources/resources/models"
MODEL_SOURCE_DIR="$ROOT_DIR/apps/desktop/src-tauri/resources/models"
DMG_PATH="$ROOT_DIR/apps/desktop/src-tauri/target/release/bundle/macos/${PRODUCT_NAME}_${VERSION}_${TAURI_ARCH}.dmg"
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

STAGING_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGING_DIR"' EXIT

cp -R "$APP_DIR" "$STAGING_DIR/${PRODUCT_NAME}.app"
ln -s /Applications "$STAGING_DIR/Applications"

rm -f "$DMG_PATH"
hdiutil create -volname "$PRODUCT_NAME" -srcfolder "$STAGING_DIR" -ov -format UDZO "$DMG_PATH"
find "$(dirname "$DMG_PATH")" -maxdepth 1 -type f -name "rw.*.$(basename "$DMG_PATH")" -delete
echo "$DMG_PATH"
