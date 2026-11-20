#!/usr/bin/env bash
# Fetch a Chromium source tree for a kernel build, one directory per version.
#
#   chromium/scripts/fetch-kernel-source.sh
#   chromium/scripts/fetch-kernel-source.sh --version 156.0.8078.74
#   chromium/scripts/fetch-kernel-source.sh --sync
#
# Layout (gitignored):
#   chromium-src/
#     .depot_tools/
#     156.0.8078.74/
#       .gclient
#       src/            <- DEPS, buildtools/linux64/gn, third_party/ninja/ninja
#
# Requires Linux/WSL2 with git, python3 and network access to
# chromium.googlesource.com. The resulting src/ is bind-mounted to /src for
# chromium/Dockerfile.kernel.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="$(cat "$ROOT/chromium/VERSION")"
SYNC=0
BASE="$ROOT/chromium-src"
URL="https://chromium.googlesource.com/chromium/src.git"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || { echo "--version needs a value" >&2; exit 2; }
      VERSION="$2"
      shift 2
      ;;
    --sync)
      SYNC=1
      shift
      ;;
    -h|--help)
      sed -n '2,23p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

log() { echo "[fetch-kernel-source] $*" >&2; }

TARGET="$BASE/$VERSION"
SRC="$TARGET/src"

# Pick up an existing depot_tools, or clone a local copy once.
if ! command -v gclient >/dev/null 2>&1; then
  DEPOT="$BASE/.depot_tools"
  if [ ! -x "$DEPOT/gclient" ]; then
    log "depot_tools not found; cloning to $DEPOT"
    mkdir -p "$BASE"
    git clone --depth=1 https://chromium.googlesource.com/chromium/tools/depot_tools.git "$DEPOT"
  fi
  export PATH="$DEPOT:$PATH"
fi
command -v gclient >/dev/null 2>&1 || { log "gclient still not available"; exit 3; }

if [ -f "$SRC/DEPS" ] && [ "$SYNC" = "0" ]; then
  log "source already present: $SRC"
  log "use --sync to refresh, or remove $TARGET to re-fetch"
  echo "SUMERU_SRC=$SRC"
  exit 0
fi

mkdir -p "$TARGET"
cd "$TARGET"

if [ ! -f .gclient ]; then
  log "configuring gclient (version $VERSION)"
  gclient config --name src "$URL"
fi

if [ ! -d "$SRC/.git" ]; then
  log "initial gclient sync (this downloads ~25 GB)"
  gclient sync -D --with_branch_heads --with_tags --nohooks
fi

log "checking out Chromium $VERSION"
git -C "$SRC" fetch --tags --prune
git -C "$SRC" checkout "$VERSION"

log "syncing dependencies/hooks for $VERSION"
gclient sync -D --with_branch_heads --with_tags

[ -f "$SRC/DEPS" ] || { log "missing $SRC/DEPS"; exit 4; }
[ -x "$SRC/buildtools/linux64/gn" ] || { log "missing $SRC/buildtools/linux64/gn"; exit 4; }
[ -x "$SRC/third_party/ninja/ninja" ] || { log "missing $SRC/third_party/ninja/ninja"; exit 4; }

log "ready: $SRC"
echo "SUMERU_SRC=$SRC"