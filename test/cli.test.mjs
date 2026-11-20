import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The operator CLI is the entry point documented by the `sumeru-browser` skill
// (`.dsh/skills/sumeru-browser/SKILL.md`). These tests need no runtime: they
// pin the guide's markers and the failure exit codes, so a renamed method or a
// broken guide surfaces before an agent follows stale instructions.
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "sumeru.mjs");
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 20000 });

test("sumeru skill：打印用法指南，首行带版本、末行带结束标记", () => {
  const result = run("skill");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\[sumeru:skill\] sumeru kernel usage guide/);
  assert.match(result.stdout.trimEnd(), /\[sumeru:skill\] end of guide$/);
});

test("sumeru skill：指南覆盖 12 个 gateway 方法（防方法名漂移）", () => {
  const { stdout } = run("skill");
  for (const method of [
    "ping",
    "listTabs",
    "createTab",
    "closeTab",
    "activateTab",
    "navigateTarget",
    "evaluateTarget",
    "captureScreenshot",
    "snapshotAX",
    "dispatchKey",
    "dispatchMouse",
    "imeCompose",
  ]) {
    assert.ok(stdout.includes(method), `guide must mention ${method}`);
  }
});

test("未知命令：退出码 2，并列出可用命令", () => {
  const result = run("definitely-not-a-command");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command "definitely-not-a-command"/);
  assert.match(result.stderr, /commands: skill health ping tabs/);
});

test("缺参数：退出码 1 且提示 USAGE", () => {
  const result = run("open");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /USAGE: open <url>/);
});