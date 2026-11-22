# MCP 与 VNC 认证设计（v2.2）

> **状态**：2.2.0 已实现（`src/auth.mjs`、`src/runtime.mjs`、`bin/vnc-auth.sh`）。
> 本文档是实现契约：改行为前先改这里，再改代码与测试。

## 1. 问题（2.2 之前）

2.2 之前两个对外面没有认证：

| 面 | 现状 | 风险 |
|---|---|---|
| `POST /mcp` | 完全不鉴权（`src/runtime.mjs` 明确注释 "intentionally unauthenticated"） | 等价于远程浏览器控制面：任意读页面/点按钮/截图 |
| noVNC（5900 → 6901） | 无口令（`x11vnc -nopw`）+ 无 Basic | 任何人打开网页即可看到并操作浏览器（含已登录站点） |

`/gw` 已有 `SUMERU_API_KEY` + `X-Sumeru-Token`，但 `/mcp` 是 2.1 新增面，没有复用。

安全边界目前只靠 `deploy/compose.yaml` 绑 `127.0.0.1`，属于部署约束而不是授权模型。
一旦需要公网/内网跨机访问，就没有可配置的认证手段。

## 2. 目标与非目标

**目标**

1. `/mcp` 支持可配置认证，按 MCP 规范在 HTTP 传输层拒绝，返回 `401` +
   `WWW-Authenticate`，让客户端能识别并重试。
2. VNC 支持可配置认证，且**直连 5900 也不能绕过**。
3. 默认与现状兼容：不配置即行为不变（只多一条启动告警）。
4. 凭据不落日志、不出现在 HTTP 响应里，校验使用常量时间比较。

**非目标**

- OAuth 2.1 / 动态客户端注册 / RFC 9728 资源元数据：本运行时不是授权服务器，
  只支持**静态共享 token**。只有 OAuth 流程的客户端（部分云端连接器）不支持。
- 多租户、按工具粒度授权、token 过期时间（TTL）。
- VNC over TLS（交给反向代理）、websockify Basic（见 §8）。
- 修改 12 个 gateway 方法或 MCP 工具 schema。

## 3. 决策记录

| 决策 | 结论 | 理由 |
|---|---|---|
| 设了 `SUMERU_API_KEY` 后 `/mcp` 是否默认强制 | **是**（`SUMERU_MCP_AUTH=auto`） | 已设 key 说明部署已经跨机/对外，MCP 与 `/gw` 同级敏感；留 `off` 作退路 |
| `SUMERU_API_KEY` 取值 | **单值**，不做逗号多值 | 配置即事实：一个 key 一个口令，避免"到底哪个 key 生效"的歧义；轮换靠重启切换（§5.4） |
| 凭据生命周期 | **只在内存**，每次启动按当次配置重建，不落盘 | 重启即切换、无陈旧状态；不存在"旧密钥残留"或需要清理的迁移步骤 |
| VNC 认证形态 | **TigerVNC RFB 密码**，默认 `none` | RFB 是唯一不可绕过的层；默认关闭避免破坏现有 noVNC 开箱体验。服务端从 x11vnc 换成 TigerVNC 是为了 Unicode 剪贴板（§6.1） |
| VNC 口令来源 | **只来自配置**（env 或 `_FILE`），不自动生成、不在 `/data` 落明文 | 口令必须可预期、可审计；缺失即启动失败，不猜、不生成 |
| 是否加 `-localhost` | **默认加**，可用 `SUMERU_VNC_LOCALHOST=0` 关闭 | 让 5900 在容器网络内即不可从外部访问；原生 VNC 客户端用户可显式放行 |

## 4. 配置总表

**凭据生命周期（两条面共用，硬约束）**

- 凭据只在**进程内存**中存在：启动时从 env / secret 文件读入，派生 `sha256` digest 后
  只在内存持有；**不写入磁盘、不落 `/data` 卷、不产生任何认证状态文件**。
