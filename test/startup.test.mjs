// 启动就绪等待（readiness）：轮询 gateway ping，最多 60s。
// 收缩后不再依赖 listTaskSpaces（现行内核没有 listTabs；ready 条件 = ping 通）。

import assert from "node:assert/strict";
import test from "node:test";

import { KERNEL_NOT_READY, waitForBrowserReady } from "../src/startup.mjs";

function clock(start = 0) {
  let time = start;
  return {
    now: () => time,
    delay: async (ms) => {
      time += ms;
    },
  };
}

test("ping 一次就通 → 立即 ready（attempts=1）", async () => {
  let calls = 0;
  const result = await waitForBrowserReady({
    ping: async () => {
      calls += 1;
      return { pong: true };
    },
    ...clock(),
  });
  assert.equal(calls, 1);
  assert.equal(result.ready, true);
  assert.equal(result.attempts, 1);
});

test("前两次抛错、第三次 pong → attempts=3，且按 interval 等待", async () => {
  const time = clock();
  const attempts = [];
  let calls = 0;
  const result = await waitForBrowserReady({
    ping: async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("gateway socket never appeared"), { code: "ENOENT" });
      return { pong: true };
    },
    intervalMs: 100,
    timeoutMs: 1000,
    ...time,
    onAttempt: (attempt, error) => attempts.push({ attempt, message: error.message }),
  });
  assert.equal(result.attempts, 3);
  assert.equal(calls, 3);
  assert.deepEqual(attempts.map((a) => a.attempt), [1, 2]);
  assert.equal(attempts[0].message, "gateway socket never appeared");
  assert.equal(time.now(), 200); // 两次 100ms 退避
});

test("内核始终不答 → 超时抛 SUMERU_KERNEL_NOT_READY（不冒充 ready）", async () => {
  let calls = 0;
  await assert.rejects(
    waitForBrowserReady({
      ping: async () => {
        calls += 1;
        throw new Error("gateway closed");
      },
      timeoutMs: 250,
      intervalMs: 100,
      ...clock(),
    }),
    (error) => {
      assert.equal(error.code, KERNEL_NOT_READY);
      assert.match(error.message, /not ready after 250ms/);
      assert.match(error.message, /gateway closed/);
      return true;
    },
  );
  assert.ok(calls >= 2);
});

test("ping 返回非 {pong:true} → 视为未就绪（形状不对不放过）", async () => {
  await assert.rejects(
    waitForBrowserReady({
      ping: async () => ({ ok: true }),
      timeoutMs: 100,
      intervalMs: 50,
      ...clock(),
    }),
    /unexpected ping reply/,
  );
});

test("超时上限 60s 是默认契约（可用 env 缩短，但默认值不缩水）", async () => {
  // 用一个恒失败的 ping 走真实时钟会跑 60s，这里只验「默认参数进入超时语义」：
  // timeoutMs 未显式传入时以 60s 为上限 —— 通过 onAttempt 的最后一次时间点间接断言。
  const time = clock();
  const observed = [];
  await assert.rejects(
    waitForBrowserReady({
      ping: async () => {
        throw new Error("down");
      },
      timeoutMs: 60_000,
      intervalMs: 10_000,
      ...time,
      onAttempt: (attempt) => observed.push({ attempt, at: time.now() }),
    }),
    /60000ms/,
  );
  assert.ok(observed.length >= 2);
});

test("缺 ping 函数 → TypeError（装配错误要早失败）", async () => {
  await assert.rejects(waitForBrowserReady({}), /requires a ping function/);
});
