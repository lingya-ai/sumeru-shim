// `POST /gw` 方法代理（gateway）：
// 方法名与参数原样到达 gateway，结果/错误码/错误信息原样回传，代理不翻译不改写。

import assert from "node:assert/strict";
import test from "node:test";

import { createRuntime, loadConfig } from "../src/runtime.mjs";

const probes = {
  displayExists: () => true,
  socketExists: () => true,
  tcpListed: () => true,
};

/** 假 gateway 客户端：记录 (method, params)，按 requestImpl 返回/抛错。 */
function harness({ requestImpl, env = {} } = {}) {
  const calls = [];
  const gateway = {
    async request(method, params) {
      calls.push({ method, params });
      if (requestImpl) return requestImpl(method, params);
      return { pong: true };
    },
    isConnected: () => true,
  };
  const runtime = createRuntime({ config: loadConfig(env), gateway, probes });
  return { runtime, calls, gateway };
}

function gw(runtime, body, headers) {
  return runtime.handleRequest({ method: "POST", path: "/gw", body, headers });
}

test("/gw：方法与参数原样到达 gateway（ping）", async () => {
  const { runtime, calls } = harness();
  const res = await gw(runtime, { method: "ping", params: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.method, "ping");
  assert.deepEqual(res.body.result, { pong: true });
  assert.deepEqual(calls, [{ method: "ping", params: {} }]);
});

test("/gw：嵌套参数零改写（对象/数组/数值原样透传）", async () => {
  const params = {
    targetId: "T-42",
    expression: 'JSON.stringify({a:[1,2,{b:true}]})',
    nested: { deep: [1, "two", null, false] },
    numeric: 0,
  };
  const echoed = [];
  const { runtime, calls } = harness({
    requestImpl: async (method, received) => {
      echoed.push(received);
      return { value: 2 };
    },
  });
  const res = await gw(runtime, { method: "evaluateTarget", params });
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.result, { value: 2 });
  assert.deepEqual(calls[0].method, "evaluateTarget");
  assert.deepEqual(echoed[0], params);
});

test("/gw：内核错误码与错误信息原样回传（不包装成新语义）", async () => {
  const { runtime } = harness({
    requestImpl: async () => {
      throw Object.assign(new Error("no such target: T-missing"), {
        code: "SUMERU_TARGET_NOT_FOUND",
      });
    },
  });
  const res = await gw(runtime, { method: "evaluateTarget", params: { targetId: "T-missing", expression: "1+1" } });
  assert.equal(res.status, 200); // 方法级错误不是 HTTP 级错误：代理保持透明
  assert.equal(res.body.ok, false);
  assert.equal(res.body.method, "evaluateTarget");
  assert.deepEqual(res.body.error, {
    code: "SUMERU_TARGET_NOT_FOUND",
    message: "no such target: T-missing",
  });
});

test("/gw：未知方法的错误也原样透传（未知方法不是代理的判断）", async () => {
  const { runtime, calls } = harness({
    requestImpl: async (method) => {
      throw Object.assign(new Error(`unknown gateway method: ${method}`), {
        code: "SUMERU_UNKNOWN_METHOD",
      });
    },
  });
  const res = await gw(runtime, { method: "noSuchMethod", params: { a: 1 } });
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error.code, "SUMERU_UNKNOWN_METHOD");
  assert.match(res.body.error.message, /noSuchMethod/);
  assert.equal(calls[0].method, "noSuchMethod");
});

test("/gw：不带 code 的错误退化为 SUMERU_OPERATION_FAILED（不丢错误信息）", async () => {
  const { runtime } = harness({
    requestImpl: async () => {
      throw new Error("gateway closed");
    },
  });
  const res = await gw(runtime, { method: "listTabs", params: {} });
  assert.equal(res.body.ok, false);
  assert.deepEqual(res.body.error, {
    code: "SUMERU_OPERATION_FAILED",
    message: "gateway closed",
  });
});

test("/gw：gateway 返回 undefined → result 归一为 null（响应形状稳定）", async () => {
  const { runtime } = harness({ requestImpl: async () => undefined });
  const res = await gw(runtime, { method: "ping", params: {} });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.result, null);
});

test("/gw：lastGatewayError 记录失败并在下次成功后清空", async () => {
  let fail = true;
  const { runtime } = harness({
    requestImpl: async () => {
      if (fail) throw Object.assign(new Error("kernel busy"), { code: "SUMERU_OPERATION_FAILED" });
      return { pong: true };
    },
  });
  await gw(runtime, { method: "ping", params: {} });
  assert.equal(runtime.lastGatewayError.code, "SUMERU_OPERATION_FAILED");
  assert.equal(runtime.healthz().gateway.lastError.message, "kernel busy");
  fail = false;
  await gw(runtime, { method: "ping", params: {} });
  assert.equal(runtime.lastGatewayError, null);
});

test("/gw：参数校验（缺 method / method 空 / params 非对象 / body 非对象 → 400）", async () => {
  const { runtime, calls } = harness();
  for (const [body, pattern] of [
    [undefined, /body must be a JSON object/],
    [{}, /method must be a non-empty string/],
    [{ method: "   " }, /method must be a non-empty string/],
    [{ method: 42 }, /method must be a non-empty string/],
    [{ method: "ping", params: [] }, /params must be a JSON object/],
    [{ method: "ping", params: "x" }, /params must be a JSON object/],
    [{ method: "ping", params: null }, /params must be a JSON object/],
    [[{ method: "ping" }], /body must be a JSON object/],
    ["ping", /body must be a JSON object/],
  ]) {
    const res = await gw(runtime, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, "SUMERU_INVALID_ARGUMENT");
    assert.match(res.body.error.message, pattern);
  }
  // 校验失败不得到达 gateway
  assert.equal(calls.length, 0);
});

test("/gw：params 缺省视为 {}（{method} 也能透传）", async () => {
  const { runtime, calls } = harness();
  const res = await gw(runtime, { method: "listTabs" });
  assert.equal(res.body.ok, true);
  assert.deepEqual(calls, [{ method: "listTabs", params: {} }]);
});

test("/gw：只接受 POST（GET/PUT/DELETE → 404）", async () => {
  const { runtime } = harness();
  for (const method of ["GET", "PUT", "DELETE"]) {
    const res = await runtime.handleRequest({ method, path: "/gw", body: { method: "ping" } });
    assert.equal(res.status, 404);
    assert.match(res.body.error, new RegExp(`no route: ${method} /gw`));
  }
});
