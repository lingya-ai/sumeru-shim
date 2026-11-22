#!/usr/bin/env bash
# Package the built chrome + runtime files into an artifact ().
#
#   bash chromium/scripts/package-kernel.sh [output-dir]
#
# Inputs:  $SUMERU_SRC/out/release-linux/chrome (default /src)
# Output:  <out>/sumeru-kernel-<chromium>-<commit>-linux-x64.tar.gz + .sha256
set -euo pipefail

SRC="${SUMERU_SRC:-/src}"
OUT="${1:-/out}"
BUILT="${SUMERU_BUILT:-$SRC/out/release-linux}"
CHROME="$BUILT/chrome"
VERSION="${SUMERU_VERSION:-156.0.8078.74}"
COMMIT="${SUMERU_COMMIT:-$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)}"
NAME="sumeru-kernel-${VERSION}-${COMMIT}-linux-x64.tar.gz"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

[ -f "$CHROME" ] || { echo "[package] missing $CHROME" >&2; exit 2; }
mkdir -p "$OUT"

cp "$CHROME" "$STAGE/chrome"
strip --strip-unneeded "$STAGE/chrome" 2>/dev/null || true
if [ -f "$BUILT/chrome_sandbox.stripped" ]; then
  cp "$BUILT/chrome_sandbox.stripped" "$STAGE/chrome-sandbox"
  chmod 4755 "$STAGE/chrome-sandbox"
fi
for f in chrome_100_percent.pak chrome_200_percent.pak chrome_crashpad_handler \
         chrome-sandbox icudtl.dat libEGL.so libGLESv2.so libvk_swiftshader.so \
         libvulkan.so.1 resources.pak snapshot_blob.bin v8_context_snapshot.bin; do
  [ -f "$BUILT/$f" ] && cp "$BUILT/$f" "$STAGE/$f"
done
for d in locales angledata; do
  [ -d "$BUILT/$d" ] && cp -a "$BUILT/$d" "$STAGE/$d"
done
[ -f "$BUILT/LICENSES.chromium.html" ] && cp "$BUILT/LICENSES.chromium.html" "$STAGE/"

tar -czf "$OUT/$NAME" -C "$STAGE" .
sha256sum "$OUT/$NAME" > "$OUT/$NAME.sha256"
echo "[package] $OUT/$NAME"
cat "$OUT/$NAME.sha256"
