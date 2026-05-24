#!/usr/bin/env bash
set -e

VERSION=$(node -p "require('./package.json').version")
TIMESTAMP=$(date +%Y%m%d-%H%M)
OUTPUT_DIR="$HOME/apk-builds"
APK_NAME="dexdroid-v${VERSION}-${TIMESTAMP}.apk"

echo "🔨 Building dexdroid v${VERSION}..."
pnpm tauri android build --apk --target aarch64

SOURCE_APK="src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release.apk"

if [ ! -f "$SOURCE_APK" ]; then
  echo "❌ Build succeeded but APK not found"
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
cp "$SOURCE_APK" "$OUTPUT_DIR/$APK_NAME"

SIZE=$(du -h "$OUTPUT_DIR/$APK_NAME" | cut -f1)
echo ""
echo "✅ Build complete"
echo "📦 $OUTPUT_DIR/$APK_NAME ($SIZE)"
echo "👉 Download from VS Code file explorer (~/apk-builds/)"
