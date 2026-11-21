/**
 * 须弥入口（薄网关代理，gateway-only）：
 *
 *   spawn chrome（无 CDP 参数：--window-position=0,0 --window-size=1280,800）
 *     → gateway 客户端（UDS + token）
 *     → HTTP（GET /healthz + POST /gw）
 *     → 退出语义（chrome 退出 ⇒ 容器退出 exit 1）
 *
 * 门面层不再持状态：没有 heavens / bindings / viewer / host-ipc / checkpoint /
 * 轮次 worker，也没有 CDP transport（A01/D8：唯一操作面是 gateway UDS）。
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { createGatewayClient } from "./ipc/gateway-client.mjs";
import { clearStaleProfileLock } from "./profile-lock.mjs";
import { createRuntime, loadConfig } from "./runtime.mjs";
import { waitForBrowserReady } from "./startup.mjs";

/** chrome 死掉时容器的退出码（编排器据此拉起新代）。 */
export const CHROME_EXIT_CODE = 1;

function log(message) {
  console.error(`[shim] ${message}`);
}

/**
 * 拉起 chrome。返回 child（stderr 逐行转发，内核诊断日志必须保留）。
 *
 * @param {object} options
 * @param {object} options.config `loadConfig()` 的结果
 * @param {Function} [options.spawnFn] 注入点（测试用 fake child_process.spawn）
 * @param {NodeJS.ProcessEnv} [options.env]
 */
export function spawnChrome({ config, spawnFn = spawn, env = process.env } = {}) {
  if (!config) throw new TypeError("spawnChrome requires config");
  const child = spawnFn(config.chromePath, config.chromeArgs, {
    // stdio[0..1] 不用；stderr 走管道由这里逐行转发（保留 SUMERU-WIN 等内核日志）；
    // 第 4 个 fd 不再需要——没有 CDP pipe（fd 3/4 是旧 CDP 通道）。
    stdio: ["ignore", "ignore", "pipe"],
    env,
  });
  if (child?.stderr?.on) {
    let buffered = "";
    child.stderr.on("data", (chunk) => {
      buffered += String(chunk);
      let index;
      while ((index = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        if (line.trim() !== "") process.stderr.write(`${line}\n`);
      }
    });
  }
  return child;
}

/**
 * 退出语义：chrome 退出 = 容器退出（exit 1）。优雅关停期间不触发。
 *
 * @param {object} child child_process 的 child（或 mock 的 EventEmitter）
 * @param {object} [options]
 * @param {(code: number) => void} [options.exit]
 * @param {() => boolean} [options.isShuttingDown]
 * @param {(message: string) => void} [options.log]
 */
export function attachExitSemantics(
  child,
  { exit = (code) => process.exit(code), isShuttingDown = () => false, log: logFn = log } = {},
) {
  if (!child || typeof child.once !== "function") {
    throw new TypeError("attachExitSemantics requires a child process/emitter");
  }
  child.once("exit", (code, signal) => {
    logFn(`chrome exited code=${code} signal=${signal}`);
    if (!isShuttingDown()) exit(CHROME_EXIT_CODE);
  });
  child.once("error", (error) => {
    logFn(`chrome failed: ${error?.message ?? error}`);
    if (!isShuttingDown()) exit(CHROME_EXIT_CODE);
  });
  return child;
}

/** 读请求体并解析 JSON（空体 = undefined）。 */
export async function readJsonBody(req, limitBytes = 32 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) return { ok: false, tooLarge: true };
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return { ok: true, body: undefined };
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, body: undefined };
  }
}

/**
 * 启动薄代理（供 `node src/index.mjs` 与测试共用）。
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {Function} [options.spawnFn] chrome spawn 注入点
 * @param {Function} [options.gatewayFactory] gateway 客户端注入点
 * @param {(code: number) => void} [options.exit] 退出注入点
 * @param {Function} [options.createServerFn] HTTP server 注入点
 */
