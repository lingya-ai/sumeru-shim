# Sumeru（须弥）· AI 原生云浏览器

以 **Chromium（Google Chrome 同源内核）** 为原型构建的 AI 原生云浏览器。

浏览器运行在云端容器中，**7×24 在线**；Agent 通过统一 Gateway / MCP 操作真实的浏览器，
人类通过 noVNC 实时观看和接管。**使用端不需要本地电脑**，不需要安装 Chrome、Playwright
或任何自动化环境。

> 不是无头爬虫，也不是远程桌面套壳：原生 Chromium 窗口 + 真实 TabStripModel +
> 面向 Agent 的操作面；页面没有 SDK 注入，也没有 CDP 端口。

> **许可**：源码可见，个人/非商业使用免费（PolyForm Noncommercial 1.0.0）；
> **商业使用需要商业许可证**。本项目不是 OSI 开源项目。

## 为什么是「AI 原生」

| 能力 | 说明 |
|---|---|
| **Agent-first 接口** | 12 个语义化方法（标签/导航/求值/截图/AX/键鼠/IME），`POST /gw` 或 MCP 工具 1:1 暴露 |
| **真实浏览器** | 原生 Chromium 窗口、真实标签条、真实 Profile；cookie / localStorage / 登录态持久化 |
| **7×24 在线** | 容器常驻，`restart: unless-stopped`，健康检查，profile 卷跨重启恢复标签与登录态 |
| **人机共处** | 人类在 noVNC 里看见并直接操作同一个浏览器；无门控、无仲裁，是否冲突由使用者判断 |
| **无本地依赖** | 浏览器、GPU 库、输入法、noVNC 都在云端；客户端只需网络和一个浏览器 |
| **无 CDP / 无注入** | 没有 `--remote-debugging-*`、没有监听端口、没有页面 SDK；操作面只有私有 UDS gateway |
| **可审计** | 内核只保留最小 overlay（20 文件 / 123 KB），其余是 stock Chromium |

## 典型场景

- **7×24 浏览器值守**：定时巡检、价格/库存监控、后台任务、长流程表单。
- **Agent 的长期工作区**：登录态、标签页、历史都留在云端，Agent 随叫随到。
- **远程办公/演示**：不把业务系统装到本地，浏览器跑在云端，人通过 noVNC 看和点。
- **Web 应用测试与 dogfooding**：真实 Chromium、真实输入（`isTrusted=true`）、真实截图与 AX。
- **需要稳定网络出口的任务**：把浏览器放在有固定出口/代理的云主机上。

## 架构

```text
Agent（LLM / 应用）
  │  HTTP POST /gw {method, params}   或 POST /mcp（Streamable HTTP）
  │  curl / SDK / MCP client
  ▼
薄 shim（node src/index.mjs）                       :8080
  ├─ 启动 chrome（无 --remote-debugging-*）
  ├─ GET /healthz（八层健康）
  ├─ POST /gw → gateway 客户端
  └─ POST /mcp → MCP tools（无状态 JSON）
  │  UDS /data/sumeru-gateway.sock（token）
  ▼
Chromium（自建内核，唯一状态权威）
  ├─ K-Gateway（浏览器进程内；JSON-line over UDS）
  ├─ TabStripModel 真实标签（人类可见、可点）
  ├─ evaluateTarget → 进程内 DevToolsAgentHost → Runtime.evaluate
  └─ snapshotAX → AX tree；captureScreenshot → surface capture
  │  X11 :99
  ▼
Xvfb ← x11vnc ← websockify/noVNC                    :6901
  ▲
人类（浏览器打开 noVNC，直接看/点）
```

## 快速开始（本地或云主机）

前置：Docker（云主机用 Docker Engine；Windows/macOS 用 Docker Desktop）。
Node.js 22+ 仅用于 CLI/测试。

