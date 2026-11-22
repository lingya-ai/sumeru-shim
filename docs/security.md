# 安全模型

## 1. 适用范围

当前形态是**单用户、单容器、单浏览器**的运行时。它不是一个多租户隔离系统；
不要在同一容器里给互不信任的用户/agent 共享一个浏览器 profile。

## 2. `evaluateTarget` = 任意代码执行

`evaluateTarget` 在目标标签的**主世界**执行任意 JS，拥有该页面源的权限：

- 可读/写 DOM、cookie、localStorage；
- 可发同源请求、读页面内存中的 token；
- 可修改页面行为（对被测站点来说与用户脚本无异）。

这是 agent 能力的来源，也是最大的攻击面。调用方必须被信任；不要把 `/gw` 暴露给
不受信任的网络。

## 3. HTTP 鉴权（`/gw` + `/mcp`）

设计细节与测试矩阵见 [auth.md](auth.md)。

| 变量 | 默认 | 作用 |
|---|---|---|
| `SUMERU_API_KEY` | 空 | 唯一共享凭据（**单值**；含空白/逗号视为配置错误） |
| `SUMERU_API_KEY_FILE` | 空 | 从 secret 文件读取，优先于 env |
| `SUMERU_MCP_AUTH` | `auto` | `auto`=有 key 就强制 MCP；`required`=永远强制，无 key 拒绝启动；`off`=只放开 `/mcp` |

- **空 key = 两个面都开放**：只允许绑回环/内网，这是部署约束而不是授权模型。
- **有 key**：`/gw` 与 `/mcp` 都要求 `Authorization: Bearer <key>` 或
  `X-Sumeru-Token: <key>`，接受其一即可（后者兼容老客户端与 CLI）。
- 失败是 HTTP `401` + `WWW-Authenticate: Bearer`：MCP 规范要求认证失败发生在传输层，
  不能包成 JSON-RPC error，否则客户端不会触发凭据流程。`/gw` 保留
  `SUMERU_UNAUTHORIZED` 错误体，只额外加挑战头。
- `/healthz` 免认证（容器探针），只多报一个 `auth` 姿态字段，不暴露凭据。
- **凭据只在内存**：启动读入后收敛成 `sha256` digest；不写盘、不进日志、不落 `/data`。
  进程可见性上做了两处收窄：shim 用净化后的 env 启动 chrome（主进程/zygote/renderer 的
  `/proc/<pid>/environ` 里没有 key），`start-all.sh` 在起 Xvnc / websockify 前
  unset 认证变量。但容器自身配置的 env 对同 uid 进程（含 `docker exec`）仍然可见——
  这是单用户容器边界；要更严就用 `SUMERU_API_KEY_FILE` + secret 挂载（§4、§6）。
- 改 key 后重建/重启容器，**当次配置即唯一事实来源**：旧凭据随旧进程消失，没有
  需要清理的陈旧状态。单值意味着轮换没有新旧并存窗口（见 auth.md §5.4）。
- compose 默认只绑 `127.0.0.1:8080`。改成 `0.0.0.0` 或放到反向代理后，
  **必须**设置 API key，并加网络层访问控制。

> 不实现 OAuth / 动态客户端注册：本运行时不是授权服务器，只支持静态 token；
> 只认 OAuth 流程的 MCP 客户端（部分云端连接器）不支持这种接入。

## 4. UDS 与 token

- gateway 只监听容器内 `/data/sumeru-gateway.sock`，权限 `0600`。
- `SUMERU_GATEWAY_TOKEN` 每次启动随机生成（`bin/start-all.sh`），shim/chrome 共享；
  不写入镜像/仓库。它与对外凭据 `SUMERU_API_KEY` 是**两个不同的东西**：gateway token
  不能用来调 `/gw`、`/mcp`，`SUMERU_API_KEY` 也连不上 gateway UDS。
- `SUMERU_GATEWAY_TOKEN` 会留在 chrome 的进程环境里（chrome 需要它）；`SUMERU_API_KEY`
  与 VNC 口令则在 spawn 前被剥离，两者处理不同，改的时候不要合并。
- 同 uid 的容器内进程仍可读 `/proc/<pid>/environ` 或直接连 socket；这是单用户容器
  的边界，不要把它当多租户隔离。
- gateway 单客户端：新连接会顶掉旧连接；诊断时用 `/gw`，不要绕过 shim。

## 5. 传输与网络

- 没有 CDP 监听、没有 `--remote-debugging-*`、没有 WS 回退。
- noVNC（6901）默认无密码，仅绑 `127.0.0.1`。对外提供前必须开启 VNC 认证：
  `SUMERU_VNC_AUTH=vnc` + 8 字节 RFB 口令（`SUMERU_VNC_PASSWORD` 或
  `SUMERU_VNC_PASSWORD_FILE`），并在前面加 TLS 终止——noVNC ↔ websockify 之间是明文 WS。
- Xvnc（TigerVNC，X + VNC 合一）默认带 `-localhost`：5900 只绑容器内回环，即使 `-p 5900:5900` 也连不上。
  `SUMERU_VNC_LOCALHOST=0` 只应在"同时开着认证、且明确知道风险"时使用。
- VNC 口令只来自配置，容器内不保存可事后取回的明文副本；VNC 服务端需要的口令文件
  派生在 tmpfs（`/dev/shm/sumeru-vnc`，0600），每次启动先删再建。
- RFB 口令只有前 8 字节有效：配置超过 8 字节会**启动失败**（不静默截断），
  1–7 字节告警强度不足。
- 页面网络能力与普通 Chromium 相同；不要在其中登录高价值账号后把 `/gw` 暴露出去。

## 6. 秘密与仓库

- 仓库不包含内核源码、构建卷、`build/`、大体积历史资产。
- `npm run scan-secrets` 扫描已跟踪文件中的私钥/token 模式。
- 不要提交 `native/**/*-key.pem`、`*.tar.gz` profile 快照、`.env`、真实 API key。
- 若发现泄漏：轮换密钥 → 从 git 历史移除（filter-repo）→ 重新发布 artifact。

## 7. 漏洞报告

内部项目：直接找维护者，附最小复现（`/healthz`、日志、target、表达式）。
不要在公开 issue 里贴真实 cookie/token/profile。

## 8. 已知未修

- 关闭“有在途求值”的标签会触发 socket 线程 DCHECK → SIGABRT（本版已修复）。
  在修复前，把运行时视为“可被单次操作打崩”；编排器应自动拉起新容器。