export async function start({
  env = process.env,
  spawnFn = spawn,
  gatewayFactory = createGatewayClient,
  exit = (code) => process.exit(code),
  createServerFn = createServer,
} = {}) {
  const config = loadConfig(env);
  let shuttingDown = false;

  // 唯一操作面：gateway UDS 客户端（token 由 shim 持有，不落 HTTP 面以外的位置）。
  const gateway = gatewayFactory({
    socketPath: config.gatewaySocket,
    token: config.gatewayToken,
    timeoutMs: config.gatewayTimeoutMs,
  });

  const runtime = createRuntime({ config, gateway });

  const server = createServerFn(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const { ok, body, tooLarge } = await readJsonBody(req);
    if (tooLarge) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ ok: false, error: { code: "SUMERU_PAYLOAD_TOO_LARGE", message: "body too large" } }),
      );
      return;
    }
    if (!ok) {
      if (path === "/mcp") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          }),
        );
        return;
      }
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { code: "SUMERU_INVALID_ARGUMENT", message: "invalid json" } }));
      return;
    }
    const outcome = await runtime.handleRequest({
      method: req.method ?? "GET",
      path,
      body,
      headers: req.headers,
    });
    res.writeHead(outcome.status, {
      "content-type": "application/json",
      ...(outcome.headers ?? {}),
    });
    if (outcome.empty) {
      res.end();
      return;
    }
    res.end(JSON.stringify(outcome.body ?? {}));
  });

  // 先起 HTTP（/healthz 在启动过程中就能回答分层状态，便于定位），再等内核就绪。
  await new Promise((resolve) => server.listen(config.port, resolve));
  log(`http listening on ${config.port}`);

  // chrome 先起：内核进程和 gateway UDS 是它就绪之后才有的。
  // D6 健壮性：容器重建后主机名变化，Chrome 会把上一代的 SingletonLock 当成
  // 「另一台机器占用 profile」而 exit 21。spawn 前清掉陈旧锁。
  const removedLocks = clearStaleProfileLock(env.SUMERU_PROFILE_DIR ?? "/data/profile", {
    enabled: env.SUMERU_CLEAR_PROFILE_LOCK !== "0",
    onRemove: (path) => log(`cleared stale profile lock: ${path}`),
  });
  if (removedLocks.length > 0) log(`profile locks cleared: ${removedLocks.length}`);

  const child = spawnChrome({ config, spawnFn, env });
  attachExitSemantics(child, { exit, isShuttingDown: () => shuttingDown });
  log(`chrome spawned: ${config.chromePath} (no CDP flags)`);

  try {
    const ready = await waitForBrowserReady({
      ping: () => gateway.request("ping", {}),
      timeoutMs: config.readyTimeoutMs,
      intervalMs: config.readyPollMs,
      onAttempt: (attempt, error) => {
        if (attempt === 1 || attempt % 20 === 0) {
          log(`waiting for kernel gateway (attempt=${attempt}): ${error?.message ?? ""}`);
        }
      },
    });
    log(`kernel gateway ready (ping ok, attempts=${ready.attempts})`);
    runtime.markWindowReady(true);
    runtime.markReady(true);
  } catch (error) {
    // 内核不答 ping 是「内核/启动故障」，不是 chrome 死：容器继续跑，
    // /healthz 如实报 ready=false + 分层状态，交给编排器/人工定位。
    log(`kernel gateway not ready: ${error?.message ?? error}`);
  }

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received, shutting down`);
    runtime.markReady(false);
    server.close();
    try {
      gateway.close?.();
    } catch {
      /* socket already gone */
    }
    // D6：重启容器后 profile（cookie/会话/历史）要能恢复 —— 必须先让 chrome
    // 有机会把 profile 落盘，不能 kill 完立刻 exit。
    const flushTimeoutMs = Number(env.SUMERU_SHUTDOWN_FLUSH_MS ?? 15_000);
    const closed = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
      setTimeout(resolve, flushTimeoutMs);
    });
    try {
      child.kill("SIGTERM");
    } catch {
      /* already exited */
    }
    await closed;
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return { config, runtime, gateway, server, child };
}

const isDirect =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  start().catch((error) => {
    console.error("[shim] failed to start:", error);
    process.exit(1);
  });
}
