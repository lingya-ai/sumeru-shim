// 退出语义（exit semantics）：chrome 退出 ⇒ shim exit(1) ⇒ 容器退出 ⇒ 编排器拉新代。
// 收缩后没有 CDP pipe 可探，chrome 的 exit/error 事件是唯一权威信号。
//
// child_process 用 mock：假的 child 是 EventEmitter，spawn 注入点直接给 fake。

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { attachExitSemantics, CHROME_EXIT_CODE, spawnChrome, start } from "../src/index.mjs";
import { loadConfig } from "../src/runtime.mjs";

/** 假 child：只有 once/emit（attachExitSemantics 只用 once）。 */
function fakeChild(overrides = {}) {
  const child = new EventEmitter();
  child.kill = () => {};
  Object.assign(child, overrides);
  return child;
}

function spyExit() {
  const codes = [];
  return { codes, exit: (code) => codes.push(code) };
}

test("chrome exit → exit(1)（code/signal 都不影响容器退出码）", () => {
  const { codes, exit } = spyExit();
  const child = fakeChild();
  attachExitSemantics(child, { exit, log: () => {} });
  child.emit("exit", 0, null); // 正常关闭也是「浏览器没了」
  assert.deepEqual(codes, [CHROME_EXIT_CODE]);
  assert.equal(CHROME_EXIT_CODE, 1);
});

test("chrome 崩溃（非零 code / 信号）同样 exit(1)", () => {
  const { codes, exit } = spyExit();
  const child = fakeChild();
  attachExitSemantics(child, { exit, log: () => {} });
  child.emit("exit", 139, "SIGSEGV");
  assert.deepEqual(codes, [1]);
});

test("exit 只触发一次（once 语义；第二次 exit 事件不重复退出）", () => {
  const { codes, exit } = spyExit();
  const child = fakeChild();
  attachExitSemantics(child, { exit, log: () => {} });
  child.emit("exit", 0, null);
  child.emit("exit", 0, null);
  assert.deepEqual(codes, [1]);
});

test("优雅关停期间 chrome 退出不得 exit(1)（否则重启会被记成崩溃）", () => {
  const { codes, exit } = spyExit();
  let shuttingDown = true;
  const child = fakeChild();
  attachExitSemantics(child, { exit, isShuttingDown: () => shuttingDown, log: () => {} });
  child.emit("exit", 0, "SIGTERM");
  assert.deepEqual(codes, []);

  // 同一套装配在非关停状态下仍然 exit(1)
  shuttingDown = false;
  const normal = fakeChild();
  attachExitSemantics(normal, { exit, isShuttingDown: () => shuttingDown, log: () => {} });
  normal.emit("exit", 0, null);
  assert.deepEqual(codes, [1]);
});

test("chrome spawn 失败（error 事件）→ exit(1)，不是静默挂起", () => {
  const { codes, exit } = spyExit();
  const logs = [];
  const child = fakeChild();
  attachExitSemantics(child, { exit, log: (message) => logs.push(message) });
  child.emit("error", new Error("ENOENT: chrome"));
  assert.deepEqual(codes, [1]);
  assert.match(logs[0], /chrome failed/);
});

test("退出日志带 code/signal（诊断需要，不能只有退出码）", () => {
  const logs = [];
  const child = fakeChild();
  attachExitSemantics(child, { exit: () => {}, log: (message) => logs.push(message) });
  child.emit("exit", 137, "SIGKILL");
  assert.match(logs[0], /code=137/);
  assert.match(logs[0], /signal=SIGKILL/);
});

test("spawnChrome：无 CDP 参数 + 原生窗口几何 + 无 fd3/4（旧 CDP 通道的坑）", () => {
  const config = loadConfig({ SUMERU_HEADLESS: "0" });
  const calls = [];
  const spawnFn = (path, args, options) => {
    calls.push({ path, args, options });
    return fakeChild();
  };
  spawnChrome({ config, spawnFn });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.path, config.chromePath);
  assert.deepEqual(call.args, config.chromeArgs);
  assert.ok(call.args.includes("--window-position=0,0"));
  // 几何跟随 SUMERU_SCREEN（默认 1K），不再写死 1280,800
  assert.ok(call.args.some((arg) => arg.startsWith("--window-size=")));
  assert.ok(call.args.includes("--window-size=1280,800"));
  assert.ok(!call.args.some((arg) => arg.includes("--remote-debugging")));
  // pipe 通道需要 fd3/fd4；收缩后 stdio 不应再要 5 个 fd
  assert.equal(call.options.stdio.length, 3);
});

test("spawnChrome / attachExitSemantics 的装配错误要早失败", () => {
  assert.throws(() => spawnChrome({}), /requires config/);
  assert.throws(() => attachExitSemantics(null), /requires a child process/);
  assert.throws(() => attachExitSemantics({}), /requires a child process/);
});

test("start()：装配 chrome + /healthz ready + /gw 透传 + chrome 退出 exit(1)", async () => {
  const child = fakeChild();
  const exits = [];
  const calls = [];
  const gatewayCalls = [];
  const gateway = {
    async request(method, params) {
      gatewayCalls.push({ method, params });
      return { pong: true };
    },
    isConnected: () => true,
    close() {},
  };
  const started = await start({
    env: {
      SHIM_PORT: "0", // 测试用随机端口
      SUMERU_READY_TIMEOUT_MS: "2000",
      SUMERU_READY_POLL_MS: "10",
      SUMERU_HEADLESS: "0",
    },
    spawnFn: (path, args, options) => {
      calls.push({ path, args, options });
      return child;
    },
    gatewayFactory: () => gateway,
    exit: (code) => exits.push(code),
  });

  try {
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].args.some((arg) => arg.includes("--remote-debugging")));

    const { port } = started.server.address();
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    const healthBody = await health.json();
    assert.equal(health.status, 200);
    assert.equal(healthBody.ready, true);
    assert.deepEqual(Object.keys(healthBody.layers), [
      "x",
      "synth",
      "webui",
      "gateway",
      "kernel",
      "window",
      "vnc",
      "ime",
    ]);

    const gw = await fetch(`http://127.0.0.1:${port}/gw`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "ping", params: {} }),
    });
    const gwBody = await gw.json();
    assert.equal(gwBody.ok, true);
    assert.deepEqual(gwBody.result, { pong: true });
    // 第一次是就绪探针，最后一次是 /gw 的透传
    assert.ok(gatewayCalls.length >= 2);
    assert.deepEqual(gatewayCalls[0], { method: "ping", params: {} });
    assert.deepEqual(gatewayCalls.at(-1), { method: "ping", params: {} });

    // 收缩掉的旧路由必须 404
    const dead = await fetch(`http://127.0.0.1:${port}/round`, { method: "POST", body: "{}" });
    assert.equal(dead.status, 404);

    // chrome 退出 → exit(1)
    assert.deepEqual(exits, []);
    child.emit("exit", 0, null);
    assert.deepEqual(exits, [1]);
  } finally {
    started.server.close();
  }
});
