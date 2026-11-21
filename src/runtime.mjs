/**
 * 薄网关代理运行时（gateway-only，纯函数可单测）。
 *
 * 职责：
 * 1. `loadConfig`：chrome 启动参数（**无 CDP**）+ gateway UDS 位置 + HTTP 端口；
 * 2. `createRuntime`：`GET /healthz` + `POST /gw` + `POST /mcp`。
 *
 * HTTP 面：
 * - `GET  /healthz`  分层健康。
 * - `POST /gw`       `{method, params}` → `gateway.request(...)`，原样回传。
 * - `POST /mcp`      MCP Streamable HTTP（无状态 JSON-only，2025-06-18）。
 *                    本版本暂不鉴权；只应绑定回环/内网。
 */

import fs from "node:fs";
import { handleMcpRequest } from "./mcp/core.mjs";

/** `/healthz.layers` 的固定 8 层（顺序即契约，测试按此断言）。 */
export const HEALTH_LAYERS = [
  "x",
  "synth",
  "webui",
  "gateway",
  "kernel",
  "window",
  "vnc",
  "ime",
];

/** IME 未配置时的标注（不再探进程，避免「没开 fcitx」被误报成不健康）。 */
export const IME_NOT_CONFIGURED = "ime:not-configured";

/** `GET /gw` 等非 `POST /gw` 请求的 404 文案（与兜底 404 同形）。 */
function noRoute(method, path) {
  return { status: 404, body: { error: `no route: ${method} ${path}` } };
}

/** 屏幕几何（WxH[xD]）→ 窗口尺寸（W,H）。默认取 start-all.sh 导出的 1280x800。 */
function windowSize(env) {
  const explicit = env.SUMERU_WINDOW_SIZE;
  if (explicit) return explicit;
  const screen = env.SUMERU_SCREEN ?? "1280x800x24";
  const match = /^(\d+)x(\d+)/.exec(screen);
  if (!match) return "1280,800";
  return `${match[1]},${match[2]}`;
}

export function loadConfig(env = process.env) {
  return {
    port: Number(env.SHIM_PORT ?? 8080),
    chromePath: env.SUMERU_CHROME_PATH ?? "chrome",
    // K-Gateway（唯一操作面）：UDS + token，见docs/architecture.md。
    gatewaySocket: env.SUMERU_GATEWAY_SOCKET ?? "/data/sumeru-gateway.sock",
    gatewayToken: env.SUMERU_GATEWAY_TOKEN ?? "sumeru-gateway",
    gatewayTimeoutMs: Number(env.SUMERU_GATEWAY_TIMEOUT_MS ?? 15_000),
    // 启动就绪探针：轮询 gateway ping（现行内核无 listTabs —— ready == ping 通）。
    readyTimeoutMs: Number(env.SUMERU_READY_TIMEOUT_MS ?? 60_000),
    readyPollMs: Number(env.SUMERU_READY_POLL_MS ?? 250),
    // 可选：设置后 `/gw` 要求 `X-Sumeru-Token` 头（`/healthz` 保持开放给探针）。
    apiKey: env.SUMERU_API_KEY ?? "",
    // 分层健康的环境坐标（端口/显示号只用于探测，不改变行为）。
    display: env.SUMERU_DISPLAY ?? "99",
    novncPort: Number(env.SUMERU_NOVNC_PORT ?? 6901),
    vncPort: Number(env.SUMERU_VNC_PORT ?? 5900),
    ime: env.SUMERU_IME ?? "",
    chromeArgs: [
      // 呈现层：noVNC 看的就是这个原生窗口。SUMERU_HEADLESS=0 时走 X11（DISPLAY=:99），
      // 否则退化为 headless（仅本地调试/单测用；产品形态是原生窗口，D2）。
      ...(env.SUMERU_HEADLESS === "0" ? [] : ["--headless=new"]),
      // 无 WM 的 Xvfb 下必须显式给几何（）。
      // 窗口尺寸默认跟随 SUMERU_SCREEN（WxH[xD]）；窗口比屏幕大会被裁，比屏幕小
      // 会在 noVNC 里留出一圈黑边，所以两者共用一个来源。
      "--window-position=0,0",
      `--window-size=${windowSize(env)}`,
      // 注意：这里**没有** --remote-debugging-pipe / --remote-debugging-port。
      // A01/D8：唯一操作面是 gateway UDS，无 CDP 监听、无回退端口。
      `--user-data-dir=${env.SUMERU_PROFILE_DIR ?? "/data/profile"}`,
      `--disk-cache-dir=${env.SUMERU_CACHE_DIR ?? "/data/hot/cache"}`,
      // 开发容器默认关闭沙箱；生产/验收可设 SUMERU_NO_SANDBOX=0 使用 SUID chrome-sandbox。
      ...(env.SUMERU_NO_SANDBOX === "0" ? [] : ["--no-sandbox"]),
      // 抑制「unsupported command-line flag: --no-sandbox」信息条（原生窗口下也会挡内容）
      "--test-type",
      "--no-first-run",
      "--disable-dev-shm-usage",
      // 注意：不要加 --disable-gpu——X 显示模式下会影响首帧
      "--disable-features=Translate,MediaRouter",
      "--lang=zh-CN",
      "--hide-scrollbars",
      "--password-store=basic", // cookie 跨容器可解密（安全说明）
      // D6：容器重启后恢复上次会话的标签（profile 卷自然持久）。
      ...(env.SUMERU_RESTORE_SESSION === "0" ? [] : ["--restore-last-session"]),
      // 测试/实验开关：SUMERU_CHROME_EXTRA_ARGS="--flag-a --flag-b"
      ...(env.SUMERU_CHROME_EXTRA_ARGS
        ? env.SUMERU_CHROME_EXTRA_ARGS.split(/\s+/).filter(Boolean)
        : []),
    ],
  };
}

