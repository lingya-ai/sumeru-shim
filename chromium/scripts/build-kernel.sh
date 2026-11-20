#!/usr/bin/env bash
# Apply chromium/overlay/current.patch and build chrome ().
#
# Expected layout:
#   /src                 Chromium source at 156.0.8078.74
#   /overlay/current.patch
#   /overlay/args.gn.linux
#   /out                 optional; build output stays in /src/out/release-linux
set -euo pipefail

SRC="${SUMERU_SRC:-/src}"
OUT="${SUMERU_OUT:-$SRC/out/release-linux}"
PATCH="${SUMERU_OVERLAY:-/overlay/current.patch}"
ARGS="${SUMERU_ARGS:-/overlay/args.gn.linux}"
GN="$SRC/buildtools/linux64/gn"
NINJA="$SRC/third_party/ninja/ninja"

log() { echo "[kernel] $*" >&2; }

[ -f "$SRC/DEPS" ] || { log "no Chromium source at $SRC (expected DEPS)"; exit 2; }
[ -f "$PATCH" ] || { log "missing overlay: $PATCH"; exit 3; }
[ -x "$GN" ] || { log "missing gn: $GN"; exit 4; }
[ -x "$NINJA" ] || { log "missing ninja: $NINJA"; exit 4; }

# Apply overlay once. If it is already applied, reverse-check succeeds.
if git -C "$SRC" apply --check "$PATCH" >/dev/null 2>&1; then
  log "applying $PATCH"
  git -C "$SRC" apply --whitespace=nowarn "$PATCH"
elif git -C "$SRC" apply --reverse --check "$PATCH" >/dev/null 2>&1; then
  log "overlay already applied"
else
  log "overlay does not apply cleanly (wrong Chromium tag or local edits)"
  exit 5
fi

# Toolchain/sysroot (idempotent; needs network on a fresh tree).
if [ ! -d "$SRC/third_party/llvm-build/Release+Asserts/bin" ]; then
  log "fetching clang (CIPD)"
  (cd "$SRC" && python3 tools/clang/scripts/update.py)
fi
if [ ! -d "$SRC/build/linux/debian_bullseye_amd64-sysroot" ]; then
  log "fetching sysroot"
  (cd "$SRC" && python3 build/linux/sysroot_scripts/install-sysroot.py --arch=amd64)
fi

mkdir -p "$OUT"
cp "$ARGS" "$OUT/args.gn"
log "gn gen $OUT"
(cd "$SRC" && "$GN" gen "$OUT")

log "ninja chrome (first build 4-8h)"
"$NINJA" -C "$OUT" chrome

log "done: $OUT/chrome"
"$OUT/chrome" --version || true