```bash
git clone https://github.com/lingya-ai/sumeru-shim.git
cd sumeru-shim

# 1) 内核：使用维护者提供的本地 artifact，或已有 build/
npm run setup -- --from ./sumeru-kernel-*.tar.gz
# npm run setup -- --check   # 已有 build/ 时

# 2) 单测（不依赖 Docker/内核）
npm test

# 3) 起容器（构建镜像 + 启动浏览器）
npm run up

# 4) 端到端冒烟
npm run smoke
```

> 仓库不包含 Chromium 源码或预编译内核；请按 [docs/kernel.md](docs/kernel.md) 下载源码并本地构建。

打开 **http://127.0.0.1:6901/vnc.html**，能看到原生 Chromium 窗口。

```bash
node bin/sumeru.mjs health
node bin/sumeru.mjs tabs
node bin/sumeru.mjs eval active "document.title"
node bin/sumeru.mjs ax active
node bin/sumeru.mjs shot active ./page.png
```

离线/内网：把 kernel artifact 放到本地，`npm run setup -- --from ./sumeru-kernel-*.tar.gz`。
已有 `build/` 时用 `npm run setup -- --check`。

停止 / 日志 / 验收：

```bash
npm run logs
npm run down
npm run acceptance      # m-series
npm run acceptance:m09  # 关标签 + 在途求值回归
```

## 构建 Chromium 内核

内核源码不在仓库里；开发时按版本缓存到 gitignored 的 `chromium-src/<version>/src`。

### 1. 下载源码

```bash
# 推荐：浅层源码，不拉完整历史
chromium/scripts/fetch-kernel-source.sh --shallow --proxy http://127.0.0.1:3128

# 需要更多历史时（例如构建脚本要 git log）
chromium/scripts/fetch-kernel-source.sh --shallow --depth 20 --jobs 1

# 不跑 gclient runhooks，交给 build-kernel.sh 补 clang/sysroot
chromium/scripts/fetch-kernel-source.sh --shallow --no-hooks
```

默认仍是完整历史；`--shallow` 使用 `git clone --depth` + `gclient sync --no-history`。
代理默认不使用；`--proxy` 或 `SUMERU_PROXY` 显式开启。

完成后会输出：

```text
SUMERU_SRC=.../chromium-src/<version>/src
```

下文用：

```bash
VERSION="$(cat chromium/VERSION)"
SRC="$PWD/chromium-src/$VERSION/src"
```

### 2. 应用 overlay，直接改源码

`chromium/overlay/current.patch` 是对 pristine Chromium 的 diff。第一次开发：

```bash
git -C "$SRC" apply --check chromium/overlay/current.patch
git -C "$SRC" apply chromium/overlay/current.patch
```

之后直接改 `$SRC` 下的文件（例如 `sumeru/browser/gateway/`、`chrome/browser/sumeru/`、
`content/browser/renderer_host/sumeru_page_capture.cc`）。

如果 patch 已经应用，`build-kernel.sh` 会自动跳过 apply；不要重复打。

### 3. 增量构建

```bash
docker build -f chromium/Dockerfile.kernel -t sumeru-kernel-build chromium
docker run --rm -it \
  -v "$SRC:/src" \
  -e SUMERU_SRC=/src \
  sumeru-kernel-build
```

- 首次 4–8 h；之后增量 10–30 min。
- 构建产物在 `$SRC/out/release-linux/`。
- 改 `chromium/args.gn.linux`（如 `is_debug=true`、`symbol_level=2`）会重新 `gn gen`。
- 只想快速验证 overlay 是否还能应用：`git -C "$SRC" apply --check chromium/overlay/current.patch`。

### 4. 让运行时用上新内核

```bash
SUMERU_SRC="$SRC" SUMERU_VERSION="$VERSION" \
  SUMERU_COMMIT="$(git -C "$SRC" rev-parse --short HEAD)" \
  bash chromium/scripts/package-kernel.sh dist

rm -rf build && mkdir build
tar -xzf dist/sumeru-kernel-*.tar.gz -C build
npm run up
npm run smoke
```

`npm run up` 会用新的 `build/` 重建运行时镜像；只改 shim 时不需要重新编译 Chromium。

### 5. 重新生成 overlay

改完源码后，把“当前源码相对 pristine 的差异”导回 patch：

