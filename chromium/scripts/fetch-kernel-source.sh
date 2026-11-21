#!/usr/bin/env bash
# Fetch a Chromium source tree for a kernel build, one directory per version.
#
#   chromium/scripts/fetch-kernel-source.sh
#   chromium/scripts/fetch-kernel-source.sh --version 156.0.8078.74
#   chromium/scripts/fetch-kernel-source.sh --shallow
#   chromium/scripts/fetch-kernel-source.sh --shallow --depth 20 --jobs 2
#   chromium/scripts/fetch-kernel-source.sh --sync --shallow
#   chromium/scripts/fetch-kernel-source.sh --proxy http://127.0.0.1:3128
#   SUMERU_PROXY=http://127.0.0.1:3128 chromium/scripts/fetch-kernel-source.sh
#
# No --proxy and no SUMERU_PROXY means: use no proxy at all. The script explicitly
# disables inherited *_proxy variables and the git global proxy for its children.
#
# Layout (gitignored):
#   chromium-src/
#     .depot_tools/
#     156.0.8078.74/
#       .gclient
#       src/            <- DEPS, buildtools/linux64/gn, third_party/ninja/ninja
#
# --shallow uses `git clone --depth` for the main tree and
# `gclient sync --no-history` for deps. This avoids the ~70 GB full history.
# --no-hooks skips `gclient runhooks`; the kernel build script can fetch
# clang/sysroot later.
#
# Requires Linux/WSL2 with git, python3 and network access to
# chromium.googlesource.com. The resulting src/ is bind-mounted to /src for
# chromium/Dockerfile.kernel.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="$(cat "$ROOT/chromium/VERSION")"
SYNC=0
SHALLOW=0
DEPTH=1
JOBS=1
RUN_HOOKS=1
BASE="$ROOT/chromium-src"
URL="https://chromium.googlesource.com/chromium/src.git"
PROXY="${SUMERU_PROXY:-}"

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
    --shallow)
      SHALLOW=1
      shift
      ;;
    --depth)
      [ "$#" -ge 2 ] || { echo "--depth needs a value" >&2; exit 2; }
      DEPTH="$2"
      SHALLOW=1
      shift 2
      ;;
    --jobs)
      [ "$#" -ge 2 ] || { echo "--jobs needs a value" >&2; exit 2; }
      JOBS="$2"
      shift 2
      ;;
    --no-hooks)
      RUN_HOOKS=0
      shift
      ;;
    --proxy)
      [ "$#" -ge 2 ] || { echo "--proxy needs a value" >&2; exit 2; }
      PROXY="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,29p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$DEPTH" in
  ''|*[!0-9]*|0) echo "--depth must be a positive integer" >&2; exit 2 ;;
esac
case "$JOBS" in
  ''|*[!0-9]*|0) echo "--jobs must be a positive integer" >&2; exit 2 ;;
esac

log() { echo "[fetch-kernel-source] $*" >&2; }

# Proxy policy: explicit only. No proxy is inherited by default.
if [ -n "$PROXY" ]; then
  case "$PROXY" in
    http://*|https://*|socks5://*|socks5h://*) ;;
    *)
      log "invalid --proxy (expected http://, https://, socks5:// or socks5h://): $PROXY"
      exit 2
      ;;
  esac
  proxy_display="$(printf '%s' "$PROXY" | sed -E 's#(://)[^/@]+@#\1***@#')"
  log "using explicit proxy: $proxy_display"
  export http_proxy="$PROXY" https_proxy="$PROXY" all_proxy="$PROXY"
  export HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" ALL_PROXY="$PROXY"
  export no_proxy="${no_proxy:-127.0.0.1,localhost}" NO_PROXY="${no_proxy:-127.0.0.1,localhost}"
  export GIT_CONFIG_COUNT=2
  export GIT_CONFIG_KEY_0=http.proxy GIT_CONFIG_VALUE_0="$PROXY"
  export GIT_CONFIG_KEY_1=https.proxy GIT_CONFIG_VALUE_1="$PROXY"
else
  log "proxy: disabled (pass --proxy or set SUMERU_PROXY to enable)"
  unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
  unset no_proxy NO_PROXY
  export GIT_CONFIG_NOSYSTEM=1
  export GIT_CONFIG_COUNT=2
  export GIT_CONFIG_KEY_0=http.proxy GIT_CONFIG_VALUE_0=
  export GIT_CONFIG_KEY_1=https.proxy GIT_CONFIG_VALUE_1=
fi

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
export DEPOT_TOOLS_UPDATE=0

if [ -f "$SRC/DEPS" ] && [ "$SYNC" = "0" ]; then
  log "source already present: $SRC"
  log "use --sync to refresh, or remove $TARGET to re-fetch"
  echo "SUMERU_SRC=$SRC"
  exit 0
fi

mkdir -p "$TARGET"
cd "$TARGET"

if [ "$SHALLOW" = "1" ]; then
  if [ ! -d "$SRC/.git" ]; then
    log "shallow clone Chromium $VERSION (depth=$DEPTH)"
    git clone --depth="$DEPTH" --branch "$VERSION" "$URL" "$SRC"
  else
    log "refreshing existing shallow source to $VERSION"
    git -C "$SRC" fetch --depth="$DEPTH" origin "refs/tags/$VERSION" || true
    git -C "$SRC" checkout "$VERSION"
  fi

  log "writing unmanaged .gclient (gclient will only sync DEPS)"
  cat > .gclient <<'EOF'
solutions = [
  {
    "name": "src",
    "url": "https://chromium.googlesource.com/chromium/src.git",
    "deps_file": "DEPS",
    "managed": False,
    "custom_deps": {},
    "custom_vars": {},
  },
]
EOF

  log "gclient sync --no-history --nohooks -j $JOBS"
  gclient sync -D --no-history --nohooks -j "$JOBS"

  if [ "$RUN_HOOKS" = "1" ]; then
    log "gclient runhooks"
    gclient runhooks
  fi
else
  if [ ! -f .gclient ]; then
    log "configuring gclient (version $VERSION)"
    gclient config --name src "$URL"
  fi

  if [ ! -d "$SRC/.git" ]; then
    log "initial full gclient sync (this downloads ~25 GB source + history)"
    gclient sync -D --with_branch_heads --with_tags --nohooks
  fi

  log "checking out Chromium $VERSION"
  git -C "$SRC" fetch --tags --prune
  git -C "$SRC" checkout "$VERSION"

  if [ "$RUN_HOOKS" = "1" ]; then
    log "syncing dependencies/hooks for $VERSION"
    gclient sync -D --with_branch_heads --with_tags
  else
    log "syncing dependencies without hooks for $VERSION"
    gclient sync -D --with_branch_heads --with_tags --nohooks
  fi
fi

[ -f "$SRC/DEPS" ] || { log "missing $SRC/DEPS"; exit 4; }
[ -x "$SRC/buildtools/linux64/gn" ] || { log "missing $SRC/buildtools/linux64/gn"; exit 4; }
[ -x "$SRC/third_party/ninja/ninja" ] || { log "missing $SRC/third_party/ninja/ninja"; exit 4; }

log "ready: $SRC"
echo "SUMERU_SRC=$SRC"