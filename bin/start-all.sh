#!/usr/bin/env bash
# 须弥启动编排（gateway-only）：
#   VNC 认证引导 → Xvnc :99（X + VNC 合一）→ websockify/noVNC 网页(:6901)
#   shim（node src/index.mjs）→ spawn chrome（原生窗口）→ gateway UDS → HTTP(:8080)
# 人类：noVNC 观看 + 直接操作（无门控、无仲裁；认证见 SUMERU_VNC_AUTH）
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=bin/vnc-auth.sh
. "$SCRIPT_DIR/vnc-auth.sh"

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

# VNC 认证 fail-fast：口令只来自配置（_FILE → env），缺失/超长直接拒绝启动；
# 口令文件派生到 tmpfs 且每次启动先删再建（docker restart 会保留容器可写层）。
sumeru_vnc_prepare || exit 1

# 凭据只给 shim（node）：先把它们从当前 shell 环境摘掉，之后启动的 Xvnc /
# websockify / fcitx / dbus 都不会继承。derived 口令文件已经写好，不需要 env。
# 注意：这只缩小扩散面；容器自身配置的 env 仍会出现在 /proc/1/environ 与 `docker exec`
# 里——要真正隔离，用 SUMERU_API_KEY_FILE / SUMERU_VNC_PASSWORD_FILE + secret 挂载。
saved_api_key="${SUMERU_API_KEY:-}"
saved_api_key_file="${SUMERU_API_KEY_FILE:-}"
unset SUMERU_API_KEY SUMERU_API_KEY_FILE SUMERU_VNC_PASSWORD SUMERU_VNC_PASSWORD_FILE

# 1) 虚拟显示 + VNC 服务（TigerVNC Xvnc：同一个进程既是 X server 又是 VNC server）。
# 为什么不是 Xvfb + x11vnc/x0vncserver：TigerVNC 1.12 的剪贴板实现只在 Xvnc 里
# （unix/xserver/hw/vnc/vncSelection.c），x0vncserver 完全没有剪贴板；没有它，noVNC
# 只能走 ISO-8859-1 回退，中文粘贴会变成 "?"。
# docker restart 会保留 /tmp：上一轮残留的 X99 socket 会让 chrome 抢在 X 就绪前启动
# 而退出（F8，2026-11-16 E2E 复现）。启动前先清掉残留，再等 socket 真正出现。
rm -f /tmp/.X11-unix/X99 /tmp/.X99-lock
# 分辨率（SUMERU_SCREEN=WxH[xD]）——**唯一来源**，默认 1280x800x24（产品既定几何）。
# 这里 export 出去，shim 会把 chrome 窗口尺寸自动对齐到同一块屏幕
# （见 src/runtime.mjs windowSize），所以两处不会漂移。
# 想换 1K 就 `-e SUMERU_SCREEN=1920x1080x24`（改分辨率必须重建容器）。
export SUMERU_SCREEN="${SUMERU_SCREEN:-1280x800x24}"
screen_w=1280
screen_h=800
screen_depth=24
if [[ "$SUMERU_SCREEN" =~ ^([0-9]+)x([0-9]+)(x([0-9]+))?$ ]]; then
  screen_w="${BASH_REMATCH[1]}"
  screen_h="${BASH_REMATCH[2]}"
  screen_depth="${BASH_REMATCH[4]:-24}"
fi

# 认证参数来自 sumeru_vnc_prepare：-PasswordFile <tmpfs 口令文件> -SecurityTypes VncAuth，
# 或未启用时的 -SecurityTypes None。
# 默认 -localhost：5900 只绑容器内回环，即使 publish 5900 也连不上；
# 原生 VNC 客户端需要时用 SUMERU_VNC_LOCALHOST=0 显式放行（同时必须开认证）。
xvnc_args=(:99 -geometry "${screen_w}x${screen_h}" -depth "$screen_depth" -rfbport 5900 -AlwaysShared -nolisten tcp)
if [ "${SUMERU_VNC_LOCALHOST:-1}" != "0" ]; then
  xvnc_args+=(-localhost)
fi
Xvnc "${xvnc_args[@]}" "${SUMERU_VNC_ARGS[@]}" >/tmp/xvnc.log 2>&1 &
for _ in $(seq 1 60); do
  [ -S /tmp/.X11-unix/X99 ] && break
  sleep 0.25
done
[ -S /tmp/.X11-unix/X99 ] || { echo "[start-all] Xvnc :99 socket not ready" >&2; exit 1; }

# 2) VNC → WebSocket（网页 noVNC 通过它连 VNC）
websockify --web=/usr/share/novnc 6901 localhost:5900 >/tmp/ws.log 2>&1 &

# 3) shim（spawn chrome + HTTP 8080）；DISPLAY 让 chrome 用虚拟显示（原生窗口）
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
  # 中文输入开箱可用：fcitx5 默认是 inactive（要 Ctrl+Space 才激活、否则没有候选窗）。
  # 新配置直接写 ActiveByDefault=True；已有配置不动（旧卷用下面的 -o 兜底）。
  if [ ! -f "${fcitx5_config}/config" ]; then
    printf '[Behavior]\nActiveByDefault=True\n' > "${fcitx5_config}/config"
  fi
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
  # fcitx5 起来后默认是 **inactive**（fcitx5-remote 返回 1）：必须显式激活，否则打字
  # 只是英文、没有候选窗——"输入法不见了"。注意 `fcitx5-remote -o` 在守护进程还没
  # 就绪时也会返回 0，所以按**输出状态**判断：先等它回答（1/2），再激活并确认 2。
  for _ in $(seq 1 40); do
    state="$(fcitx5-remote 2>/dev/null || true)"
    if [ "$state" = "1" ] || [ "$state" = "2" ]; then
      fcitx5-remote -o >/dev/null 2>&1 || true
      [ "$(fcitx5-remote 2>/dev/null || true)" = "2" ] && break
    fi
    sleep 0.25
  done
  fcitx5-remote >/dev/null 2>&1 || true
  echo "[start-all] fcitx5 state=$(fcitx5-remote 2>/dev/null || echo unknown)" >&2
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
if [ -n "$saved_api_key" ]; then
  export SUMERU_API_KEY="$saved_api_key"
fi
if [ -n "$saved_api_key_file" ]; then
  export SUMERU_API_KEY_FILE="$saved_api_key_file"
fi
exec node /opt/sumeru/shim/src/index.mjs
