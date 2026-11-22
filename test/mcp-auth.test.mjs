// `/mcp` 与 `/gw` 的鉴权矩阵（HTTP 传输层语义，RFC 6750 挑战头）。
//
// 认证配置来自 `loadConfig(env)`：默认无 key 即开放；有 key 时 /gw 与 /mcp 都强制。
import assert from "node:assert/strict";
import test from "node:test";

import { createRuntime, loadConfig } from "../src/runtime.mjs";

const KEY = "k".repeat(40);

function makeRuntime(env = {}) {
  const calls = [];
  const gateway = {
    isConnected: () => true,
    async request(method, params) {
      calls.push({ method, params });
      if (method === "captureScreenshot") return { pngBase64: "aGVsbG8=", bytes: 5 };
      return { method, params };
    },
  };
  const probes = {
    displayExists: () => true,
    socketExists: () => true,
    tcpListed: () => true,
  };
  const runtime = createRuntime({ config: loadConfig(env), gateway, probes });
  return { runtime, calls };
}

const parse = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

function post(runtime, payload, headers = {}) {
  return runtime.handleRequest({ method: "POST", path: "/mcp", body: payload, headers });
}

test("/mcp：未配置 key 时保持开放（2.1 行为不回退）", async () => {
  const { runtime, calls } = makeRuntime();
  const out = await post(runtime, parse);
  assert.equal(out.status, 200);
  assert.equal(out.body.result.tools.length, 12);
  assert.equal(calls.length, 0);
});

test("/mcp：缺凭据 → 401 + Bearer 挑战（无 error 参数），且不是 JSON-RPC 错误", async () => {
  const { runtime, calls } = makeRuntime({ SUMERU_API_KEY: KEY });
  const out = await post(runtime, parse);
  assert.equal(out.status, 401);
  assert.equal(out.headers["www-authenticate"], 'Bearer realm="sumeru"');
  assert.equal(out.body.error, "unauthorized");
  assert.equal(out.body.jsonrpc, undefined);
  // 鉴权在方法分发之前：gateway 一次都没被调用
  assert.equal(calls.length, 0);
});

test("/mcp：错凭据 → 401 + error=invalid_token，响应不回显 token", async () => {
  const { runtime } = makeRuntime({ SUMERU_API_KEY: KEY });
  const out = await post(runtime, parse, { authorization: "Bearer nope" });
  assert.equal(out.status, 401);
  assert.equal(
    out.headers["www-authenticate"],
    'Bearer realm="sumeru", error="invalid_token"',
  );
  assert.equal(out.body.error, "invalid_token");
  assert.ok(!JSON.stringify(out.body).includes("nope"));
});

test("/mcp：Bearer 与 X-Sumeru-Token 都能通过", async () => {
  const { runtime } = makeRuntime({ SUMERU_API_KEY: KEY });
  const bearer = await post(runtime, parse, { authorization: `Bearer ${KEY}` });
  assert.equal(bearer.status, 200);
  assert.equal(bearer.body.result.tools.length, 12);

  const legacy = await post(runtime, parse, { "x-sumeru-token": KEY });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.result.tools.length, 12);
});

test("/mcp：鉴权先于方法分发（未认证 GET → 401 而非 405）", async () => {
  const { runtime } = makeRuntime({ SUMERU_API_KEY: KEY });
  const out = await runtime.handleRequest({ method: "GET", path: "/mcp", headers: {} });
  assert.equal(out.status, 401);

  const authed = await runtime.handleRequest({
    method: "GET",
    path: "/mcp",
    headers: { authorization: `Bearer ${KEY}` },
  });
  assert.equal(authed.status, 405);
  assert.equal(authed.headers.allow, "POST");
});

test("/mcp：通知也要凭据（未认证 401，认证后 202 空体）", async () => {
  const { runtime } = makeRuntime({ SUMERU_API_KEY: KEY });
  const notification = { jsonrpc: "2.0", method: "notifications/initialized" };

  const anonymous = await post(runtime, notification);
  assert.equal(anonymous.status, 401);

  const authed = await post(runtime, notification, { authorization: `Bearer ${KEY}` });
  assert.equal(authed.status, 202);
  assert.equal(authed.empty, true);
});

