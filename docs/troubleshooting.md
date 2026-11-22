# 排障

## 1. 先看 `/healthz`

```bash
curl -fsS http://127.0.0.1:8080/healthz | jq
```

| 现象 | 层 | 先查 |
|---|---|---|
| `ready=false` | — | `docker logs`；shim 是否还活着 |
| `layers.x=false` | x | Xvnc 是否起来；`/tmp/.X11-unix/X99`、`/tmp/xvnc.log` |
| `layers.gateway=false` | gateway | UDS 文件是否存在；chrome 是否创建了 gateway |
| `layers.kernel=false` | kernel | shim 与 gateway 连接；`ping` 是否通 |
| `layers.webui/vnc=false` | webui/vnc | websockify/Xvnc 进程与端口 |
| `layers.window=false` | window | shim 就绪探针是否过；X 是否可用 |
| `layers.ime=false` | ime | `SUMERU_IME` 与 fcitx5 二进制 |

## 2. 常见错误码

| 错误 | 含义 | 处理 |
|---|---|---|
| `GATEWAY_TIMEOUT` | shim 15 s 内没等到 gateway 响应 | 看内核日志；是否在途求值卡住；必要时重启容器 |
| `SUMERU_TASK_SPACE_NOT_FOUND` | targetId 不存在/已关闭 | `listTabs` 重新取 |
| `SUMERU_LAST_TAB_PROTECTED` | 试图关最后一个标签 | 用 `navigateTarget` 换页；测试可设 `SUMERU_KEEP_LAST_TAB=0` |
| `SUMERU_CLOSE_TAB_REFUSED` | 未知 target | 重新 `listTabs` |
| `GW_EVAL_ERROR` | CDP 执行错误 | 看表达式；页面是否已销毁 |
| `SUMERU_OPERATION_FAILED` | 表达式抛异常/agent 关闭 | 看 `message`；重试 |
| `GW_UNKNOWN_METHOD` | 方法不存在 | 只用 12 个方法 |
| `gw_error: gateway closed` | UDS 连接被替换/关闭 | gateway 单客户端；别绕过 shim 直连 |
| `HTTP 401 SUMERU_UNAUTHORIZED`（`/gw`） | 设置了 `SUMERU_API_KEY` 但没带凭据 | 带 `Authorization: Bearer <key>` 或 `X-Sumeru-Token: <key>` |
| `HTTP 401` + `WWW-Authenticate: Bearer`（`/mcp`） | 同上；MCP 的认证失败是传输层 401，不是 JSON-RPC error | 同上；客户端配置里加 `headers: {"Authorization": "Bearer ..."}` |
| `/mcp` 仍 200 但你期望它要凭据 | 没设 `SUMERU_API_KEY`，或设了 `SUMERU_MCP_AUTH=off` | 设 key；`/healthz.auth.mcp` 会显示 `open/token` |
| 改了 key 但旧 key 还能用 | 容器没真正用上新配置（`docker restart` 不会带上新 env） | 重建容器；`/healthz.auth` 只报姿态，不报 key 指纹 |

## 3. 已知崩溃：关标签 + 在途求值会 abort

**症状**：关闭一个还有 `evaluateTarget` 在途的标签，容器退出；日志：

```text
FATAL:net/socket/socket_posix.cc:355] DCHECK failed: thread_checker_.CalledOnValidThread().
Received signal 6
[shim] chrome exited code=null signal=SIGABRT
```

**根因**：UI 线程的 `SumeruGateway::AgentHostClosed` 直接 `Send()` 到 IO 线程创建的 socket。

**状态**：已在 build-volume `87e334d` / artifact `…-87e334d-…` / 镜像
`sumeru-runtime:local` 修复；旧镜像 `旧镜像` 仍含该 bug。若仍看到，先确认镜像内
`sha256sum /opt/sumeru/chrome` 是否为 `ec2dc83e…`。

旧镜像/workaround：

- 不要“发一个长求值然后立刻关标签”；
- 关标签前先等求值返回或超时；
- 出事后容器会被编排器重启；`/data` 卷可恢复标签/历史。

回归脚本：`scripts/acceptance/linux/m-series/m09-close-pending-eval.mjs`。

## 4. `evaluateTarget` 语义坑

| 坑 | 说明 |
|---|---|
| 不 await Promise | `new Promise(...)` 立即返回 `{}`；异步内容用轮询 |
| 只操作主帧 | iframe 里的 document 不能作为 target |
| 不可 JSON 化的值 | DOM 节点/函数返回 `{}`；`undefined` 返回 `{type:"undefined"}` |
| 表达式异常 | 整条命令失败（`SUMERU_OPERATION_FAILED`），不会返回 `undefined` |
| 后台标签节流 | 非活动标签的 timer 可能被节流；需要时先 `activateTab` |

