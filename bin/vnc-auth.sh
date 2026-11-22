#!/usr/bin/env bash
# VNC 认证引导（被 start-all.sh / start-novnc.sh source）。
#
# 契约见 docs/auth.md §6：
#   SUMERU_VNC_AUTH=none|vnc（默认 none）
#   SUMERU_VNC_PASSWORD_FILE → SUMERU_VNC_PASSWORD（文件优先；都缺且模式为 vnc 则 fail-fast）
#   SUMERU_VNC_LOCALHOST=0 放行非回环（默认 1 = 加 -localhost）
#
# 口令只来自配置：不生成、不落到 /data、不打印。Xvnc（TigerVNC）只接受口令文件，
# 因此派生一个易失文件到 tmpfs（不可写退化 /tmp），每次启动先删再建。
# `vncpasswd -f` 从 stdin 读明文，口令不进 argv。
#
# 成功时导出：
#   SUMERU_VNC_ARGS      VNC 服务端的认证参数数组（-SecurityTypes None 或
#                        -PasswordFile <file> -SecurityTypes VncAuth）
#   SUMERU_VNC_PASSFILE  派生口令文件路径（none 模式下为空）

sumeru_vnc_auth_mode() {
  local mode="${SUMERU_VNC_AUTH:-none}"
  case "$mode" in
    none | vnc) printf '%s' "$mode" ;;
    *)
      echo "[vnc-auth] fail-fast: SUMERU_VNC_AUTH=$mode 无效（只支持 none / vnc）" >&2
      return 1
      ;;
  esac
}

sumeru_vnc_read_password() {
  local value
  if [ -n "${SUMERU_VNC_PASSWORD_FILE:-}" ]; then
    if [ ! -r "${SUMERU_VNC_PASSWORD_FILE}" ]; then
      echo "[vnc-auth] fail-fast: SUMERU_VNC_PASSWORD_FILE=${SUMERU_VNC_PASSWORD_FILE} 不可读" >&2
      return 1
    fi
    # 命令替换会去掉行尾换行：文本编辑器写的 secret 文件不需要手工 trim。
    value="$(cat -- "${SUMERU_VNC_PASSWORD_FILE}")" || return 1
  elif [ -n "${SUMERU_VNC_PASSWORD:-}" ]; then
    value="${SUMERU_VNC_PASSWORD}"
  else
    echo "[vnc-auth] fail-fast: SUMERU_VNC_AUTH=vnc 但未提供 SUMERU_VNC_PASSWORD / SUMERU_VNC_PASSWORD_FILE" >&2
    return 1
  fi
  printf '%s' "$value"
}

# 解析口令 → 派生 TigerVNC 口令文件 → 设置 SUMERU_VNC_ARGS / SUMERU_VNC_PASSFILE。
sumeru_vnc_prepare() {
  local mode pw bytes base dir
  mode="$(sumeru_vnc_auth_mode)" || return 1

  SUMERU_VNC_ARGS=()
  SUMERU_VNC_PASSFILE=""

  # 上次启动可能留下派生口令文件（docker restart 会保留容器可写层与 tmpfs 内容，
  # 而且可能换了挂载点）。先无条件清两个候选位置：当次配置是唯一事实来源，
  # 关掉认证之后也不该在容器里留下旧口令文件。
  rm -rf /dev/shm/sumeru-vnc /tmp/sumeru-vnc 2>/dev/null || true

  if [ "$mode" = "none" ]; then
    SUMERU_VNC_ARGS=(-SecurityTypes None)
    echo "[vnc-auth] VNC 未鉴权（SUMERU_VNC_AUTH=none）；只应绑回环/内网" >&2
    if [ "${SUMERU_VNC_LOCALHOST:-1}" = "0" ]; then
      echo "[vnc-auth] warning: VNC 既无认证又允许非回环连接（SUMERU_VNC_LOCALHOST=0）" >&2
    fi
    return 0
  fi

  pw="$(sumeru_vnc_read_password)" || return 1
  if [ -z "$pw" ]; then
    echo "[vnc-auth] fail-fast: VNC 口令为空" >&2
    return 1
  fi
  case "$pw" in
    -*)
      echo "[vnc-auth] fail-fast: VNC 口令不能以 - 开头" >&2
      return 1
      ;;
    *$'\n'*)
      echo "[vnc-auth] fail-fast: VNC 口令不能包含换行" >&2
      return 1
      ;;
  esac

  # RFB 认证是 DES + 8 字节口令：按字节计数，超长直接失败而不是静默截断。
  bytes="$(printf '%s' "$pw" | wc -c)"
  if [ "$bytes" -gt 8 ]; then
    echo "[vnc-auth] fail-fast: VNC 口令 ${bytes} 字节，RFB 只认前 8 字节；请改成恰好 8 位（ASCII）" >&2
    return 1
  fi
  if [ "$bytes" -lt 8 ]; then
    echo "[vnc-auth] warning: VNC 口令只有 ${bytes} 字节，强度不足；建议 8 位随机字母数字" >&2
  fi

  # 优先 tmpfs：口令文件不该留在容器可写层（docker restart 会保留它）。
  base="/dev/shm"
  { [ -d /dev/shm ] && [ -w /dev/shm ]; } || base="/tmp"
  dir="$base/sumeru-vnc"
  if ! (umask 077 && mkdir -p "$dir"); then
    echo "[vnc-auth] fail-fast: 无法创建口令目录 $dir" >&2
    return 1
  fi
  chmod 700 "$dir" 2>/dev/null || true

  SUMERU_VNC_PASSFILE="$dir/vnc.passwd"
  # `vncpasswd -f` 从 stdin 读明文、把混淆后的 8 字节写到 stdout：口令不进 argv。
  if ! (umask 077 && printf '%s' "$pw" | vncpasswd -f > "$SUMERU_VNC_PASSFILE" 2>/tmp/vncpasswd.log); then
    echo "[vnc-auth] fail-fast: vncpasswd -f 失败（见 /tmp/vncpasswd.log）" >&2
    return 1
  fi
  if [ ! -s "$SUMERU_VNC_PASSFILE" ]; then
    echo "[vnc-auth] fail-fast: 口令文件未生成：$SUMERU_VNC_PASSFILE" >&2
    return 1
  fi
  chmod 600 "$SUMERU_VNC_PASSFILE" 2>/dev/null || true

  SUMERU_VNC_ARGS=(-PasswordFile "$SUMERU_VNC_PASSFILE" -SecurityTypes VncAuth)
  echo "[vnc-auth] VNC RFB 认证已启用（passwd 文件 $SUMERU_VNC_PASSFILE，权限 600）" >&2
}