function exists(path) {
  try {
    return fs.existsSync(path);
  } catch {
    return false;
  }
}

// A listening TCP port as seen from /proc/net/tcp{,6} (hex, little-endian).
function tcpListed(port) {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let raw = "";
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4) continue;
      const local = cols[1] ?? "";
      const addr = local.split(":");
      if (addr.length === 2 && addr[1] === hex && cols[3] === "0A") {
        return true; // 0A == TCP_LISTEN
      }
    }
  }
  return false;
}

/**
 * 默认探针：容器文件系统 + /proc。测试可整组注入。
 *
 * 注意这里**没有**「探测 fcitx 进程」的探针：gateway 明确 ime 层不再看进程
 * （误报源），IME 的二进制存在性由 `bin/start-all.sh` 的 fail-fast 负责。
 */
export function createFsProbes() {
  return {
    displayExists(display) {
      return exists(`/tmp/.X11-unix/X${display}`);
    },
    socketExists(socketPath) {
      return exists(socketPath);
    },
    tcpListed(port) {
      return tcpListed(port);
    },
  };
}

/**
 * 装配薄代理运行时。
 *
 * @param {object} options
 * @param {object} options.config `loadConfig()` 的结果
 * @param {{request: Function, isConnected?: Function}} options.gateway gateway 客户端
 * @param {object} [options.probes] 环境探针（`createFsProbes()`，测试可注入）
 */
