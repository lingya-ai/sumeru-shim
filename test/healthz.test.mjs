// `/healthz` 分层健康（gateway）：收缩后 8 层结构 + 可选鉴权 + 路由面收窄。
//
// 8 层：x / synth（同 x）/ webui（noVNC 端口）/ gateway（UDS 存在）/ kernel（gateway 连接）/
//       window（X display）/ vnc / ime（未配置时恒 true 并标注 "ime:not-configured"）。

import assert from "node:assert/strict";
import test from "node:test";

import { createRuntime, HEALTH_LAYERS, IME_NOT_CONFIGURED, loadConfig } from "../src/runtime.mjs";

/** 可编程探针：记录调用，返回预设值。 */
function probes(overrides = {}) {
  const calls = { display: [], tcp: [], socket: [] };
  return {
    calls,
    displayExists: (display) => {
      calls.display.push(display);
      return overrides.display ?? true;
    },
    socketExists: (socketPath) => {
      calls.socket.push(socketPath);
      return overrides.socket ?? true;
    },
    tcpListed: (port) => {
      calls.tcp.push(port);
      return overrides.tcp?.[port] ?? false;
    },
  };
}

function harness({ env = {}, probeOverrides = {}, connected = true } = {}) {
  const probe = probes(probeOverrides);
  const gateway = {
    request: async () => ({ pong: true }),
    isConnected: () => connected,
  };
  const runtime = createRuntime({ config: loadConfig(env), gateway, probes: probe });
  return { runtime, probe, gateway };
}

test("/healthz：8 层固定结构（顺序即契约）", async () => {
  const { runtime } = harness();
  const body = runtime.healthz();
  assert.deepEqual(Object.keys(body.layers), HEALTH_LAYERS);
  assert.equal(HEALTH_LAYERS.length, 8);
  assert.deepEqual(HEALTH_LAYERS, [
    "x",
    "synth",
    "webui",
    "gateway",
    "kernel",
    "window",
    "vnc",
    "ime",
  ]);
});

test("/healthz：x 与 synth 同源（无独立合成器，Xvfb 自己合成）", async () => {
  assert.deepEqual(
    (() => {
      const body = harness({ probeOverrides: { display: true } }).runtime.healthz();
      return [body.layers.x, body.layers.synth, body.layers.window];
    })(),
    [true, true, false],
  );
  const down = harness({ probeOverrides: { display: false } }).runtime.healthz();
  assert.equal(down.layers.x, false);
  assert.equal(down.layers.synth, false);
  assert.equal(down.layers.window, false);
});

test("/healthz：webui/vnc 用 noVNC 与 VNC 端口探测；gateway 用 UDS 路径", async () => {
  const { runtime, probe } = harness({
    env: { SUMERU_NOVNC_PORT: "7001", SUMERU_VNC_PORT: "5901", SUMERU_GATEWAY_SOCKET: "/tmp/gw.sock" },
    probeOverrides: { tcp: { 7001: true, 5901: false }, socket: true },
  });
  const body = runtime.healthz();
  assert.equal(body.layers.webui, true);
  assert.equal(body.layers.vnc, false);
  assert.equal(body.layers.gateway, true);
  assert.deepEqual(probe.calls.tcp.sort((a, b) => a - b), [5901, 7001]);
  assert.deepEqual(probe.calls.socket, ["/tmp/gw.sock"]);
  assert.equal(body.gateway.socket, "/tmp/gw.sock");
});

test("/healthz：kernel 层只看 gateway 连接存活（不看 UDS 文件）", async () => {
  const alive = harness({ connected: true }).runtime.healthz();
  assert.equal(alive.layers.kernel, true);
  const dead = harness({ connected: false, probeOverrides: { socket: true } }).runtime.healthz();
  assert.equal(dead.layers.kernel, false); // UDS 还在、连接没了 → kernel=false
  assert.equal(dead.layers.gateway, true); // gateway 层只看 socket 文件存在
  assert.equal(dead.gateway.connected, false);
});