test("/mcp：tools/call 同样被拦，认证后才触达 gateway", async () => {
  const { runtime, calls } = makeRuntime({ SUMERU_API_KEY: KEY });
  const call = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "ping", arguments: {} },
  };

  const anonymous = await post(runtime, call);
  assert.equal(anonymous.status, 401);
  assert.equal(calls.length, 0);

  const authed = await post(runtime, call, { authorization: `Bearer ${KEY}` });
  assert.equal(authed.status, 200);
  assert.deepEqual(calls.at(-1), { method: "ping", params: {} });
});

test("/gw：设置 key 后无凭据 401，保持既有错误形状并加挑战头", async () => {
  const { runtime, calls } = makeRuntime({ SUMERU_API_KEY: KEY });
  const out = await runtime.handleRequest({
    method: "POST",
    path: "/gw",
    body: { method: "ping", params: {} },
  });
  assert.equal(out.status, 401);
  assert.equal(out.body.ok, false);
  assert.equal(out.body.error.code, "SUMERU_UNAUTHORIZED");
  assert.equal(out.headers["www-authenticate"], 'Bearer realm="sumeru"');
  assert.equal(calls.length, 0);
});

test("/gw：Bearer 与 X-Sumeru-Token 都能通过；错凭据 401", async () => {
  const { runtime } = makeRuntime({ SUMERU_API_KEY: KEY });
  const body = { method: "ping", params: {} };

  const bearer = await runtime.handleRequest({
    method: "POST",
    path: "/gw",
    body,
    headers: { authorization: `Bearer ${KEY}` },
  });
  assert.equal(bearer.status, 200);
  assert.equal(bearer.body.ok, true);

  const legacy = await runtime.handleRequest({
    method: "POST",
    path: "/gw",
    body,
    headers: { "x-sumeru-token": KEY },
  });
  assert.equal(legacy.status, 200);

  const wrong = await runtime.handleRequest({
    method: "POST",
    path: "/gw",
    body,
    headers: { authorization: "Bearer wrong-token" },
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.code, "SUMERU_UNAUTHORIZED");
});

test("SUMERU_MCP_AUTH=off：只放开 /mcp，/gw 仍要凭据", async () => {
  const { runtime } = makeRuntime({ SUMERU_API_KEY: KEY, SUMERU_MCP_AUTH: "off" });

  const mcpOut = await post(runtime, parse);
  assert.equal(mcpOut.status, 200);

  const gwOut = await runtime.handleRequest({
    method: "POST",
    path: "/gw",
    body: { method: "ping", params: {} },
  });
  assert.equal(gwOut.status, 401);
  assert.equal(runtime.healthz().auth.mcp, "open");
  assert.equal(runtime.healthz().auth.gw, "token");
});

test("/healthz：有 key 时仍免认证，并报告认证姿态", async () => {
  const { runtime } = makeRuntime({ SUMERU_API_KEY: KEY });
  const out = await runtime.handleRequest({ method: "GET", path: "/healthz" });
  assert.equal(out.status, 503); // ready=false，不是 401
  assert.deepEqual(out.body.auth, { gw: "token", mcp: "token", mcpMode: "auto" });
  // 8 层契约不变
  assert.equal(Object.keys(out.body.layers).length, 8);
  assert.ok(!JSON.stringify(out.body).includes(KEY));
});

test("createRuntime：旧的 config.apiKey 非空时直接抛错（不静默放行）", () => {
  assert.throws(
    () =>
      createRuntime({
        config: { apiKey: "legacy-key-value" },
        gateway: { request: async () => ({}) },
        probes: { displayExists: () => true, socketExists: () => true, tcpListed: () => true },
      }),
    (error) =>
      error instanceof TypeError && /config\.apiKey is no longer supported/.test(error.message),
  );
});

test("鉴权失败只记指纹，不记 token", async () => {
  const logs = [];
  const runtime = createRuntime({
    config: loadConfig({ SUMERU_API_KEY: KEY }),
    gateway: { isConnected: () => true, request: async () => ({}) },
    probes: { displayExists: () => true, socketExists: () => true, tcpListed: () => true },
    log: (line) => logs.push(line),
  });

  await post(runtime, parse, { authorization: "Bearer wrong-token-value" });
  await runtime.handleRequest({
    method: "POST",
    path: "/gw",
    body: { method: "ping", params: {} },
  });

  const joined = logs.join("\n");
  assert.match(joined, /surface=mcp reason=invalid fingerprint=sha256:[0-9a-f]{12}/);
  assert.match(joined, /surface=gw reason=missing fingerprint=-/);
  assert.ok(!joined.includes("wrong-token-value"), "log must not contain the presented token");
  assert.ok(!joined.includes(KEY), "log must not contain the configured key");
});
