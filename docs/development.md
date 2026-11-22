# 本地开发

## 前置

| 项 | 要求 |
|---|---|
| Node.js | 22+（单测/CLI/MCP） |
| Docker | Docker Desktop（Windows/macOS）或 Docker Engine（Linux） |
| 磁盘 | 镜像约 3.5 GB + 内核 artifact 约 250 MB |
| 内存 | 推荐 4 GB 可用；容器默认限制 3 GB |

## 目录

```text
src/            shim：index / runtime / startup / ipc / ime-text / profile-lock
bin/            sumeru CLI、MCP server、start-all.sh
test/           node:test 套件
scripts/        setup / smoke / run-acceptance / clean / scan-secrets / ci
scripts/acceptance/linux/m-series/   验收 gate
deploy/         compose.yaml + .env.example
chromium/       内核版本/GN 参数/minimal overlay
docs/           架构/开发/运维/内核/排障/安全
logs/           本地日志（git 忽略，统一写这里）
```

## 1. 单测

```bash
npm test
```

测试不依赖 Docker、不依赖内核。

## 2. 内核

二选一：

```bash
npm run setup -- --check                         # 已有 build/
npm run setup -- --from ./sumeru-kernel-*.tar.gz # 维护者提供的本地 artifact
# npm run setup -- --fetch                       # 仅当 build-info.json 配了 URL
```

当前公开 Release 已撤回；没有本地 artifact 时请先按 [kernel.md](kernel.md) 自行构建。
`build-info.json` 记录 Chromium 版本、内核 commit、chrome SHA256、artifact URL。
校验不通过时 `npm run setup -- --check` 退出 1。

## 3. 起容器

```bash
npm run up        # docker compose -f deploy/compose.yaml up -d --build
npm run logs
npm run down
```

- noVNC：<http://127.0.0.1:6901/vnc.html>（可用 `SUMERU_NOVNC_PORT` 改宿主机端口）
- shim：`http://127.0.0.1:8080/healthz`、`POST /gw`
- 数据卷：`sumeru-data` → `/data`（profile/缓存）

## 4. 冒烟与验收

```bash
npm run smoke          # 10 项：healthz/ping/tabs/create/navigate/eval/ax/shot/cleanup
npm run acceptance     # m-series（默认 8080；可 GW_BASE=... 覆盖）
npm run acceptance:m09 # 关标签 + 在途求值回归（对临时 runtime 运行）
```

## 5. CLI / MCP

```bash
node bin/sumeru.mjs health
node bin/sumeru.mjs tabs
node bin/sumeru.mjs open "https://example.com"
node bin/sumeru.mjs nav active "https://example.com"
node bin/sumeru.mjs eval active "document.title"
node bin/sumeru.mjs ax active
node bin/sumeru.mjs shot active ./page.png
node bin/sumeru.mjs key active Enter --text="..."
node bin/sumeru.mjs click active 120 480
node bin/sumeru.mjs ime active "中文"
node bin/sumeru.mjs close <targetId>
```

MCP（Streamable HTTP，无状态 JSON，协议 `2025-06-18`）：

```text
POST http://127.0.0.1:8080/mcp
```

`/mcp` 与 `/gw` 共用 `SUMERU_API_KEY`：设了 key 就要带
`Authorization: Bearer <key>`（或 `X-Sumeru-Token`），没设则两个面都开放、只应绑定
回环/内网。细节见 [auth.md](auth.md)。

```bash
# 本地带凭据调用
export SUMERU_API_KEY="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | cut -c1-32)"
curl -s http://127.0.0.1:8080/mcp \
  -H "Authorization: Bearer $SUMERU_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 6. 调试 shim

```bash
node --inspect-brk src/index.mjs
# VS Code attach 9229
```

或用容器日志看内核 `[SUMERU-GW]` 行：

```bash
npm run logs
```

## 7. 页面操作语义

- `evaluateTarget` 只操作**主帧主世界**；无 CDP、无 iframe target。
- **不 await Promise**：`new Promise(...)` 立即返回 `{}`；等待内容请轮询。
- DOM 节点/函数等不可 JSON 化的返回值是 `{}`。
- `navigateTarget` 等到 `Page.loadEventFired` 才返回（新文档可用）。
- `captureScreenshot` 截页面（不含浏览器 chrome）；非活动标签会先激活。
- `dispatchKey` / `dispatchMouse` / `imeCompose` 走 renderer 输入通道，`isTrusted=true`。

## 8. 提交约定

- 一个主题一个提交；提交前 `npm run ci`（单测 + 语法 + 秘密扫描 + compose config）。
- 内核改动要同步 overlay，并在 `build-info.json` 更新 commit/SHA。
- 文档与实现保持一致；日志文件统一写 `logs/`（git 忽略），不要提交 `build/`、
  `dist/`、本地 profile 与日志。

## 9. 内核开发

见 [kernel.md](kernel.md)。完整构建需要 Chromium 156 源码与 150 GB 磁盘。