## 5. 标签/窗口

- **最后一个标签关不掉**：产品设计；人类 Ctrl+W / 关闭按钮同样被拒。
- **单窗口**：`window.open` / Ctrl+N 的顶层窗口无 WM 管理。
- **标签恢复**：`--restore-last-session` + `/data` 卷；重启后标签/历史/cookie 恢复。
- **profile 锁**：容器重建换主机名 → Chrome exit 21；shim 启动前清 `Singleton*`。
  可用 `SUMERU_CLEAR_PROFILE_LOCK=0` 关闭清理（不推荐）。

## 6. 截图/noVNC

| 现象 | 处理 |
|---|---|
| noVNC 空白 | 看 `webui/vnc` 层；websockify 是否监听 6901；`/tmp/xvnc.log` |
| noVNC 里打拼音没有候选框/中文上不了屏 | 远端输入法没起（`SUMERU_IME` 不是 `fcitx`），或起来了但 **inactive**；见下一行 |
| 在 noVNC 里输入中文变成 `?` | 用了**本地**输入法：noVNC 会把组合结果当 Unicode keysym 发过去，没有远端输入法时就是 `?`；关掉本地输入法、直接打拼音 |
| 输入法进程在但没候选窗 | fcitx5 启动默认 inactive：`fcitx5-remote` 返回 `1`；`~/.config/fcitx5/config` 里没有 `[Behavior] ActiveByDefault=True`（删掉该文件重启会重建），或手动补一刀：`docker exec sumeru sh -c "DBUS=$(tr \"\\0\" \"\\n\" < /proc/$(pgrep -x fcitx5 \| head -1)/environ \| sed -n \"s/^DBUS_SESSION_BUS_ADDRESS=//p\"); DBUS_SESSION_BUS_ADDRESS=\"$DBUS\" DISPLAY=:99 fcitx5-remote -o"`；Ctrl+Space 也能切换 |
| 复制粘贴中文变成 `?` | 服务端不支持 Extended Clipboard（旧镜像用的 x11vnc）。2.2+ 已换 TigerVNC Xvnc；重建容器后重试 |
| `SUMERU_IME=fcitx` 但容器反复重启 | 镜像里没有 fcitx5 二进制（fail-fast）；换官方镜像，或设 `SUMERU_IME=off` |
| noVNC 连接时弹密码框 | 开了 `SUMERU_VNC_AUTH=vnc`；口令来自部署配置（`SUMERU_VNC_PASSWORD` / `_FILE`），容器内没有可取回的明文副本 |
| noVNC 提示认证失败 | 口令不对，或口令不是 8 字节（RFB 只认前 8 字节）；看 `docker top sumeru \| grep Xvnc` 是否带 `-PasswordFile` |
| 容器反复重启，日志 `[vnc-auth] fail-fast` | `SUMERU_VNC_AUTH=vnc` 但口令缺失/不可读/超过 8 字节；按日志提示修配置 |
| 宿主连 `127.0.0.1:5900` 拒绝 | 默认 `-localhost`（`SUMERU_VNC_LOCALHOST=1`），5900 只在容器内可用；要原生 VNC 客户端设 `SUMERU_VNC_LOCALHOST=0` 并开认证 |
| 截图很小/黑 | 页面未出帧；等 `load` 后重试；非活动标签会先激活 |
| 截图不含标签条 | 设计如此：只截页面，不含浏览器 chrome |
| noVNC 能看不能点 | 检查 X 输入与 `/tmp/xvnc.log` |

## 7. 资源/OOM

- 推荐 2c3g；`--memory-swap` 显式等于 `--memory`（禁 swap）。
- `--shm-size=1g` 必须；默认 64 MB 会让 renderer 崩。
- OOM 是 `SIGKILL`，不走优雅关停，可能丢最后 30 s cookie。
- 看占用：`docker stats --no-stream sumeru`。

## 8. 收集诊断

本地产生的日志文件统一写到仓库根的 `logs/`（git 忽略，见 `AGENTS.md`「Logs」），
不要写到仓库根。

```bash
mkdir -p logs
docker logs --tail 200 sumeru > logs/sumeru.log
curl -fsS http://127.0.0.1:8080/healthz > healthz.json
node bin/sumeru.mjs tabs
node bin/sumeru.mjs eval active "document.title"
```

内核崩溃时日志只有地址（strip 后无符号）；用 `build-info.json` 的 commit 对应源码，
配合符号包 `addr2line`。
