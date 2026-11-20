# 架构

## 一句话

**自建 Chromium（原生窗口）+ 最小 gateway 模块 + 薄 shim 代理 + noVNC 观看。**
单窗口、单 profile、agent 与人类同时可用；没有 CDP，没有页面常驻注入。

## 总图

```text
Agent（LLM / 应用）
  │  HTTP POST /gw {method, params}   或 MCP 工具
  ▼
薄 shim（node src/index.mjs）                         :8080
  ├─ spawn chrome（无 --remote-debugging-*）
  ├─ GET /healthz（八层）
  └─ POST /gw → gateway 客户端
  │  UDS /data/sumeru-gateway.sock（hello/token/v2）
  ▼
Chromium 156（自建内核，唯一状态权威）
  ├─ K-Gateway（浏览器进程内；UDS JSON-line）
  ├─ TabStripModel 真实标签（人类可见、可点）
  ├─ Gateway → DevToolsAgentHost（进程内）→ Runtime.evaluate / Page.navigate
  └─ snapshotAX → AX tree；captureScreenshot → surface capture
  │  X11 :99
  ▼
Xvfb ← x11vnc ← websockify/noVNC                     :6901
```

## 四层职责

| 层 | 组件 | 职责 | 不做什么 |
|---|---|---|---|
| 呈现 | Xvfb / x11vnc / websockify / noVNC + 原生 Chromium 窗口 | 人类观看与直接操作 | 零自定义 UI |
| 门面 | `src/`、`bin/`、`deploy/compose.yaml` | 拉起 chrome、持 token、`/gw` 代理、健康/退出语义 | 无状态；不做 ledger/viewer/CDP |
| 契约 | K-Gateway（`sumeru/browser/gateway/sumeru_gateway.cc`） | 浏览器唯一对外操作通道 | 不做空间/所有权/lease/事件流 |
| 权威 | Chromium 自身 | TabStripModel、NavigationController、Profile、窗口树 | 无第二状态副本 |

## 操作面（12 个方法）

| 域 | 方法 |
|---|---|
| 标签 | `createTab` / `listTabs` / `closeTab` / `activateTab` |
| 页面 | `navigateTarget` / `evaluateTarget` / `captureScreenshot` / `snapshotAX` |
| 输入 | `dispatchKey` / `dispatchMouse` / `imeCompose` |
| 基础 | `ping`（+ 版本协商/鉴权帧） |

所有方法通过 `POST /gw`（或 MCP 工具）1:1 暴露；返回值/错误码原样透传。

## `evaluateTarget` 的实际路径

```text
POST /gw
  → shim 原样代理
  → UDS → 浏览器 IO 线程 SumeruGateway
  → UI 线程：targetId → WebContents（TabStripModel delegate）
  → DevToolsAgentHost::GetForId / GetOrCreateFor
  → AttachClient（缓存单 agent）
  → Runtime.evaluate {expression, returnByValue:true, awaitPromise:false}
  → renderer 主帧主世界执行
  → UI 收回复 → post 回 IO → 解包 value → UDS → HTTP
```

要点：

- **主帧、主世界**；没有 frameId 参数，iframe 不作为 target。
- **不 await Promise**；Promise 返回 `{}`，异步内容需自行轮询。
- **不可 JSON 化**的值（DOM 节点/函数）返回 `{}` 或 `{type:"undefined"}`。
- 页面无 SDK 全局；没有 `Runtime.enable`，不挂 console 钩子。
- 错误：抛异常 → `SUMERU_OPERATION_FAILED`；CDP 错误 → `GW_EVAL_ERROR`；
  坏 target → `SUMERU_TASK_SPACE_NOT_FOUND`；shim 侧 15 s → `GATEWAY_TIMEOUT`。

## 进程与健康

```text
tini (PID 1, bin/start-all.sh)
├─ Xvfb :99
├─ x11vnc :5900 ← websockify :6901
├─ fcitx5（可选；SUMERU_IME=fcitx 时）
└─ node src/index.mjs（前台）
   └─ chrome（原生窗口）
      ├─ renderer / GPU / network / utility
```

`GET /healthz` 八层：`x / synth / webui / gateway / kernel / window / vnc / ime`。
`ready=true` 只表示 shim 启动步骤完成；各层独立报告。

## 代码索引

| 要改什么 | 去哪 |
|---|---|
| 操作面方法/协议 | `sumeru/browser/gateway/sumeru_gateway.cc` |
| 真实标签操作 | `sumeru/browser/tabs/tab_ops.h` + `chrome/browser/sumeru/tabs/sumeru_tab_ops.cc` |
| 最后标签守卫 | `chrome/browser/sumeru/tabs/sumeru_last_tab_guard.cc` + `TabStripModel::CloseTabs` |
| AX 快照 | `sumeru/browser/snapshot/snapshot_serializer.cc` |
| 页面截图 | `content/browser/renderer_host/sumeru_page_capture.cc` |
| shim 启动/代理/健康 | `src/index.mjs`、`src/runtime.mjs`、`src/startup.mjs` |
| CLI / MCP | `bin/sumeru.mjs`、`bin/sumeru-mcp.mjs` |
| 容器启动/IME | `bin/start-all.sh`、`bin/start-novnc.sh` |
| 镜像 | `Dockerfile.runtime` |

> 内核源码不在本仓库；overlay 与 artifact 见 [kernel.md](kernel.md)。

## 已知边界

- **单窗口**：`window.open` / Ctrl+N 的顶层窗口在无 WM 下不管理。
- **最后一个标签关不掉**：`SUMERU_LAST_TAB_PROTECTED`；退出/关机路径放行；
  `SUMERU_KEEP_LAST_TAB=0` 可关（测试用）。
- **gateway 单客户端**：外部 gate 与 shim 同时连接会互顶；`SUMERU_GW_SHORT_CONN=1` 可绕。
- **cookie 落盘延迟**：持久 cookie 约 30 s 提交；标签/历史/localStorage 立即落盘。
- **profile 单例锁**：容器重建换主机名会触发；shim 启动前清理 `Singleton*`。
- **资源**：推荐 `--cpus=2 --memory=3g --memory-swap=3g --pids-limit=512 --shm-size=1g`。