```bash
# 只把 overlay 的新增路径标记为 intent-to-add（不要 git add -A，
# 否则 gclient 拉取的第三方依赖也会被卷进 patch）
git -C "$SRC" add -N -- \
  sumeru \
  chrome/browser/sumeru \
  content/browser/renderer_host/sumeru_page_capture.cc \
  content/public/browser/sumeru_page_capture.h
git -C "$SRC" diff --binary > chromium/overlay/current.patch
git -C "$SRC" reset
```

生成后建议在干净源码树上验证：

```bash
git -C "$SRC" apply --reverse --check chromium/overlay/current.patch
```

排障与运行日志见 [docs/troubleshooting.md](docs/troubleshooting.md)。

`src/`、`bin/`、`scripts/` 的改动走正常的 Node/Docker 循环。

## 部署到云端

`deploy/compose.yaml` 是一个可直接用的单机编排：

```bash
# 云主机上
git clone https://github.com/lingya-ai/sumeru-shim.git
cd sumeru-shim
npm run setup -- --from ./sumeru-kernel-*.tar.gz
npm run up
```

默认只绑 `127.0.0.1`（8080/6901）。云上给人类访问时，建议：

1. **noVNC** 放在 VPN / 反向代理 + TLS + 认证之后，不要直接暴露 6901；
2. **`/gw`** 若跨机器访问，必须设置 `SUMERU_API_KEY`，客户端带 `X-Sumeru-Token`；
3. 数据卷挂到持久盘（`/data`），容器重启/升级不丢标签、历史、登录态；
4. 资源建议 `--cpus=2 --memory=3g --memory-swap=3g --shm-size=1g`；
5. 用 `restart: unless-stopped` + `/healthz` 做存活探测。

云厂商、K8s、Nomad 都可以；本仓库不绑定具体云平台，只要求能跑 Linux 容器。

## Agent 接口

### 12 个方法

| 域 | 方法 |
|---|---|
| 标签 | `createTab` / `listTabs` / `closeTab` / `activateTab` |
| 页面 | `navigateTarget` / `evaluateTarget` / `captureScreenshot` / `snapshotAX` |
| 输入 | `dispatchKey` / `dispatchMouse` / `imeCompose` |
| 基础 | `ping` |

### HTTP

```bash
curl -s http://127.0.0.1:8080/gw \
  -H 'content-type: application/json' \
  -d '{"method":"listTabs","params":{}}'

curl -s http://127.0.0.1:8080/gw \
  -H 'content-type: application/json' \
  -d '{"method":"evaluateTarget","params":{"targetId":"<id>","expression":"document.title"}}'
```

### MCP

推荐使用 shim 自带的 **Streamable HTTP** endpoint，客户端不需要 Node：

```text
POST http://127.0.0.1:8080/mcp
协议版本：2025-06-18
传输：无状态 JSON-only
```

MCP 客户端配置：

```json
{
  "mcpServers": {
    "sumeru": {
      "type": "http",
      "url": "http://127.0.0.1:8080/mcp"
    }
  }
}
```

> 当前版本的 `/mcp` **暂不鉴权**，只应绑定 `127.0.0.1` 或内网；不要直接暴露公网。

Agent skill（MCP 工具用法）：[.dsh/skills/sumeru-browser/SKILL.md](.dsh/skills/sumeru-browser/SKILL.md)

### 求值语义

`evaluateTarget` 在目标标签的**主帧主世界**执行一次表达式：

- 不 await Promise（Promise 返回 `{}`，异步内容请轮询）；
- 只操作主帧，iframe 不能单独作为 target；
- DOM 节点/函数等不可 JSON 化的值返回 `{}`；
- 页面无 SDK 全局，没有 `Runtime.enable`，不挂 console 钩子；
- 抛异常 → `SUMERU_OPERATION_FAILED`；坏 target → `SUMERU_TASK_SPACE_NOT_FOUND`。

## 7×24 运行

