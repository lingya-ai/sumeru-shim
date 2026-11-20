#!/usr/bin/env node
/**
 * sumeru — operator CLI for the Sumeru kernel (gateway-only browser).
 *
 * It speaks the shim's HTTP surface (`POST /gw`, `GET /healthz`), which is the
 * same path an external agent uses: no CDP, no WebSocket fallback, no page
 * injection. Every command maps 1:1 to a gateway method.
 *
 *   node bin/sumeru.mjs skill           # print the usage guide (agent entry point)
 *   node bin/sumeru.mjs health
 *   node bin/sumeru.mjs tabs
 *   node bin/sumeru.mjs open <url>
 *   node bin/sumeru.mjs active
 *   node bin/sumeru.mjs nav    <target|active> <url>
 *   node bin/sumeru.mjs eval   <target|active> <expression>
 *   node bin/sumeru.mjs shot   <target|active> [file.png]
 *   node bin/sumeru.mjs ax     <target|active>
 *   node bin/sumeru.mjs key    <target|active> <key> [--text=<t>]
 *   node bin/sumeru.mjs click  <target|active> <x> <y>
 *   node bin/sumeru.mjs ime    <target|active> <text> [commit]
 *   node bin/sumeru.mjs close  <target>
 *
 * Env: SUMERU_GATE_URL (default http://127.0.0.1:8080), SUMERU_API_KEY (sent as
 * X-Sumeru-Token when set).
 */
import { writeFileSync } from "node:fs";
import { basename } from "node:path";

