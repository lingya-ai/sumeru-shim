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
| `SUMERU_SCREEN` | `1280x800x24` | Xvfb 分辨率，同时决定 chrome 窗口尺寸 |
| `SUMERU_IME` | 空 | `fcitx` 启用中文输入；镜像缺 fcitx5 时 fail-fast |
| `SUMERU_KEEP_LAST_TAB` | `1` | 最后一个标签保护；`0` 关闭（测试用） |
| `SUMERU_API_KEY` | 空 | 设置后 `/gw` 要求 `X-Sumeru-Token`；对外暴露时必设 |
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
| vnc | x11vnc 端口在听 |
| ime | 未配置 → true + `ime:not-configured`；配置 fcitx 由启动脚本 fail-fast |

`ready=true` 只表示 shim 启动步骤完成，不代表八层全绿；看 `layers`。

## 4. 日志

```bash
npm run logs
# 或
docker logs -f sumeru
```

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
