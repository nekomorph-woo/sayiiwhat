#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_DIR="$ROOT_DIR/vendor/whisper.cpp"
REPO_URL="https://github.com/ggerganov/whisper.cpp.git"
REVISION="5ed76e9a"

mkdir -p "$ROOT_DIR/vendor"

if [[ -d "$VENDOR_DIR/.git" ]]; then
  git -C "$VENDOR_DIR" fetch origin "$REVISION"
else
  rm -rf "$VENDOR_DIR"
  git clone "$REPO_URL" "$VENDOR_DIR"
  git -C "$VENDOR_DIR" fetch origin "$REVISION"
fi

git -C "$VENDOR_DIR" checkout --detach "$REVISION"
echo "vendor/whisper.cpp is ready at $(git -C "$VENDOR_DIR" rev-parse --short HEAD)"
