#!/usr/bin/env bash
# 手动跑通 noVNC 链路：Xvfb → chrome → x11vnc → websockify（阶段1 验证用）
set -e

pkill -f 'Xvfb :99' 2>/dev/null || true
pkill -f x11vnc 2>/dev/null || true
pkill -f websockify 2>/dev/null || true
sleep 1

Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
sleep 2

DISPLAY=:99 /build/chromium/src/out/release-linux/chrome --no-sandbox --disable-gpu --user-data-dir=/tmp/p about:blank >/tmp/chrome.log 2>&1 &
sleep 6

x11vnc -display :99 -shared -forever -nopw -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
sleep 2

websockify --web=/usr/share/novnc 6901 localhost:5900 >/tmp/ws.log 2>&1 &
sleep 3

echo "=== 进程 ==="
ps aux | grep -E 'Xvfb|x11vnc|websockify|chrome' | grep -v grep | awk '{print $11}' | head -8
echo "=== 端口 ==="
ss -tlnp 2>/dev/null | grep -E ':5900|:6901' | head -4
echo "=== chrome 日志 ==="
head -3 /tmp/chrome.log 2>/dev/null
