// MCP server 集成测试（gateway / §4.5）：工具面 = gateway 方法 1:1。
//
// 起一个假 gateway（POST /gw 回显 method/params），通过 stdio 发 JSON-RPC，验证：
// 握手、12 个工具清单、方法/参数直译、结果透传、错误码透传、鉴权头、未知工具。

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

const MCP = fileURLToPath(new URL("../bin/sumeru-mcp.mjs", import.meta.url));

const EXPECTED_TOOLS = [
  "activate_tab",
  "capture_page",
  "close_tab",
  "create_tab",
  "dispatch_key",
  "dispatch_mouse",
  "evaluate_target",
  "ime_compose",
  "list_tabs",
  "navigate_target",
  "ping",
  "snapshot_ax",
];

/** 假 gateway：POST /gw 回 {ok:true, result:{echo}}；expression 含 boom 时回错误包。 */
async function startFakeGateway() {
  const received = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ url: req.url, headers: req.headers, body });
      res.setHeader("content-type", "application/json");
      if (req.url !== "/gw") {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      const payload = body ? JSON.parse(body) : {};
      if (String(payload?.params?.expression ?? "").includes("boom")) {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            ok: false,
            method: payload.method,
            error: { code: "SUMERU_EVALUATE_FAILED", message: "求值炸了" },
          }),
        );
        return;
      }
      res.writeHead(200);
      res.end(
        JSON.stringify({
          ok: true,
          method: payload.method,
          result: { method: payload.method, params: payload.params ?? null },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, received };
}

/** 启动 MCP 子进程，返回 { call, close }。 */
function startMcp(gateUrl) {
  const child = spawn(process.execPath, [MCP, "--gate", gateUrl, "--key", "sumeru_sk_test"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id != null) responses.set(msg.id, msg);
    }
  });

  let nextId = 1;
  return {
    child,
    async call(method, params) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      const started = Date.now();
      while (!responses.has(id)) {
        if (Date.now() - started > 5000) throw new Error(`等 ${method} 响应超时`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return responses.get(id);
    },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}

test("MCP：initialize 返回协议版本与 serverInfo", async () => {
  const gate = await startFakeGateway();
  const mcp = startMcp(`http://127.0.0.1:${gate.port}`);
  try {
    const res = await mcp.call("initialize", {});
    assert.equal(res.result.protocolVersion, "2024-11-05");
    assert.equal(res.result.serverInfo.name, "sumeru-mcp");
    assert.ok(res.result.capabilities.tools);
  } finally {
    mcp.close();
    gate.server.close();
  }
});

test("MCP：tools/list = gateway 方法 1:1（12 个工具，每个有 inputSchema）", async () => {
  const gate = await startFakeGateway();
  const mcp = startMcp(`http://127.0.0.1:${gate.port}`);
  try {
    const res = await mcp.call("tools/list", {});
    const names = res.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, EXPECTED_TOOLS);
    for (const tool of res.result.tools) {
      assert.equal(tool.inputSchema.type, "object", tool.name);
      assert.equal(typeof tool.description, "string");
      assert.ok(tool.description.length > 0, tool.name);
    }
    // 旧的 /round 时代工具随收缩删除
    const removed = ["sumeru_round", "sumeru_snapshot", "sumeru_visual", "sumeru_spaces"];
    for (const name of removed) assert.ok(!names.includes(name), name);
  } finally {
    mcp.close();
    gate.server.close();
  }
});

test("MCP：evaluate_target → gateway evaluateTarget（方法/参数直译）", async () => {
  const gate = await startFakeGateway();
  const mcp = startMcp(`http://127.0.0.1:${gate.port}`);
  try {
    const res = await mcp.call("tools/call", {
      name: "evaluate_target",
      arguments: { targetId: "T1", expression: "1+1", ignored: "drop-me" },
    });
    assert.notEqual(res.result.isError, true);
    const text = res.result.content[0].text;
    const parsed = JSON.parse(text);
    assert.equal(parsed.method, "evaluateTarget");
    assert.deepEqual(parsed.params, { targetId: "T1", expression: "1+1" });

    const forwarded = gate.received.find((entry) => entry.url === "/gw");
    assert.deepEqual(JSON.parse(forwarded.body), {
      method: "evaluateTarget",
      params: { targetId: "T1", expression: "1+1" }, // 未声明的键被丢弃
    });
    assert.equal(forwarded.headers["x-sumeru-token"], "sumeru_sk_test");
  } finally {
    mcp.close();
    gate.server.close();
  }
});

test("MCP：ping / list_tabs / dispatch_key 都原样翻译成 gateway 方法", async () => {
  const gate = await startFakeGateway();
  const mcp = startMcp(`http://127.0.0.1:${gate.port}`);
  try {
    const cases = [
      ["ping", {}, "ping", {}],
      ["list_tabs", {}, "listTabs", {}],
      [
        "dispatch_key",
        { targetId: "T1", type: "keyDown", key: "Enter", code: "Enter" },
        "dispatchKey",
        { targetId: "T1", type: "keyDown", key: "Enter", code: "Enter" },
      ],
      [
        "ime_compose",
        { targetId: "T1", text: "nihao", commit: "你好" },
        "imeCompose",
        { targetId: "T1", text: "nihao", commit: "你好" },
      ],
      ["capture_page", { targetId: "T2" }, "captureScreenshot", { targetId: "T2" }],
      ["snapshot_ax", { targetId: "T2" }, "snapshotAX", { targetId: "T2" }],
    ];
    for (const [tool, input, method, params] of cases) {
      const res = await mcp.call("tools/call", { name: tool, arguments: input });
      assert.notEqual(res.result.isError, true, tool);
      const parsed = JSON.parse(res.result.content[0].text);
      assert.equal(parsed.method, method, tool);
      assert.deepEqual(parsed.params, params, tool);
    }
  } finally {
    mcp.close();
    gate.server.close();
  }
});

test("MCP：内核错误包 → isError=true 且带错误码与原文", async () => {
  const gate = await startFakeGateway();
  const mcp = startMcp(`http://127.0.0.1:${gate.port}`);
  try {
    const res = await mcp.call("tools/call", {
      name: "evaluate_target",
      arguments: { targetId: "T1", expression: "boom()" },
    });
    assert.equal(res.result.isError, true);
    const text = res.result.content[0].text;
    assert.match(text, /SUMERU_EVALUATE_FAILED/);
    assert.match(text, /求值炸了/);
  } finally {
    mcp.close();
    gate.server.close();
  }
});

test("MCP：错误键（gateway 不存在）如实报错，不假装成功", async () => {
  // 指向一个必定连不上的端口
  const mcp = startMcp("http://127.0.0.1:1");
  try {
    const res = await mcp.call("tools/call", { name: "ping", arguments: {} });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /工具失败/);
  } finally {
    mcp.close();
  }
});

test("MCP：未知工具返回 isError", async () => {
  const gate = await startFakeGateway();
  const mcp = startMcp(`http://127.0.0.1:${gate.port}`);
  try {
    const res = await mcp.call("tools/call", { name: "no_such_tool", arguments: {} });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /未知工具/);
  } finally {
    mcp.close();
    gate.server.close();
  }
});
