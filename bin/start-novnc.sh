#!/usr/bin/env bash
# 手动跑通 noVNC 链路：Xvnc :99 → chrome → websockify（阶段1 验证用）
#
# VNC 认证与生产启动脚本同源（bin/vnc-auth.sh）：
#   SUMERU_VNC_AUTH=none|vnc，口令来自 SUMERU_VNC_PASSWORD(_FILE)。
# X + VNC 合一用 TigerVNC Xvnc：只有它实现了剪贴板（扩展剪贴板 UTF-8），
# x0vncserver 1.12 没有剪贴板。
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=bin/vnc-auth.sh
. "$SCRIPT_DIR/vnc-auth.sh"
sumeru_vnc_prepare || exit 1

pkill -f 'Xvnc :99' 2>/dev/null || true
pkill -f websockify 2>/dev/null || true
sleep 1

rm -f /tmp/.X11-unix/X99 /tmp/.X99-lock
xvnc_args=(:99 -geometry 1280x800 -depth 24 -rfbport 5900 -AlwaysShared -nolisten tcp)
if [ "${SUMERU_VNC_LOCALHOST:-1}" != "0" ]; then
  xvnc_args+=(-localhost)
fi
Xvnc "${xvnc_args[@]}" "${SUMERU_VNC_ARGS[@]}" >/tmp/xvnc.log 2>&1 &
for _ in $(seq 1 60); do
  [ -S /tmp/.X11-unix/X99 ] && break
  sleep 0.25
done
[ -S /tmp/.X11-unix/X99 ] || { echo "[start-novnc] Xvnc :99 socket not ready" >&2; exit 1; }

DISPLAY=:99 /build/chromium/src/out/release-linux/chrome --no-sandbox --disable-gpu --user-data-dir=/tmp/p about:blank >/tmp/chrome.log 2>&1 &
sleep 6

websockify --web=/usr/share/novnc 6901 localhost:5900 >/tmp/ws.log 2>&1 &
sleep 3

echo "=== 进程 ==="
ps aux | grep -E 'Xvnc|websockify|chrome' | grep -v grep | awk '{print $11}' | head -8
echo "=== 端口 ==="
ss -tlnp 2>/dev/null | grep -E ':5900|:6901' | head -4
echo "=== chrome 日志 ==="
head -3 /tmp/chrome.log 2>/dev/null
