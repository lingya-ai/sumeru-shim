# 部署与运维

## 1. 镜像与卷

```bash
# 构建/启动（需要 build/ 内核产物；先 npm run setup）
npm run up
# 等价于
docker compose -f deploy/compose.yaml up -d --build
```

| 项 | 值 |
|---|---|
| 镜像 | `sumeru-runtime:local`（`Dockerfile.runtime`） |
| 端口 | `127.0.0.1:8080`（shim HTTP）、`127.0.0.1:6901`（noVNC） |
| 端口覆盖 | `SUMERU_HTTP_PORT` / `SUMERU_NOVNC_PORT`（compose 插值，默认 8080/6901） |
| 卷 | `sumeru-data` → `/data`（profile、缓存、gateway socket） |
| 资源 | `mem_limit: 3g`、`cpus: 2`、`shm_size: 1gb` |
| 构建镜像源 | `DEBIAN_MIRROR`（compose build arg；国内可设 `mirrors.aliyun.com`） |
| 重启 | `unless-stopped`；chrome 退出 → shim exit 1 → 容器退出 |

生产/验收若用 `docker run`，显式给：

```bash
docker run -d --name sumeru \
  --cpus=2 --memory=3g --memory-swap=3g --pids-limit=512 --shm-size=1g \
  -p 127.0.0.1:8080:8080 -p 127.0.0.1:6901:6901 \
  -v sumeru-data:/data sumeru-runtime:local
```

## 2. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `SUMERU_SCREEN` | `1280x800x24` | Xvnc 分辨率/深度，同时决定 chrome 窗口尺寸（改分辨率需重建容器） |
| `SUMERU_IME` | `fcitx`（compose 默认） | 启动 fcitx5 中文输入法；`off`/空则不起（noVNC 中文需要它）；镜像缺 fcitx5 时 fail-fast |
| `SUMERU_KEEP_LAST_TAB` | `1` | 最后一个标签保护；`0` 关闭（测试用） |
| `SUMERU_API_KEY` | 空 | 唯一共享凭据；设置后 `/gw` 与 `/mcp` 都要 `Authorization: Bearer` 或 `X-Sumeru-Token`；对外暴露时必设 |
| `SUMERU_API_KEY_FILE` | 空 | 从 secret 文件读取同一凭据（优先于 env）；推荐 Docker/K8s secret |
| `SUMERU_MCP_AUTH` | `auto` | `auto`=有 key 就强制 `/mcp`；`required`=强制且无 key 拒绝启动；`off`=只放开 `/mcp`（迁移用） |
| `SUMERU_VNC_AUTH` | `none` | `vnc`=TigerVNC RFB 口令；`none`=无口令（配合 `-localhost` 只允许容器内） |
| `SUMERU_VNC_PASSWORD` | 空 | RFB 口令，**1–8 字节**，推荐恰好 8 位随机字母数字；`vnc` 模式下缺失即启动失败 |
| `SUMERU_VNC_PASSWORD_FILE` | 空 | 从文件读取口令（优先于 env）；读取失败即启动失败 |
| `SUMERU_VNC_LOCALHOST` | `1` | `1`=5900 只绑容器内回环；`0`=允许外部直连（须同时开认证） |
| `SUMERU_GATEWAY_TOKEN` | 启动时随机 | shim/chrome 内部 UDS token；`start-all.sh` 生成，不对外 |
| `SUMERU_GATEWAY_SOCKET` | `/data/sumeru-gateway.sock` | UDS 路径 |
| `SUMERU_GATEWAY_TIMEOUT_MS` | `15000` | shim 侧 gateway 请求超时 |
| `SUMERU_CLEAR_PROFILE_LOCK` | `1` | 启动前清理 Chrome `Singleton*` 锁 |
| `SUMERU_SHUTDOWN_FLUSH_MS` | `15000` | SIGTERM 后等待 chrome 落盘 |
| `SUMERU_RESTORE_SESSION` | `1` | `--restore-last-session` |
| `SUMERU_NO_SANDBOX` | `1` | 开发默认 `--no-sandbox`；生产可设 `0` 用 SUID sandbox |
| `SUMERU_CHROME_EXTRA_ARGS` | 空 | 追加 chrome 参数（空格分隔） |

`SUMERU_GATEWAY_TOKEN` 由 `bin/start-all.sh` 在每次启动时生成（未显式设置时），
不需要也不应该写进 compose。

凭据生命周期（详见 [auth.md](auth.md)）：`SUMERU_API_KEY` 与 VNC 口令只在启动时读入
内存（API key 只保留 `sha256` digest），不写盘、不进日志、不落 `/data`；chrome 与
Xvnc/websockify 的进程环境里也没有它们。但容器配置的 env 本身对同 uid 进程
（含 `docker exec`）可见，要收窄就用 `_FILE` + secret。改配置后要让容器真正用上新值——
secret 文件改内容后 `docker restart` 即可重读，**env 改动必须重建容器**
（`docker compose up -d`），`docker restart` 不会带上新 env。

## 3. 健康检查

```bash
curl -fsS http://127.0.0.1:8080/healthz | jq
```

八层：