- 每次启动重新加载。改了配置并让容器真正用上新配置之后（env 需重建容器，secret
  文件可 `restart` 重读），**当次配置即唯一事实来源**：新凭据立即生效，旧凭据随旧进程
  一起消失；不存在"重启后沿用旧密钥"的路径（没有缓存文件、没有会话表、没有需要清理的
  陈旧状态）。
- 容器内没有任何可用于"事后找回 API key"的副本；唯一副本在部署侧（env / secret 挂载）。
- **进程可见性（诚实边界）**：容器配置里的 env 对容器内进程天然可见（`/proc/1/environ`、
  `docker exec` 都能读到），`unsetenv` 也不会改写 exec 时的初始环境块。所以"不落盘"
  不等于"容器内绝对读不到"：
  - **不给 chrome**：shim spawn 时用 `sanitizeChildEnv` 剥离认证变量，
    主进程/zygote/renderer 的 environ 里没有 key（实测验证）；
  - **不给编排辅助进程**：`start-all.sh` 在起 Xvnc / websockify / fcitx 之前
    unset 认证变量，只在 `exec node` 前把 key 放回；
  - 要收窄到"只有 shim 读得到"，用 `SUMERU_API_KEY_FILE` / `SUMERU_VNC_PASSWORD_FILE`
    + 只读 secret 挂载（文件仍受容器 uid 边界约束，见 security.md §4）。
- 唯一的例外是 VNC：VNC 服务端要求一个口令文件，因此会派生一个**易失**文件（§6.2），
  它放在 tmpfs 上、每次启动先删再建，同样不构成跨重启的认证状态。

### 4.1 HTTP（`/gw` + `/mcp`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SUMERU_API_KEY` | 空 | 唯一共享凭据，**整串即一个 token**（不按逗号切分）；含空白或逗号视为配置错误（复制粘贴多行/逗号串是最常见的误配）；建议 ≥ 32 字符随机值，短于 16 字符启动告警 |
| `SUMERU_API_KEY_FILE` | 空 | 从文件读取**同一个** token（Docker/K8s secret）；与 env 同时存在时**文件优先**并告警；读取失败 → 启动失败 |
| `SUMERU_MCP_AUTH` | `auto` | `auto`=有 key 就强制；`required`=永远强制，无 key 启动失败；`off`=显式关闭并告警 |

`/gw` 不新增独立开关：沿用"有 key 就校验"，避免两面行为漂移。

`*_FILE` 读取后**只去掉行尾换行**（`\r?\n`），其余空白一律不清理：行尾换行是文本编辑器
的默认产物，不该把合法 key 判成非法；而中间/尾部空白属于真实配置错误（§4.1），应暴露。

单值意味着**轮换没有新旧并存窗口**（见 §5.4）：改 key 必然有一个短暂 401 期，需要按低峰窗口操作。

### 4.2 VNC

| 变量 | 默认 | 说明 |
|---|---|---|
| `SUMERU_VNC_AUTH` | `none` | `none` / `vnc` |
| `SUMERU_VNC_PASSWORD` | 空 | RFB 口令，**只来自配置**；`vnc` 模式下缺失 → 启动失败；长度 1–8 **字节**（ASCII 下即字符），推荐恰好 8 位随机字母数字 |
| `SUMERU_VNC_PASSWORD_FILE` | 空 | 从文件读取同一口令，优先级高于 `SUMERU_VNC_PASSWORD`；读取失败 → 启动失败 |
| `SUMERU_VNC_LOCALHOST` | `1` | `1`=Xvnc 加 `-localhost`（5900 仅容器内可连）；`0`=允许外部直连 |

### 4.3 兼容矩阵

| `SUMERU_API_KEY` | `SUMERU_MCP_AUTH` | `/gw` | `/mcp` |
|---|---|---|---|
| 未设 | `auto` | 开放 | 开放 + 启动告警 |
| 已设 | `auto`（默认） | 需凭据 | **需凭据（2.1 → 2.2 行为变化）** |
| 已设 | `off` | 需凭据 | 开放 + 告警 |
| 未设 | `required` | 开放 | 启动失败（fail-fast） |

