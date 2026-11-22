// Streamable HTTP MCP surface: POST /mcp (stateless JSON-only).
import assert from "node:assert/strict";
import test from "node:test";
import { createRuntime } from "../src/runtime.mjs";

function makeRuntime() {
  const calls = [];
  const gateway = {
    isConnected: () => true,
    async request(method, params) {
      calls.push({ method, params });
      if (method === "captureScreenshot") {
        return { pngBase64: "aGVsbG8=", bytes: 5 };
      }
      return { method, params };
    },
  };
  const probes = {
    displayExists: () => true,
    socketExists: () => true,
    tcpListed: () => true,
  };
  const runtime = createRuntime({
    config: {
      display: "99",
      novncPort: 6901,
      vncPort: 5900,
      gatewaySocket: "/tmp/none.sock",
      ime: "",
      apiKey: "",
    },
    gateway,
    probes,
  });
  return { runtime, calls };
}

async function rpc(runtime, payload) {
  return runtime.handleRequest({
    method: "POST",
    path: "/mcp",
    body: payload,
    headers: {},
  });
}

test("HTTP MCP：initialize 使用 2025-06-18，只声明 tools", async () => {
  const { runtime } = makeRuntime();
  const out = await rpc(runtime, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  });
  assert.equal(out.status, 200);
  assert.equal(out.body.result.protocolVersion, "2025-06-18");
  assert.deepEqual(out.body.result.capabilities, { tools: {} });
  assert.equal(out.body.result.serverInfo.version, "0.5.0");
});

test("HTTP MCP：tools/list 返回 12 个工具", async () => {
  const { runtime } = makeRuntime();
  const out = await rpc(runtime, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.equal(out.status, 200);
  assert.equal(out.body.result.tools.length, 12);
  assert.ok(out.body.result.tools.some((t) => t.name === "capture_page"));
});

test("HTTP MCP：capture_page 返回 image content", async () => {
  const { runtime, calls } = makeRuntime();
  const out = await rpc(runtime, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "capture_page", arguments: { targetId: "T1" } },
  });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.result.content[0], {
    type: "image",
    data: "aGVsbG8=",
    mimeType: "image/png",
  });
  assert.deepEqual(calls.at(-1), {
    method: "captureScreenshot",
    params: { targetId: "T1" },
  });
});

test("HTTP MCP：通知返回 202 且无 body；GET 返回 405", async () => {
  const { runtime } = makeRuntime();
  const notified = await rpc(runtime, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(notified.status, 202);
  assert.equal(notified.empty, true);

  const get = await runtime.handleRequest({ method: "GET", path: "/mcp", headers: {} });
  assert.equal(get.status, 405);
  assert.equal(get.headers.allow, "POST");
});

test("HTTP MCP：未知方法返回 -32601", async () => {
  const { runtime } = makeRuntime();
  const out = await rpc(runtime, { jsonrpc: "2.0", id: 4, method: "resources/list", params: {} });
  assert.equal(out.status, 200);
  assert.equal(out.body.error.code, -32601);
});