| 层 | 判据 |
|---|---|
| x / synth | `/tmp/.X11-unix/X99` 存在 |
| webui | websockify/noVNC 端口在听 |
| gateway | UDS socket 文件存在 |
| kernel | shim 与 gateway 连接存活 |
| window | X 可用且 shim 过了就绪探针 |
| vnc | VNC 服务端端口在听 |
| ime | 未配置 → true + `ime:not-configured`；配置 fcitx 由启动脚本 fail-fast |

`ready=true` 只表示 shim 启动步骤完成，不代表八层全绿；看 `layers`。
顶层另有 `auth`（`gw`/`mcp` 各报 `token` 或 `open`）与 `notes`（如 `ime:not-configured`）。

## 4. 日志

```bash
npm run logs
# 或
docker logs -f sumeru
```

本地脚本、构建和诊断命令产生的日志**文件**统一写到仓库根的 `logs/`（git
忽略，见 `AGENTS.md`「Logs」），例如
`mkdir -p logs && npm run smoke > logs/smoke.log 2>&1`；不要写到仓库根。

关键行：

- `[SUMERU-GW] started on IO thread` — gateway 起来了。
- `[SUMERU-GW] send: {...}` — 每个响应（含 `value`）。
- `[SUMERU-WIN]` — 窗口/启动日志。
- `[shim] chrome exited code=... signal=...` — chrome 退出，容器随后退出。

## 5. noVNC

<http://127.0.0.1:6901/vnc.html>

- 看到的是**原生 Chromium 窗口**（标签条/地址栏/菜单都在）。
- 人类可以直接点、输入；agent 与人类共用同一浏览器。
- 无门控、无仲裁：冲突由使用者自行判断。
- 开了 `SUMERU_VNC_AUTH=vnc` 后，连接时 noVNC 会弹密码框；口令来自部署配置
  （`SUMERU_VNC_PASSWORD` 或 `SUMERU_VNC_PASSWORD_FILE`），容器内没有可事后取回的副本。
- **中文输入**：容器默认启动 fcitx5（`SUMERU_IME=fcitx`），中文由**远端**输入法上屏。
  在 noVNC 里请先把**本地输入法关掉**，直接打拼音（如 `nihao`），再用空格/数字选候选。
  用本地输入法组合出的中文不会被 noVNC 正确转成按键——它会以 Unicode keysym 发过去，
  没有远端输入法时表现为一串 `?`。
- 复制粘贴：noVNC 剪贴板面板发送文本，远端 `Ctrl+V` 粘贴；服务端是 TigerVNC Xvnc，
  支持 Extended Clipboard，中文按 UTF-8 往返（旧 x11vnc 镜像会变成 `?`）。
- 输入法开箱即用：新数据卷会写 `fcitx5/config` 的 `ActiveByDefault=True`，旧卷由启动脚本的
  `fcitx5-remote -o` 兜底激活；Ctrl+Space 仍可手动切换。
- 确认输入法状态：`docker exec sumeru ps -ef | grep fcitx5`；
  `docker exec sumeru sh -c 'DBUS=$(tr "\0" "\n" < /proc/1/environ | grep ^DBUS_SESSION_BUS_ADDRESS= | cut -d= -f2-); DBUS_SESSION_BUS_ADDRESS="$DBUS" DISPLAY=:99 fcitx5-remote'`
  返回 `2` 表示输入法处于激活态。
- 默认 `SUMERU_VNC_LOCALHOST=1`：Xvnc 带 `-localhost`，5900 只在容器内可用。
  需要原生 VNC 客户端时设 `SUMERU_VNC_LOCALHOST=0` **并**开启认证。
- 对公网必须加 TLS 终止（noVNC ↔ websockify 是明文 WS）。
- `/healthz` 的 `auth` 字段可以直接看当前姿态：
  `{"auth":{"gw":"token","mcp":"token","mcpMode":"auto"}}`。

## 6. 升级与回滚

升级：

1. 换镜像/内核 artifact（更新 `build-info.json` 的 commit/SHA）。
2. 用同一个 `/data` 卷启动；Chromium 会迁移旧 profile。
3. `npm run smoke` + `npm run acceptance`。

回滚：

- 镜像：回到上一 tag（保留 `上一个 tag` 等）。
- 内核：`build/chrome` 换回旧 SHA；`npm run setup -- --from <旧包>`。
- profile：旧版本可能已迁移；回滚前备份 `sumeru-data` 卷。

## 7. 持久化与清理

- `/data/profile`：站点数据、cookie、标签/历史；重启容器自然恢复。
- 持久 cookie 约 30 s 提交窗口；硬杀可能丢最后 30 s。
- 重置：`docker compose down -v`（删除卷）或删除 `sumeru-data`。
- `/data/hot/cache`：磁盘缓存，可清。

## 8. 资源与故障

- 推荐 2c3g；最低 1c2g 可跑但 5 标签会贴内存上限。
- `--shm-size=1g` 必须；默认 64 MB 会让 renderer 崩。
- OOM 是 `SIGKILL`，不会走优雅关停；留内存余量。
- 详见 [troubleshooting.md](troubleshooting.md)。