## 5. MCP / HTTP 鉴权协议

### 5.1 认证矩阵

| 表面 | 凭据 | 失败状态 | 挑战头 |
|---|---|---|---|
| `POST /mcp` | `Authorization: Bearer <k>` 或 `X-Sumeru-Token: <k>` | `401` | `WWW-Authenticate: Bearer realm="sumeru"` |
| `POST /gw` | 同上 | `401` | 同上 |
| `GET /healthz` | 无（探针必须免认证） | — | — |

- `Authorization` 优先，`X-Sumeru-Token` 作为 `/gw` 老客户端与 `bin/sumeru.mjs` 兼容回退。
- scheme 大小写不敏感，允许多余空白；header 为数组时取第一个。
- Node 允许重复请求头并把值用逗号合并，因此解析 `Authorization` 时取第一个逗号前的段；
  token 本身不允许含逗号（§4.1），所以不存在歧义。
- 凭据长度上限 512 字节，超长直接判无效（不对巨大输入做哈希）。
- 鉴权在**方法分发之前**：未认证的 `GET /mcp` 返回 `401` 而非 `405`。
- 通知请求（`202` 空体）同样要过鉴权。
- 不支持 CORS：`OPTIONS` 仍 404；浏览器跨域调用 `/mcp` 不是支持拓扑。

### 5.2 401 响应形状

未带凭据（RFC 6750：无凭据时不给 `error` 参数）：

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="sumeru"
content-type: application/json

{"error":"unauthorized","error_description":"missing bearer token"}
```

凭据错误：

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="sumeru", error="invalid_token"
content-type: application/json

{"error":"invalid_token","error_description":"token rejected"}
```

`/gw` 保持既有可解析形状，只额外加挑战头（`SUMERU_UNAUTHORIZED` 不变）：

```json
{"ok":false,"error":{"code":"SUMERU_UNAUTHORIZED","message":"missing or invalid token"}}
```

**不返回** `resource_metadata`：我们不是 OAuth 资源服务器，不引导客户端去发现授权服务器。

### 5.3 客户端配置

```json
{
  "mcpServers": {
    "sumeru": {
      "type": "http",
      "url": "http://127.0.0.1:8080/mcp",
      "headers": { "Authorization": "Bearer <key>" }
    }
  }
}
```

> 多数 MCP 客户端不会展开 `${ENV}`，配置里要填真实值；用 secret 文件时先从文件取。