export function createRuntime({ config, gateway, probes, now = () => Date.now() } = {}) {
  if (!config) throw new TypeError("createRuntime requires config");
  if (!gateway || typeof gateway.request !== "function") {
    throw new TypeError("createRuntime requires gateway with request()");
  }
  const probe = probes ?? createFsProbes();

  let ready = false;
  let windowReady = false;
  let lastGatewayError = null;

  function kernelAlive() {
    return typeof gateway.isConnected === "function" && gateway.isConnected() === true;
  }

  /**
   * 8 层分级健康（gateway）：任何一层挂掉都不得冒充其他层健康。
   * - x / synth：X11 socket（无独立合成器，Xvfb 自己合成，两者同源）
   * - webui：noVNC 的 websockify 监听端口
   * - gateway：UDS socket 文件存在
   * - kernel：gateway 连接存活（ping 通道在）
   * - window：X 显示 + shim 已过就绪探针（无 WM，窗口随 X 存在）
   * - vnc：x11vnc 监听端口
   * - ime：**不探进程**。SUMERU_IME 未设时恒 true 并标注 `ime:not-configured`；
   *        设了则由 start-all.sh 的 fail-fast 保证二进制存在，shim 侧如实体检。
   */
  function healthz() {
    const displayUp = probe.displayExists(config.display);
    const layers = {
      x: displayUp,
      synth: displayUp,
      webui: probe.tcpListed(config.novncPort),
      gateway: probe.socketExists(config.gatewaySocket),
      kernel: kernelAlive(),
      window: windowReady && displayUp,
      vnc: probe.tcpListed(config.vncPort),
      ime: true,
    };
    const notes = {};
    if (!config.ime) notes.ime = IME_NOT_CONFIGURED;
    return {
      ready,
      layers,
      notes,
      gateway: {
        socket: config.gatewaySocket,
        connected: layers.kernel,
        lastError: lastGatewayError,
      },
    };
  }

  function authorized(headers) {
    if (!config.apiKey) return true;
    let given = headers?.["x-sumeru-token"] ?? headers?.["X-Sumeru-Token"];
    if (Array.isArray(given)) given = given[0];
    return typeof given === "string" && given === config.apiKey;
  }

  function invalidArgument(message) {
    return {
      status: 400,
      body: { ok: false, error: { code: "SUMERU_INVALID_ARGUMENT", message } },
    };
  }

  /** `POST /gw`：把 {method, params} 原样交给 gateway，结果/错误原样回传。 */
  async function proxyGatewayCall(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return invalidArgument("body must be a JSON object {method, params}");
    }
    const method = body.method;
    if (typeof method !== "string" || method.trim() === "") {
      return invalidArgument("method must be a non-empty string");
    }
    const params = body.params === undefined ? {} : body.params;
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      return invalidArgument("params must be a JSON object");
    }
    const started = now();
    try {
      const result = await gateway.request(method, params);
      lastGatewayError = null;
      return {
        status: 200,
        body: {
          ok: true,
          method,
          result: result === undefined ? null : result,
          durationMs: now() - started,
        },
      };
    } catch (error) {
      // 原样透传：code / message 不改写、不包裹成新的语义。
      const code = error?.code ?? "SUMERU_OPERATION_FAILED";
      const message = error?.message ?? String(error);
      lastGatewayError = { code, message, at: now() };
      return {
        status: 200,
        body: { ok: false, method, error: { code, message }, durationMs: now() - started },
      };
    }
  }

  async function handleRequest({ method, path, body, headers } = {}) {
    if (method === "GET" && path === "/healthz") {
      const state = healthz();
      return { status: state.ready ? 200 : 503, body: state };
    }
    if (path === "/mcp") {
      if (method !== "POST") {
        return {
          status: 405,
          headers: { allow: "POST" },
          body: {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "MCP endpoint accepts POST only" },
          },
        };
      }
      // v2.1.x HTTP MCP is intentionally unauthenticated for first-version
      // validation; bind the shim to loopback/private network only.
      const response = await handleMcpRequest(body, (m, p) => gateway.request(m, p));
      if (response === null) {
        return { status: 202, empty: true, body: null };
      }
      return { status: 200, body: response };
    }
    if (path === "/gw") {
      if (method !== "POST") return noRoute(method, path);
      if (!authorized(headers)) {
        return {
          status: 401,
          body: {
            ok: false,
            error: { code: "SUMERU_UNAUTHORIZED", message: "missing or invalid X-Sumeru-Token" },
          },
        };
      }
      return proxyGatewayCall(body);
    }
    return noRoute(method, path);
  }

  return {
    config,
    gateway,
    handleRequest,
    healthz,
    proxyGatewayCall,
    markReady(value = true) {
      ready = value;
    },
    // 窗口层有自己的就绪信号（就绪探针通过后由 index.mjs 调用一次）。
    markWindowReady(value = true) {
      windowReady = value;
    },
    get ready() {
      return ready;
    },
    get windowReady() {
      return windowReady;
    },
    get lastGatewayError() {
      return lastGatewayError;
    },
  };
}