const GUIDE = `[sumeru:skill] sumeru kernel usage guide v2.0 (contraction)

# 须弥内核（gateway-only 浏览器）

这个内核是一个**原生 Chromium 浏览器**，唯一操作面是 gateway：
\`POST /gw {"method":...,"params":{...}}\`（shim 把 HTTP 转成浏览器私有 UDS）。
**没有 CDP**（无 --remote-debugging-*、无监听、无回退），页面里**没有任何注入**
（无 globalThis.sumeru）。所以：只能用下面 12 个方法，不要试图
起 Playwright/Puppeteer、不要找 CDP 端口、不要在页面里找 SDK 全局。

## 先跑这三条

node bin/sumeru.mjs health          # 八层健康；ready=true 才继续
node bin/sumeru.mjs tabs            # 拿到 targetId（*=活动标签）
node bin/sumeru.mjs open "https://example.com"   # 建标签 → 打印 targetId

任何命令里的 <target> 都可以写 \`active\`，表示当前活动标签，免去查 id。

## 方法面（12 个，HTTP 与 MCP 工具 1:1）

| 做什么 | 方法 | CLI |
|---|---|---|
| 探活 | ping | \`health\`（走 /healthz，也用 ping） |
| 列标签 | listTabs | \`tabs\` |
| 建标签 | createTab {url} | \`open <url>\` |
| 关标签 | closeTab {targetId} | \`close <id>\`（最后一个标签会被拒绝） |
| 切标签 | activateTab {targetId} | \`nav\`/\`eval\` 前自动，不单独需要 |
| 导航 | navigateTarget {targetId,url} | \`nav <t> <url>\` |
| 求值 | evaluateTarget {targetId,expression} | \`eval <t> "<expr>"\` |
| 截图 | captureScreenshot {targetId} | \`shot <t> [file]\` |
| AX 快照 | snapshotAX {targetId} | \`ax <t>\` |
| 键盘 | dispatchKey {targetId,type,key,...} | \`key <t> <key>\` |
| 鼠标 | dispatchMouse {targetId,type,x,y,...} | \`click <t> <x> <y>\` |
| IME 上屏 | imeCompose {targetId,text,commit} | \`ime <t> <text>\` |

## 四个必须知道的语义（都是实测契约，不是建议）

1. **标签是真的**：\`open\` 建的标签出现在浏览器**同一条标签条**上，人类能在
   noVNC 里看见并直接点。不要假设有"后台隐形页"。
2. **navigate 等到 load 才回**：\`nav\` 返回 \`{"navigated":true}\` 时新文档已经可用，
   紧接着 \`eval\` 不会读到旧文档。不要自己 sleep 轮询。
3. **截图会先激活目标标签**：非活动标签也能截（内部会切过去再截）。截的是**页面**，
   不含浏览器 chrome（标签条/地址栏永远不会出现在截图里）。
4. **输入是真事件**：\`key\`/\`click\`/\`ime\` 走 renderer 输入通道，页面里看到
   \`event.isTrusted === true\`（JS 合成事件是 false，很多站点据此区分自动化）。

## 常见动作配方

读页面文字（先探结构再取值——表达式抛异常会整条失败）：
\`\`\`powershell
node bin/sumeru.mjs eval active "document.title"
node bin/sumeru.mjs eval active "document.querySelectorAll('h1').length"
node bin/sumeru.mjs eval active "document.body.innerText.slice(0,2000)"
\`\`\`
点一个元素（先拿坐标，别猜）：
\`\`\`powershell
node bin/sumeru.mjs eval active "JSON.stringify(document.querySelector('#submit').getBoundingClientRect())"
node bin/sumeru.mjs click active 120 480
\`\`\`
填表单（用真键盘，站点才会当真人）：
\`\`\`powershell
node bin/sumeru.mjs eval active "document.querySelector('#q').focus(); 'ok'"
node bin/sumeru.mjs key active "Hello world" --text="Hello world"
\`\`\`
等异步内容（内核只保证 load，不保证 SPA 就绪）：
\`\`\`powershell
node bin/sumeru.mjs eval active "new Promise(r=>setTimeout(()=>r(document.querySelectorAll('.item').length),800))"
\`\`\`
\`evaluateTarget\` 会 await 返回的 Promise，所以可以直接写 async 表达式。

截一张给自己看/存档：
\`\`\`powershell
node bin/sumeru.mjs shot active .\\page.png
\`\`\`

## 边界与坑

- **最后一个标签关不掉**：单标签窗口里 \`closeTab\` 会被拒绝（\`SUMERU_LAST_TAB_PROTECTED\`），
  人类按 Ctrl+W / 点关闭按钮同样无效——这是为了**阻止浏览器退出**。要换页面用 \`nav\`，不要关。
  需要旧行为时用 \`SUMERU_KEEP_LAST_TAB=0\` 起容器（仅测试用）。
- **单窗口**：产品定义单窗口；\`window.open\`/Ctrl+N 出的顶层窗口没有 WM 管理，别依赖。
- **单客户端**：浏览器 gateway 一次只服务一个连接；走 shim 的 HTTP（本 CLI 的做法）
  是安全的，别绕过 shim 直连 UDS，否则会和 shim 互顶。
- **中文输入**：容器需以 \`SUMERU_IME=fcitx\` 启动（镜像已带 fcitx5，缺了会 fail-fast）；
  \`ime <t> <text>\` 走 IME 提交路径，等价于人类用输入法上屏。
- **失败形态**：错误是 \`{"ok":false,"error":{"code","message"}}\`；CLI 以退出码 1 结束并
  打印 code。常见 code：\`GW_UNKNOWN_METHOD\`（方法不存在/已删除）、
  \`SUMERU_TASK_SPACE_NOT_FOUND\`（targetId 过期，重新 \`tabs\` 取）、
  \`SUMERU_SCREENSHOT_FAILED\`（页面还没出帧，稍等重试）。
- **别猜 API**：方法就上表 12 个。要的能力不在表里，就只能用 \`eval\` 在页面里做，
  或者先确认内核是否需要扩展。

## 环境

- \`SUMERU_GATE_URL\`：默认 \`http://127.0.0.1:8080\`（容器内）；从宿主连容器时改成映射端口，
  例如 \`http://127.0.0.1:18880\`。
- \`SUMERU_API_KEY\`：设了就作为 \`X-Sumeru-Token\` 头发送（shim 侧 \`SUMERU_API_KEY\` 开启校验）。

[sumeru:skill] end of guide`;