```bash
curl -s http://127.0.0.1:8080/mcp \
  -H "Authorization: Bearer $SUMERU_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### 5.4 凭据处理

- 内存里只有**一个** `sha256` digest 参与比较；明文只作为启动输入短暂存在，
  读入后从 `process.env` 删除，不复制、不进日志、不进子进程。
- 校验用 `crypto.timingSafeEqual`（比较 digest，长度恒定），不因比较实现分叉而泄漏长度。
- **凭据不进入浏览器进程**：shim spawn chrome 时从子进程 env 中剥离
  `SUMERU_API_KEY(_FILE)?`、`SUMERU_VNC_PASSWORD(_FILE)?` 等认证变量
  （`SUMERU_GATEWAY_TOKEN` 必须保留，chrome 要用它连 gateway）。
  否则渲染进程及其子进程的 `/proc/<pid>/environ` 里都会有控制面凭据。
- 拒绝时打一行 `auth rejected: surface=gw|mcp reason=missing|invalid fingerprint=sha256:…`：
  指纹可用于对配置漂移，但不可反推 token；绝不打印 token / header 原值。
- `*_FILE` 读取失败 → 启动失败（`SUMERU_AUTH_CONFIG`），不静默降级成"无认证"。
- **轮换流程**（单值，没有新旧并存窗口）：
  1. 生成新 key，更新 secret 文件或容器 env；
  2. 让新配置生效——两者机制不同，别搞混：
     - `SUMERU_API_KEY_FILE`：改挂载文件内容即可，`docker restart` 会重新读取；
     - `SUMERU_API_KEY`（env）：**`docker restart` 不会带上新值**（容器 spec 不可变），
       必须重建容器（`docker compose up -d`）；
  3. 立刻更新所有客户端。

  重启到客户端更新之间，旧 key 已失效、新 key 未被使用，会出现短暂 `401`。
  反向操作（先改客户端）同样有窗口。两条路径都无法消除，只能在低峰做，
  并依赖 `401` + `WWW-Authenticate` 让客户端重试/提示重新配置。
  `/healthz` 免认证，编排器探针不受影响，不会因误配导致容器被判定不健康。
- **重启语义**：新进程按当前配置重新加载并重建内存 digest，旧进程的凭据随其退出而
  消失；没有任何落盘状态，所以不存在"清理旧密钥"这一步。注意这说的是"进程重启后不
  再持有旧状态"，不等于"`docker restart` 就能换 env"——env 改动必须重建容器（见上一步），
  否则容器 spec 里仍是旧值。
- 不提供热重载：重启成本低，避免文件监听子系统与"改了文件但没生效"的排查负担。
  也正因为不热重载，"配置 → 内存"是单向、单次的，不会出现两套凭据并存。
- 边界说明："只在内存"指**不落盘、不持久化到卷**，不表示同 uid 进程绝对看不到：
  env 形式的凭据仍可被 `docker exec` 或其他同 uid 进程从容器环境读到（容器内既有边界，
  同 security.md 对 `SUMERU_GATEWAY_TOKEN` 的描述）；`unsetenv` 也不会抹掉
  `/proc/<pid>/environ` 里的初始环境块。可收窄的范围我们都已经做了：chrome 与
  Xvnc/websockify 的 environ 里没有 key（见 §4 的进程可见性）。
  进一步隔离用 `SUMERU_API_KEY_FILE` + compose/K8s secret：文件不进
  `docker inspect` 的 env 列表，权限也可以单独收。

### 5.5 `/healthz` 增量字段

8 层结构不变，只增顶层 `auth`（对外只暴露"开没开"，不暴露凭据）：

```json
{"auth":{"gw":"token","mcp":"token","mcpMode":"auto"}}
```

## 6. VNC 认证与剪贴板（TigerVNC Xvnc）

### 6.1 启动链路

```text
Xvnc :99(-geometry WxH -depth D -localhost -PasswordFile /dev/shm/sumeru-vnc/vnc.passwd -SecurityTypes VncAuth)
     → websockify :6901 → noVNC