test("/healthz：window 层需要 shim 过就绪探针（markWindowReady）", () => {
  const { runtime } = harness();
  assert.equal(runtime.healthz().layers.window, false);
  runtime.markWindowReady(true);
  assert.equal(runtime.healthz().layers.window, true);
  runtime.markWindowReady(false);
  assert.equal(runtime.healthz().layers.window, false);
});

test("/healthz：ime 未配置 → 恒 true 并标注 ime:not-configured（不探 fcitx 进程）", () => {
  const unset = harness().runtime.healthz();
  assert.equal(unset.layers.ime, true);
  assert.equal(unset.notes.ime, IME_NOT_CONFIGURED);
  // 配置了 SUMERU_IME 就不再带标注（二进制存在性由 start-all.sh fail-fast 保证）
  for (const ime of ["fcitx", "1"]) {
    const configured = harness({ env: { SUMERU_IME: ime } }).runtime.healthz();
    assert.equal(configured.layers.ime, true);
    assert.equal(configured.notes.ime, undefined);
  }
});

test("/healthz：ready=false → 503，markReady 后 200（ready 语义不变）", async () => {
  const { runtime } = harness();
  const before = await runtime.handleRequest({ method: "GET", path: "/healthz" });
  assert.equal(before.status, 503);
  assert.equal(before.body.ready, false);
  assert.equal(Object.keys(before.body.layers).length, 8);

  runtime.markReady(true);
  const after = await runtime.handleRequest({ method: "GET", path: "/healthz" });
  assert.equal(after.status, 200);
  assert.equal(after.body.ready, true);

  runtime.markReady(false);
  assert.equal((await runtime.handleRequest({ method: "GET", path: "/healthz" })).status, 503);
});

test("/gw 鉴权：SUMERU_API_KEY 设置时缺头/错头 → 401，正确 → 200", async () => {
  const { runtime } = harness({ env: { SUMERU_API_KEY: "sk-secret" } });
  const missing = await runtime.handleRequest({
    method: "POST",
    path: "/gw",
    body: { method: "ping", params: {} },
  });
  assert.equal(missing.status, 401);
  assert.equal(missing.body.ok, false);
  assert.equal(missing.body.error.code, "SUMERU_UNAUTHORIZED");

  const wrong = await runtime.handleRequest({
    method: "POST",
    path: "/gw",
    body: { method: "ping", params: {} },
    headers: { "x-sumeru-token": "sk-nope" },
  });
  assert.equal(wrong.status, 401);

  const ok = await runtime.handleRequest({
    method: "POST",
    path: "/gw",
    body: { method: "ping", params: {} },
    headers: { "x-sumeru-token": "sk-secret" },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);

  // /healthz 保持开放：容器探针不该需要 API key
  const health = await runtime.handleRequest({ method: "GET", path: "/healthz" });
  assert.equal(health.status, 503); // 只是 ready=false，不是 401
});

test("/gw 鉴权：未设 SUMERU_API_KEY 时不校验头", async () => {
  const { runtime } = harness();
  const res = await runtime.handleRequest({
    method: "POST",
    path: "/gw",
    body: { method: "ping", params: {} },
    headers: { "x-sumeru-token": "anything" },
  });
  assert.equal(res.status, 200);
});

test("路由面收窄：只有 GET /healthz 与 POST /gw，其余一律 404", async () => {
  const { runtime } = harness();
  const dead = [
    ["POST", "/round"],
    ["POST", "/reconcile"],
    ["POST", "/checkpoint"],
    ["POST", "/heartbeat"],
    ["GET", "/visual"],
    ["GET", "/"],
    ["GET", "/nope"],
    ["POST", "/healthz"], // healthz 只认 GET
  ];
  for (const [method, path] of dead) {
    const res = await runtime.handleRequest({ method, path });
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.equal(res.body.error, `no route: ${method} ${path}`);
  }
});