const baseUrl = (process.env.SUMERU_GATE_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const apiKey = process.env.SUMERU_API_KEY ?? "";

/** One actionable line per recurring failure; anything else stays silent. */
const HINTS = {
  SUMERU_OPERATION_FAILED:
    "表达式自己抛了异常（多是 null/undefined 上取属性）。先用 typeof / querySelectorAll(...).length 探路，再取值。",
  SUMERU_TASK_SPACE_NOT_FOUND: "targetId 已失效（标签被关或页面换了）。重新 `tabs` 取，或用 `active`。",
  SUMERU_SCREENSHOT_FAILED: "页面还没出帧。等 300–800ms 再试，或先 `eval \"document.readyState\"` 确认 complete。",
  GW_UNKNOWN_METHOD: "这个方法在内核里不存在（多空间方法已删除）。只用 `sumeru skill` 里列的 12 个。",
  SUMERU_CLOSE_TAB_REFUSED: "找不到该标签，重新 `tabs`。",
  SUMERU_ACTIVATE_TAB_REFUSED: "找不到该标签，重新 `tabs`。",
  GW_INVALID_ARGUMENT: "参数不足，看 `sumeru skill` 里的命令签名。",
  SUMERU_LAST_TAB_PROTECTED:
    "最后一个标签不允许关闭（关掉它浏览器就退出了）。要换内容就 `nav` 这个标签，不要 `close`。",
};

class GatewayError extends Error {
  constructor(code, message) {
    // The kernel sometimes prefixes the message with its own code; keep the
    // rendered line "error CODE: message" from repeating it.
    const raw = String(message ?? "");
    const prefix = `${code}: `;
    const text = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
    super(`${code}: ${text}`);
    this.code = code;
    this.detail = text;
  }
}

async function call(method, params = {}) {
  const headers = { "content-type": "application/json" };
  if (apiKey) headers["x-sumeru-token"] = apiKey;
  const res = await fetch(`${baseUrl}/gw`, {
    method: "POST",
    headers,
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const json = await res.json().catch(() => ({ ok: false, error: { code: "GW_BAD_RESPONSE", message: "non-JSON reply" } }));
  if (!json.ok) throw new GatewayError(json.error?.code ?? "GW_ERROR", json.error?.message ?? "unknown");
  return json.result;
}

async function health() {
  const res = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(15_000) });
  return res.json();
}

/** "active" resolves through listTabs so callers never have to track ids. */
async function resolveTarget(selector) {
  if (selector && selector !== "active") return selector;
  const { tabs } = await call("listTabs", {});
  const active = tabs.find((t) => t.active) ?? tabs[0];
  if (!active) throw new GatewayError("SUMERU_NO_TABS", "browser has no tabs");
  return active.targetId;
}

const commands = {
  skill() {
    console.log(GUIDE);
  },

  async health() {
    const h = await health();
    const layers = Object.entries(h.layers ?? {}).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`ready=${h.ready} ${layers}`);
    console.log(`gateway=${h.gateway?.connected ? "connected" : "disconnected"} socket=${h.gateway?.socket ?? ""}`);
    if (!h.ready) process.exitCode = 1;
  },

  async ping() {
    console.log(JSON.stringify(await call("ping", {})));
  },

  async tabs() {
    const { tabs } = await call("listTabs", {});
    if (!tabs.length) {
      console.log("(no tabs)");
      return;
    }
    for (const t of tabs) {
      console.log(`${t.active ? "*" : " "} ${t.targetId}  ${t.title || "(untitled)"}  ${t.url}`);
    }
  },

  async active() {
    console.log(await resolveTarget("active"));
  },

  async open(url) {
    if (!url) throw new GatewayError("USAGE", "open <url>");
    // Two steps on purpose: createTab returns as soon as the tab exists, while
    // navigateTarget only answers after Page.loadEventFired. Callers therefore
    // get a tab whose document is already usable — no sleep needed.
    const r = await call("createTab", { url: "about:blank" });
    const targetId = r.targetId;
    if (url !== "about:blank") {
      await call("navigateTarget", { targetId, url });
    }
    console.log(targetId);
  },

  async nav(selector, url) {
    if (!url) throw new GatewayError("USAGE", "nav <target|active> <url>");
    const targetId = await resolveTarget(selector);
    const r = await call("navigateTarget", { targetId, url });
    console.log(JSON.stringify(r));
  },

  async eval(selector, expression) {
    if (!expression) throw new GatewayError("USAGE", 'eval <target|active> "<expression>"');
    const targetId = await resolveTarget(selector);
    const r = await call("evaluateTarget", { targetId, expression });
    const value = r?.value;
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  },

  async shot(selector, file) {
    const targetId = await resolveTarget(selector);
    const r = await call("captureScreenshot", { targetId });
    const out = file ?? `shot-${Date.now()}.png`;
    writeFileSync(out, Buffer.from(r.pngBase64, "base64"));
    console.log(`${out} ${r.bytes}B`);
  },

  async ax(selector) {
    const targetId = await resolveTarget(selector);
    const r = await call("snapshotAX", { targetId });
    console.log(r.content);
  },

  async key(selector, key, ...rest) {
    if (!key) throw new GatewayError("USAGE", 'key <target|active> <key> [--text="..."]');
    const targetId = await resolveTarget(selector);
    const textFlag = rest.find((a) => a.startsWith("--text="));
    const text = textFlag ? textFlag.slice("--text=".length) : undefined;
    if (text !== undefined) {
      // Typing: one char event per character, which is what sites expect.
      for (const ch of text) {
        await call("dispatchKey", { targetId, type: "char", text: ch, key: ch });
      }
      console.log(`typed ${text.length} chars`);
      return;
    }
    await call("dispatchKey", { targetId, type: "rawKeyDown", key });
    await call("dispatchKey", { targetId, type: "keyUp", key });
    console.log(`key ${key}`);
  },

  async click(selector, x, y) {
    const px = Number(x);
    const py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) throw new GatewayError("USAGE", "click <target|active> <x> <y>");
    const targetId = await resolveTarget(selector);
    await call("dispatchMouse", { targetId, type: "mousePressed", x: px, y: py, button: "left", clickCount: 1 });
    await call("dispatchMouse", { targetId, type: "mouseReleased", x: px, y: py, button: "left", clickCount: 1 });
    console.log(`click ${px},${py}`);
  },

  async ime(selector, text, commit) {
    if (!text) throw new GatewayError("USAGE", "ime <target|active> <text> [commit]");
    const targetId = await resolveTarget(selector);
    const r = await call("imeCompose", { targetId, text, commit: commit ?? text });
    console.log(JSON.stringify(r));
  },

  async close(target) {
    if (!target) throw new GatewayError("USAGE", "close <targetId>");
    const r = await call("closeTab", { targetId: target });
    console.log(JSON.stringify(r));
  },
};

async function main(argv) {
  const [raw, ...args] = argv;
  const cmd = raw === undefined ? "skill" : raw;
  const fn = commands[cmd];
  if (!fn) {
    const known = Object.keys(commands).join(" ");
    console.error(`${basename(process.argv[1])}: unknown command "${cmd}"\ncommands: ${known}`);
    process.exitCode = 2;
    return;
  }
  await fn(...args);
}

main(process.argv.slice(2)).catch((error) => {
  if (error instanceof GatewayError) {
    console.error(`error ${error.code}: ${error.detail ?? error.message}`);
    const hint = HINTS[error.code];
    if (hint) console.error(`hint: ${hint}`);
  } else {
    console.error(`error ${error.code ?? "EUNKNOWN"}: ${error.message}`);
    if (error.cause) console.error(String(error.cause));
  }
  process.exitCode = 1;
});