```

- 口令由 Xvnc 自己校验，**websockify 与反代都绕不过**。
- `-localhost` 让 5900 只绑容器内 `127.0.0.1`：即使有人 `-p 5900:5900` 也连不上。
  原生 VNC 客户端用户设 `SUMERU_VNC_LOCALHOST=0` 并同时开启 `SUMERU_VNC_AUTH=vnc`。
- **为什么是 TigerVNC Xvnc**：noVNC 只有在服务端声明支持 Extended Clipboard
  （UTF-8）时才走 Unicode 剪贴板路径，否则回退到 ISO-8859-1 并把 `> 0xFF` 的字符
  **在浏览器里直接替换成 `?`**（`vendor/novnc/core/rfb.js`）。x11vnc 没有实现该扩展；
  TigerVNC 1.10+ 实现了，但 **1.12 的剪贴板只在 Xvnc 里**（`unix/xserver/hw/vnc/vncSelection.c`，
  x0vncserver 没有剪贴板代码），所以 X 与 VNC 合并成一个 Xvnc 进程。

### 6.2 口令来源（只来自配置）

```text
SUMERU_VNC_PASSWORD_FILE → 文件内容
SUMERU_VNC_PASSWORD      → 环境变量
两者皆空 且 SUMERU_VNC_AUTH=vnc → 启动失败（exit 1）
```

- **不自动生成、不持久化明文**：口令的唯一来源是部署配置，容器内不保存可用于
  "事后取回"的明文副本。改口令 = 改配置 + 重启（env 改动需重建容器，同 §5.4）。
- Xvnc 只接受口令**文件**，所以必须派生一个易失文件：
  `printf '%s' "$pw" | vncpasswd -f > "$dir/vnc.passwd"`。

  ```text
  dir = /dev/shm/sumeru-vnc   （tmpfs，内存支持；不可写时退化为 /tmp/sumeru-vnc）
    dir/               0700  每次启动先 rm -rf 再建
    dir/vnc.passwd     0600  vncpasswd -f 产物（混淆后 8 字节），仅同 uid 可读
  ```

  - 优先 tmpfs，是为了让"口令只在内存"尽可能成立；退化到 `/tmp` 也仍然是容器
    临时目录，两者都**不在 `/data` 卷上**，不会成为跨重启/跨升级的认证状态。
  - **先删再建**：`docker restart` 会保留容器可写层，不清旧文件就可能出现
    "配置已改、文件还是上一次的"。启动脚本先 `rm -rf "$dir"` 再重建，
    保证当次配置是唯一事实来源。
  - 文件内容若带行尾换行，先去掉再计长度（否则 8 位口令会被数成 9 位而误判超长）。
- 口令**不进 argv**：`vncpasswd -f` 从 stdin 读明文，服务端命令行只有
  `-PasswordFile <路径>`（这一点比之前的 x11vnc `-storepasswd` 更好）。
- 派生调用用 `umask 077` 保证文件权限；口令不会被打印到日志。
- 推荐用 `SUMERU_VNC_PASSWORD_FILE`（compose/K8s secret）：env 形式会出现在
  `docker inspect` 的输出里，文件不会。
- `SUMERU_VNC_PASSWORD_FILE` 读取失败（不存在/不可读）→ 启动失败，不回退到 env：
  静默回退会让"挂载错 secret"变成"用旧口令跑着"，比启动失败更难排查。

### 6.3 RFB 的 8 字符限制

RFB 认证是 DES + 8 字节口令，**只有前 8 字符有效**。因为口令只来自配置，
这里按"配置即事实"处理，不静默截断：

| 配置值 | 行为 |
|---|---|
| 1–7 字节 | 启动告警：强度不足，建议 8 位随机字母数字（口令照常生效） |
| 恰好 8 字节 | 正常 |
| > 8 字节 | **启动失败**：提示"RFB 只认前 8 字节，请改成恰好 8 位 ASCII" |
| `vnc` 模式且为空 | **启动失败**（§6.2） |

> 为什么 >8 直接失败而不是告警：配置写 12 位、实际只生效前 8 位，等于配置与
> 现实不一致；对认证配置来说这种"看起来更安全、其实没生效"的偏差必须暴露出来。
>
> 字符集建议只用 ASCII 字母数字：RFB 的 DES 口令对非 ASCII 字符的支持依赖客户端编码，
> 容易出现"服务端配了、客户端输不进去"的差异。

### 6.4 启动顺序与 fail-fast

沿用仓库既有风格（参考 `start-all.sh` 的 IME fail-fast）：

1. `SUMERU_VNC_AUTH=vnc` 时先解析口令（`_FILE` → env），缺失/超长 → `exit 1`；
2. `vncpasswd -f` 失败 → `exit 1`；
3. 口令文件就绪后才起 Xvnc，避免"先裸跑后补认证"的窗口。

`restart: unless-stopped` 下配置错误会表现为反复重启 + 日志里一行明确原因，
这是刻意的：宁可起不来，也不要静默降级成无认证。

### 6.5 noVNC 交互与剪贴板

- 连接时 noVNC 自动弹密码框，由 Xvnc 校验；输错表现为 RFB 认证失败。
- 口令不要放 URL（`?password=` 会进访问日志 / Referer / 浏览器历史）。
- **剪贴板**：noVNC 连上后会协商 Extended Clipboard（Xvnc 的 caps 里 `formats=text`、
  `actions` 含 caps/notify/provide），此时"复制中文 → noVNC 剪贴板面板 → 远端 Ctrl+V"
  是 UTF-8 往返；实测 X CLIPBOARD 里拿到的是原文 `e4b8ad...`，没有这个扩展时 noVNC
  会把中文替换成 `?`。
- 远端输入法与剪贴板是两条互补路径：打拼音走 IME（§9.3 的 IME 检查），整段文本走剪贴板。

## 7. 代码落点

```text
src/auth.mjs（新增，零依赖）
  MCP_AUTH_MODES
  loadAuthConfig(env)        → {mode, enforce, realm, digest:Buffer|null, source, warnings:[]}
  bearerToken(headers)       → string | null
  verifyCredential(headers, auth) → {ok, reason:"missing"|"invalid"}
  challengeHeaders(auth, {error}) → {"www-authenticate": "..."}
  fingerprint(token)         → "sha256:3f2a…"
  sanitizeChildEnv(env)      → 剥离认证变量后的 env（给 chrome 用）

