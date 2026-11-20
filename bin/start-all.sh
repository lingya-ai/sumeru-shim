#!/usr/bin/env bash
# 须弥启动编排（gateway-only）：
#   Xvfb :99 → x11vnc → websockify/noVNC 网页(:6901)
#   shim（node src/index.mjs）→ spawn chrome（原生窗口）→ gateway UDS → HTTP(:8080)
# 人类：noVNC 观看 + 直接操作（无门控、无仲裁）
set -e

# IME fail-fast：声明 SUMERU_IME=fcitx 而镜像里没有 fcitx5 二进制时，
# 直接启动报错退出——不要把「没有输入法」的镜像当成健康镜像跑起来（IME 缺失时应 fail-fast）。
# 未设 SUMERU_IME 时不体检：/healthz 的 ime 层恒 true 并标注 "ime:not-configured"。
require_ime_binary() {
  if [ "${SUMERU_IME:-0}" = "fcitx" ] && ! command -v fcitx5 >/dev/null 2>&1; then
    echo "[start-all] fail-fast: SUMERU_IME=fcitx 但镜像内找不到 fcitx5 二进制，拒绝启动" >&2
    exit 1
  fi
}
require_ime_binary

# 1) 虚拟显示（无头环境下跑 GUI）
# docker restart 会保留 /tmp：上一轮残留的 X99 socket 会让 chrome 抢在 X 就绪前启动
# 而退出（F8，2026-11-16 E2E 复现）。启动前先清掉残留，再等 socket 真正出现。
rm -f /tmp/.X11-unix/X99 /tmp/.X99-lock
# 分辨率（SUMERU_SCREEN=WxH[xD]）——**唯一来源**，默认 1280x800x24（产品既定几何）。
# 这里 export 出去，shim 会把 chrome 窗口尺寸自动对齐到同一块屏幕
# （见 src/runtime.mjs windowSize），所以两处不会漂移。
# 想换 1K 就 `-e SUMERU_SCREEN=1920x1080x24`。
export SUMERU_SCREEN="${SUMERU_SCREEN:-1280x800x24}"
Xvfb :99 -screen 0 "$SUMERU_SCREEN" -nolisten tcp >/tmp/xvfb.log 2>&1 &
for _ in $(seq 1 40); do
  [ -S /tmp/.X11-unix/X99 ] && break
  sleep 0.25
done
[ -S /tmp/.X11-unix/X99 ] || { echo "[start-all] Xvfb :99 socket not ready" >&2; exit 1; }

# 2) VNC 服务（把 :99 显示暴露成 VNC）
x11vnc -display :99 -shared -forever -nopw -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
sleep 2

# 3) VNC → WebSocket（网页 noVNC 通过它连 VNC）
websockify --web=/usr/share/novnc 6901 localhost:5900 >/tmp/ws.log 2>&1 &

# 4) shim（spawn chrome + HTTP 8080）；DISPLAY 让 chrome 用虚拟显示（原生窗口）
export DISPLAY=:99

if [ "${SUMERU_IME:-0}" = "fcitx" ]; then
  export GTK_IM_MODULE="${SUMERU_IME_MODULE:-fcitx}"
  export XMODIFIERS="@im=${SUMERU_IME_NAME:-fcitx}"
  export QT_IM_MODULE=fcitx
  if command -v dbus-launch >/dev/null 2>&1; then
    eval "$(dbus-launch --sh-syntax)"
  fi
  fcitx5_config="${HOME:-/data}/.config/fcitx5"
  mkdir -p "${fcitx5_config}"
  if [ ! -f "${fcitx5_config}/profile" ]; then
    cat > "${fcitx5_config}/profile" <<'EOF'
[Groups/0]
Name=Default
Default Layout=us
DefaultIM=pinyin

[Groups/0/Items/0]
Name=keyboard-us
Layout=

[Groups/0/Items/1]
Name=pinyin
Layout=

[GroupOrder]
0=Default
EOF
  fi
  fcitx5 -d --replace >/tmp/fcitx5.log 2>&1 &
  sleep 1
elif [ "${SUMERU_IME:-0}" = "1" ]; then
  export GTK_IM_MODULE="${SUMERU_IME_MODULE:-ibus}"
  export XMODIFIERS=@im=ibus
  export QT_IM_MODULE=ibus
  if command -v dbus-launch >/dev/null 2>&1; then
    eval "$(dbus-launch --sh-syntax)"
  fi
  ibus-daemon -drx >/tmp/ibus.log 2>&1 &
  sleep 1
  for _ in $(seq 1 20); do
    bus_file=$(find "${HOME:-/home/chrome}/.config/ibus/bus" -type f 2>/dev/null | head -1)
    if [ -n "${bus_file}" ]; then
      ibus_addr=$(sed -n 's/^IBUS_ADDRESS=//p' "${bus_file}" | head -1)
      if [ -n "${ibus_addr}" ]; then
        export IBUS_ADDRESS="${ibus_addr}"
        break
      fi
    fi
    sleep 0.2
  done
fi

# S7 security baseline: /data/profile holds cookies, tokens and the login state.
# The image creates it 0755, which makes every secret world-readable inside the
# container. Tighten it on every boot (idempotent, survives volume restore).
mkdir -p /data/profile
chmod 700 /data/profile 2>/dev/null || true
mkdir -p /data/hot/cache 2>/dev/null || true
chmod 700 /data/hot /data/hot/cache 2>/dev/null || true

# Gateway token: random per boot unless explicitly provided. The token is
# internal to the container (shim + chrome share it); external clients use /gw.
if [ -z "${SUMERU_GATEWAY_TOKEN:-}" ]; then
  SUMERU_GATEWAY_TOKEN="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  export SUMERU_GATEWAY_TOKEN
  echo "[start-all] generated SUMERU_GATEWAY_TOKEN (${#SUMERU_GATEWAY_TOKEN} hex chars)" >&2
fi

# 收缩后只剩一条通道：chrome 由 shim 拉起，退出即容器退出（exit 1）。
# 已删除的编排：checkpoint restore（checkpoint restore）、host IPC / host mode 宿主窗口。
exec node /opt/sumeru/shim/src/index.mjs
