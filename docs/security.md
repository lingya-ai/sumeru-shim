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

## 3. `/gw` 鉴权

- 默认 `SUMERU_API_KEY` 为空 → 本机可无鉴权调用。
- 设置 `SUMERU_API_KEY` 后，`/gw` 要求 `X-Sumeru-Token: <key>`；`/healthz` 保持开放。
- compose 默认只绑 `127.0.0.1:8080`。如果改成 `0.0.0.0` 或放到反向代理后，
  **必须**设置 API key，并加网络层访问控制。

## 4. UDS 与 token

- gateway 只监听容器内 `/data/sumeru-gateway.sock`，权限 `0600`。
- `SUMERU_GATEWAY_TOKEN` 每次启动随机生成（`bin/start-all.sh`），shim/chrome 共享；
  不写入镜像/仓库。
- 同 uid 的容器内进程仍可读 `/proc/<pid>/environ` 或直接连 socket；这是单用户容器
  的边界，不要把它当多租户隔离。
- gateway 单客户端：新连接会顶掉旧连接；诊断时用 `/gw`，不要绕过 shim。

## 5. 传输与网络

- 没有 CDP 监听、没有 `--remote-debugging-*`、没有 WS 回退。
- noVNC（6901）默认无密码，仅绑 `127.0.0.1`；对外提供时必须加 TLS/认证/网络 ACL。
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