src/runtime.mjs
  loadConfig: auth = loadAuthConfig(env)（`apiKey` 字段已移除；旧 config.apiKey 非空时
  createRuntime 直接抛错，避免"传了 key 但认证没生效"）
  authorized(): 改为 verifyCredential；createRuntime 接受 `log` 注入，拒绝时记指纹
  handleRequest: /mcp 前置鉴权；401 带 headers
  healthz(): 增 auth 字段（不动 8 层）

src/index.mjs
  loadAuthConfig 后 delete process.env 中的认证变量
  spawnChrome 用 auth.sanitizeChildEnv(env)
  启动日志打印认证姿态（不打印凭据）
  P3：透传 req.socket.remoteAddress 供限速

bin/start-all.sh, bin/start-novnc.sh
  VNC 口令解析（_FILE → env，缺失/超长 fail-fast）
  rm -rf 后由 vncpasswd -f 重建 /dev/shm/sumeru-vnc/vnc.passwd（不可写退化 /tmp）
  -PasswordFile + -SecurityTypes VncAuth + -localhost

deploy/compose.yaml, deploy/.env.example
  新 env 透传；注释给 secrets 用法
```

`config.auth` 缺失时按"开放"处理（`config.auth ?? {enforce:false}`），保证手工构造
config 的既有测试不炸。

## 8. 明确不做的 VNC 加固（记录取舍）

**websockify Basic（`--web-auth` + `BasicHTTPAuth`）**：Debian bookworm 的
websockify 0.10.0 支持，能保护 `vnc.html` 与 WS 升级，但

- 直连 5900 可绕过（除非叠加 `-localhost`），不是独立防线；
- 多一套用户名/口令，与 RFB 口令是两套凭据，运维成本上升；
- 浏览器"页面 Basic 凭据是否会带到同源 WebSocket 升级"需要逐浏览器验证。

因此本版不做；若后续需要，按 `--auth-plugin=BasicHTTPAuth --auth-source="$u:$p" --web-auth`
接入，并注意 `--auth-source` 会出现在 `/proc/<pid>/cmdline`。

## 9. 测试计划

### 9.1 单测（`npm test`，不需要 Docker/内核）

| 文件 | 覆盖 |
|---|---|
| `test/auth.test.mjs`（新增） | 空配置=开放；单 key 正确/错误；`_FILE` 优先、与 env 同时存在告警、读取失败即失败；Bearer 大小写/空白；`X-Sumeru-Token` 回退；缺失/`Basic` scheme/超长拒绝；含空白或逗号的 key 判配置错误；`required` 无 key 抛错；挑战头格式；指纹不含原值；`sanitizeChildEnv` 剥离认证变量但保留 `SUMERU_GATEWAY_TOKEN` |
| `test/mcp-auth.test.mjs`（新增） | 无凭据 `401` 且无 `error=`；错凭据 `401` + `invalid_token`；正确 `200`；通知 `202`；`GET /mcp` 未认证 `401`；`tools/call` 同样被拦；`/healthz` 仍开放；拒绝日志只含指纹；旧 `config.apiKey` 抛错 |
| `test/healthz.test.mjs` | 既有 `/gw` 401/200 矩阵不变；新增 Bearer 通过 |
| `test/mcp-http.test.mjs` | 既有 5 条（无 key）保持绿 |
| `test/runtime.test.mjs` | `loadConfig` 新增字段；`apiKey` 兼容字段保留 |

### 9.2 集成（`npm run smoke`，需容器）

`smoke` 只走公开 HTTP 面，按环境变量启用条件断言，不配置时全部跳过：

- `SUMERU_API_KEY` 已设：`/mcp` 无头 `401`、带头 `200`；`/gw` 无头 `401`。
- `SUMERU_API_KEY` 未设：`/mcp` 仍 `200`（回归保护，确认默认路径没被改坏）。

VNC 认证发生在 VNC 协议内部，HTTP 探不到，因此放到 §9.3 的 `docker exec` 检查。

### 9.3 人工/脚本验收

1. `docker logs` / `npm run logs` 全文 grep 不到口令与 token 明文。
2. 宿主机 `docker top sumeru | grep Xvnc`：含 `-PasswordFile`、`-localhost`，
   **且不含口令明文**。
3. `docker exec sumeru stat -c '%a' /dev/shm/sumeru-vnc/vnc.passwd` → `600`
   （退化路径下换成 `/tmp/sumeru-vnc/vnc.passwd`）。
4. 5900 只绑回环：`docker exec sumeru cat /proc/net/tcp | awk '$2 ~ /:170C$/'`
   只应出现 `0100007F:170C`（127.0.0.1:5900），不应出现 `00000000:170C`（0.0.0.0）。
   宿主若 publish 过 5900，`nc 127.0.0.1 5900` 也应连不上。
5. 浏览器打开 noVNC：弹密码框；错口令被拒；对口令能看能点。
6. 配置错误 fail-fast：`SUMERU_VNC_AUTH=vnc` 但无口令、或口令 9 位 → 一次性
   `docker run` 退出码非 0，日志给出明确原因。
7. **重启换配置**：改 `SUMERU_API_KEY`（或 secret 文件）后让新配置生效——`_FILE` 用
   `docker restart`，env 用 `docker compose up -d` 重建——旧 token → `401`、新 token → `200`
   （证明没有沿用什么落盘状态）；同样地改 `SUMERU_VNC_PASSWORD` 后旧口令失效。
8. `/data` 卷上没有认证材料（需 API key 已配置）：
   `docker exec sumeru sh -c 'grep -rIl "$SUMERU_API_KEY" /data 2>/dev/null'` 输出为空；
   `find /data -iname '*passwd*'` 没有任何认证相关文件。
9. 浏览器与编排辅助进程看不到凭据：chrome（主进程 + 任一 renderer）与
   Xvnc/websockify 的 `/proc/<pid>/environ` 都不含 `SUMERU_API_KEY` /
   `SUMERU_VNC_PASSWORD`；shim 自身仍有（exec 初始环境块无法用 unset 抹除，见 §4）。
10. 原生 VNC 客户端场景（`SUMERU_VNC_LOCALHOST=0` + publish 5900）在文档中保留为
    **显式危险项**。

## 10. 兼容性与发布

- 唯一破坏性变更：已设 `SUMERU_API_KEY` 的部署升级后 `/mcp` 开始要凭据。
  退路 `SUMERU_MCP_AUTH=off`；CHANGELOG 的 `Changed` 段与 `Security` 段都要写。
- `CHANGELOG.md` 记 `2.2.0`；`package.json` / `build-info.json` 版本一致（`npm run version:check`）。
- 认证状态不落盘 ⇒ 升级/回滚**没有任何迁移步骤**：带上（或去掉）新的 env / secret，
  重建/重启容器即可，旧凭据不会残留，也不需要"清状态"脚本。
- MCP `SERVER_VERSION` 升 `0.5.0`（工具 schema 不变，只是鉴权行为变化）。
- 回滚：镜像回上一 tag；已设 `SUMERU_VNC_AUTH=vnc` 的部署回滚后 noVNC 不再要密码——
  回滚说明里必须提示同步关闭对外端口。

## 11. 本次同步的文档（2.2.0 已完成）

| 文件 | 改动 |
|---|---|
| `AGENTS.md` | 现写"`/mcp` 目前不鉴权…不要加公网暴露路径"→ 改为"默认无 key 即开放；有 key 时强制；新增暴露面必须走认证" |
| `docs/security.md` | 重写 §3（MCP 鉴权）、§5（noVNC）；补轮换与秘密管理 |
| `docs/operations.md` | env 表新增 6 行；noVNC 章节加口令说明 |
| `docs/troubleshooting.md` | 401 / 挑战头 / VNC 密码框 / 口令配置错误导致的 fail-fast |
| `docs/architecture.md` | 门面层职责补"认证" |
| `docs/README.md` | 索引加本文档 |
| `README.md` / `README.en.md` | MCP 客户端配置加 `headers`；安全章节改写（双语一致） |
| `.dsh/skills/sumeru-browser/**` | MCP 配置示例、401 排障 |
| `bin/sumeru.mjs` GUIDE | "暂不鉴权"措辞更新 |

## 12. 实施顺序（每步独立可提交、CI 绿）

1. `feat(auth): add credential loader and constant-time verifier`
   —— `src/auth.mjs` + `test/auth.test.mjs`，不接线。
2. `feat(shim): require token on /mcp and accept bearer on /gw`
   —— runtime 接线 + 401 头 + `test/mcp-auth.test.mjs` + `/healthz.auth`；
   `src/index.mjs` 读入后删除认证 env、用 `sanitizeChildEnv` 给 chrome。
3. `feat(runtime): start VNC with configurable password auth`
   —— `start-all.sh` / `start-novnc.sh` / compose / `.env.example`。
4. `test(smoke): assert auth matrix for /mcp and noVNC`。
5. `docs: document MCP and VNC authentication`（§11 全表）。
6. `chore(release): 2.2.0`（CHANGELOG + 版本一致性）。

## 13. 风险

| 风险 | 缓解 |
|---|---|
| RFB 只取 8 字符，配了 12 位却只生效 8 位 | **>8 直接启动失败**，不做静默截断；文档与错误信息都说明原因 |
| 单 key 轮换期间客户端短暂 `401` | 低峰操作；401 带 `WWW-Authenticate: Bearer`，客户端可提示重新配置；`/healthz` 免认证不影响探针 |
| VNC 口令只来自配置，`_FILE` 挂错导致起不来 | 刻意 fail-fast + 日志明确原因；不回退到 env、不自动生成，避免"以为改了其实没改" |
| 中文粘贴变 `?` | 服务端改用 TigerVNC Xvnc：它在 caps 里声明 Extended Clipboard（text），noVNC 才走 UTF-8 路径（§6.1） |
| 凭据被浏览器进程继承（`/proc/<chrome>/environ`） | spawn 前 `delete process.env.*` + `sanitizeChildEnv` 白名单式剥离；验收检查主进程与 renderer 的 environ |
| 存量已设 key 的部署 MCP 客户端突然 401 | CHANGELOG breaking 标注 + `SUMERU_MCP_AUTH=off` 退路 + README 迁移段 |
| 只支持 OAuth 的 MCP 客户端连不上 | 文档明确"静态 token，非 OAuth 资源服务器" |
| `-localhost` 破坏原生 VNC 客户端用法 | `SUMERU_VNC_LOCALHOST=0` 显式放行，并要求同时开认证 |
| 手搓 config 的测试因缺 `auth` 崩溃 | runtime 侧 `?? {enforce:false}` 兜底 + 用例覆盖 |

## 14. 后续（不在本版）

- `SUMERU_ALLOWED_ORIGINS`：DNS rebinding 防护，Origin 不在白名单 → `403`。
- 失败限速：按 `remoteAddress` 记失败次数，超阈值 `429` + `Retry-After`（需在
  `src/index.mjs` 透传地址）。
- `MCP-Protocol-Version` 头校验（宽松：缺失放行，存在且未知 → `400`）。
- websockify Basic（§8）与 VNC over TLS 终止示例。