| 机制 | 说明 |
|---|---|
| 容器重启 | chrome 退出 → shim exit 1 → 编排器拉起新容器；`restart: unless-stopped` |
| Profile 持久化 | `/data` 卷保存标签/历史/cookie/localStorage；重启恢复 |
| 健康检查 | `GET /healthz` 八层：x / synth / webui / gateway / kernel / window / vnc / ime |
| 单例锁清理 | 容器重建换主机名时自动清理 Chrome `Singleton*`；`SUMERU_CLEAR_PROFILE_LOCK=0` 可关 |
| 日志 | `npm run logs`；内核 `[SUMERU-GW]` 行可追踪每次响应 |

## 安全

`evaluateTarget` 等价于在页面主世界执行任意 JS（可读 cookie/DOM）。这是 Agent 能力的来源，
也是最大攻击面：

- 默认只绑回环；不要把 `/gw` 或 `/mcp` 直接暴露公网；
- 对外必须设置 `SUMERU_API_KEY`，并在网络层加访问控制；
- noVNC 默认无密码，云上必须套 VPN/反代 + 认证 + TLS；
- 单容器单用户；不要用同一个浏览器 profile 给互不信任的租户；
- 详见 [docs/security.md](docs/security.md)。

## 已知边界

- **单窗口、单 profile**；`window.open` / Ctrl+N 的顶层窗口在无 WM 下不管理。
- **最后一个标签关不掉**（`SUMERU_LAST_TAB_PROTECTED`）；`SUMERU_KEEP_LAST_TAB=0` 可关（测试用）。
- **gateway 单客户端**；外部客户端与 shim 同时连接会互顶（`SUMERU_GW_SHORT_CONN=1` 可绕）。
- **持久 cookie 约 30 s 提交窗口**；硬杀可能丢最后 30 s。
- **没有 CDP**：不能用 Playwright/Puppeteer 直连；页面调试用 `evaluateTarget` / `snapshotAX` / 截图。
- **不保证绕过所有反自动化检测**；本项目只保证无 SDK 注入、无 CDP 端口、`navigator.webdriver=false`。

## 仓库结构

```text
src/                 薄 shim（spawn chrome + /healthz + /gw + /mcp）
bin/                 CLI（sumeru.mjs）、容器启动脚本
test/                node:test 单测
scripts/             setup / smoke / clean / scan-secrets / acceptance
deploy/              compose.yaml + .env.example
chromium/            内核版本、GN 参数、最小 overlay、kernel artifact Dockerfile
chromium-src/        Chromium 源码缓存（gitignored；按版本分目录）
docs/                架构、开发、运维、内核、排障、安全、版本、发布
.github/workflows/   CI 与 Docker Hub 镜像发布
vendor/novnc/        离线构建用 noVNC（MPL-2.0）
.dsh/skills/        Agent skills（MCP 浏览器操作）
build/               内核产物（gitignored；由 setup 获取）
```

## 文档

- [docs/architecture.md](docs/architecture.md) — 架构与操作面
- [docs/development.md](docs/development.md) — 本地开发/调试
- [docs/operations.md](docs/operations.md) — 部署、健康、升级/回滚
- [docs/kernel.md](docs/kernel.md) — 内核/overlay/artifact
- [docs/versioning.md](docs/versioning.md) — 版本号/镜像标签/发布流程
- [CHANGELOG.md](CHANGELOG.md) — 版本变更记录
- [docs/troubleshooting.md](docs/troubleshooting.md) — 常见故障
- [docs/security.md](docs/security.md) — 安全模型

## 许可证

- **Sumeru 原创代码**：PolyForm Noncommercial 1.0.0，仅允许个人/非商业用途；
  商业使用需 [商业许可证](LICENSE-COMMERCIAL.md)。这是 **source-available**，
  不是 OSI 开源项目。
- **Chromium**：BSD-3-Clause 及第三方条款；商业许可不覆盖 Chromium，
  上游许可证必须保留。
- 第三方组件：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；
  商标：[TRADEMARK.md](TRADEMARK.md)。

> Google Chrome 与 Chromium 是 Google LLC 的商标；本项目与 Google 无关联，
> 也未获其背书。