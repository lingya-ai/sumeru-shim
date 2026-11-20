import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync, rmSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROFILE_LOCK_FILES, clearStaleProfileLock } from "../src/profile-lock.mjs";

function makeProfile() {
  const dir = mkdtempSync(join(tmpdir(), "sumeru-profile-"));
  for (const name of PROFILE_LOCK_FILES) {
    writeFileSync(join(dir, name), "stale");
  }
  writeFileSync(join(dir, "Preferences"), "{}");
  return dir;
}

/** The real-world shape: Chrome writes SingletonLock as a DANGLING symlink to
 *  "<hostname>-<pid>", so a follow-the-link existence check reports false. */
function makeDanglingLockProfile() {
  const dir = mkdtempSync(join(tmpdir(), "sumeru-profile-dangling-"));
  symlinkSync("c23e7339170b-28", join(dir, "SingletonLock"));
  symlinkSync("/tmp/org.chromium.Chromium.abc/SingletonSocket", join(dir, "SingletonSocket"));
  symlinkSync("17485470977568158874", join(dir, "SingletonCookie"));
  writeFileSync(join(dir, "Preferences"), "{}");
  return dir;
}

test("悬空符号链接形态的单例文件也能清掉（容器重建后的真实形态）", (t) => {
  let dir;
  try {
    dir = makeDanglingLockProfile();
  } catch (error) {
    // Windows 创建符号链接需要开发者模式/管理员；容器（Linux）侧覆盖同一路径。
    if (error.code === "EPERM") {
      t.skip("symlink requires privileges on this Windows host; covered on Linux/containers");
      return;
    }
    throw error;
  }
  // 前提校验：existsSync 会跟随链接，看不见这些文件——这正是最初漏删的原因。
  assert.equal(existsSync(join(dir, "SingletonLock")), false);
  const removed = clearStaleProfileLock(dir);
  assert.equal(removed.length, 3);
  for (const name of PROFILE_LOCK_FILES) {
    assert.throws(() => lstatSync(join(dir, name)), `${name} should be unlinked`);
  }
  assert.equal(existsSync(join(dir, "Preferences")), true);
  rmSync(dir, { recursive: true, force: true });
});

test("存在性判断用 lstat 语义：跟随链接会漏判，注入 existsImpl 必须被用上", () => {
  const probed = [];
  const removed = clearStaleProfileLock("/data/profile", {
    existsImpl: (path) => {
      probed.push(path);
      return false; // 模拟「看不见」
    },
    removeImpl: () => {
      throw new Error("must not be called");
    },
  });
  assert.deepEqual(removed, []);
  assert.equal(probed.length, 3, "每一类锁都要探测一次");
  for (const name of PROFILE_LOCK_FILES) {
    assert.ok(
      probed.some((path) => path === join("/data/profile", name)),
      `expected a probe for ${name}, got ${JSON.stringify(probed)}`,
    );
  }
});

test("清掉三个 Chromium 单例文件，保留 profile 内容", () => {
  const dir = makeProfile();
  const removed = clearStaleProfileLock(dir);
  assert.equal(removed.length, 3);
  for (const name of PROFILE_LOCK_FILES) {
    assert.equal(existsSync(join(dir, name)), false, `${name} should be gone`);
  }
  assert.equal(existsSync(join(dir, "Preferences")), true, "profile data must survive");
  rmSync(dir, { recursive: true, force: true });
});

test("目录里没有锁时是 no-op，不报错", () => {
  const dir = mkdtempSync(join(tmpdir(), "sumeru-profile-empty-"));
  assert.deepEqual(clearStaleProfileLock(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

test("SUMERU_CLEAR_PROFILE_LOCK=0 等价于 enabled:false，锁保持原样", () => {
  const dir = makeProfile();
  const removed = clearStaleProfileLock(dir, { enabled: false });
  assert.deepEqual(removed, []);
  for (const name of PROFILE_LOCK_FILES) {
    assert.equal(existsSync(join(dir, name)), true);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("空/未配置 profileDir 直接返回，不抛 TypeError", () => {
  assert.deepEqual(clearStaleProfileLock(undefined), []);
  assert.deepEqual(clearStaleProfileLock(""), []);
});

test("删除失败不抛出（清锁不是致命路径）", () => {
  const removed = clearStaleProfileLock("/tmp/whatever", {
    existsImpl: () => true,
    removeImpl: () => {
      throw new Error("EPERM");
    },
  });
  assert.deepEqual(removed, []);
});

test("onRemove 报告每个被删路径", () => {
  const dir = makeProfile();
  const seen = [];
  clearStaleProfileLock(dir, { onRemove: (path) => seen.push(path) });
  assert.equal(seen.length, 3);
  assert.ok(seen.every((path) => path.startsWith(dir)));
  rmSync(dir, { recursive: true, force: true });
});