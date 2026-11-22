// IME fail-fast（gateway /  /  缺陷修复）：
//   SUMERU_IME=fcitx 而镜像里没有 fcitx5 二进制 → 启动即报错退出。
//
// 验证对象是 `bin/start-all.sh` 里真正会被执行的那段逻辑：测试直接从脚本里
// 抽出 `require_ime_binary()` 定义，用 bash 跑它（不启动 Xvnc/chrome）。
// 没有 bash 的机器（纯 Windows）静默跳过行为用例，但仍保留静态断言。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const START_ALL = fileURLToPath(new URL("../bin/start-all.sh", import.meta.url));

/** 在 PATH 里找可执行文件（避免依赖子进程的 PATH 解析）。 */
function resolveExecutable(name) {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of (process.env.PATH ?? "").split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const BASH = resolveExecutable("bash");

function bashRun(script, env = {}) {
  // 用 stdin 传脚本：避免把 Windows 路径当 WSL 脚本路径传进去。
  return spawnSync(BASH, [], {
    input: script,
    encoding: "utf8",
    env: { HOME: "/tmp", ...env },
  });
}

/** 从 start-all.sh 抽出 require_ime_binary() 的完整定义（归一化 CRLF）。 */
function requireImeBinarySource() {
  const source = readFileSync(START_ALL, "utf8").replace(/\r\n/g, "\n");
  const match = source.match(/require_ime_binary\(\) \{\n([\s\S]*?)\n\}\n/);
  assert.ok(match, "bin/start-all.sh 里必须有 require_ime_binary() 定义");
  return `require_ime_binary() {\n${match[1]}\n}\n`;
}

test("start-all.sh：IME fail-fast 存在且在拉起 chrome 之前执行（静态）", () => {
  const source = readFileSync(START_ALL, "utf8").replace(/\r\n/g, "\n");
  const definitionAt = source.indexOf("require_ime_binary() {");
  const callAt = source.indexOf("\nrequire_ime_binary\n");
  assert.ok(definitionAt >= 0, "缺 require_ime_binary() 定义");
  assert.ok(callAt > definitionAt, "定义了但没有调用");
  // 必须在显示服务/浏览器之前 fail-fast（早失败才有意义）
  const displayAt = source.indexOf("\nXvnc \"${xvnc_args[@]}\"");
  assert.ok(displayAt >= 0, "找不到 Xvnc 启动行");
  assert.ok(displayAt > callAt, "fail-fast 必须在启动 Xvnc/chrome 之前");
  assert.match(source, /command -v fcitx5/);
  assert.match(source, /SUMERU_IME:-0/);
  assert.match(source, /exit 1/);
});

test("start-all.sh：SUMERU_IME=fcitx 且 fcitx5 缺失 → 报错退出（行为）", (t) => {
  if (!BASH) return t.skip("bash not available");
  const result = bashRun(
    `${requireImeBinarySource()}
PATH=/nonexistent-sumeru-bin
SUMERU_IME=fcitx
require_ime_binary
echo REACHED_END
`,
  );
  assert.notEqual(result.status, 0, "缺 fcitx5 时必须非零退出");
  assert.match(result.stderr, /fail-fast/);
  assert.match(result.stderr, /fcitx5/);
  assert.doesNotMatch(result.stdout, /REACHED_END/, "退出必须发生在后续启动步骤之前");
});

test("start-all.sh：未设 SUMERU_IME → 不体检（无 fcitx5 也照常继续）", (t) => {
  if (!BASH) return t.skip("bash not available");
  const result = bashRun(
    `${requireImeBinarySource()}
PATH=/nonexistent-sumeru-bin
require_ime_binary
echo REACHED_END
`,
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /REACHED_END/);
});

test("start-all.sh：SUMERU_IME=1（ibus 路径）不触发 fcitx fail-fast", (t) => {
  if (!BASH) return t.skip("bash not available");
  const result = bashRun(
    `${requireImeBinarySource()}
PATH=/nonexistent-sumeru-bin
SUMERU_IME=1
require_ime_binary
echo REACHED_END
`,
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /REACHED_END/);
});

test("start-all.sh：SUMERU_IME=fcitx 且 fcitx5 存在 → 继续启动（正向）", (t) => {
  if (!BASH) return t.skip("bash not available");
  // 在 bash 自己的文件系统里造一个可执行的假 fcitx5（跨平台：不依赖 Windows 侧路径映射）
  const setup = bashRun(
    `mkdir -p /tmp/sumeru-ime-bin && printf '#!/bin/sh\\nexit 0\\n' > /tmp/sumeru-ime-bin/fcitx5 && chmod +x /tmp/sumeru-ime-bin/fcitx5 && echo SETUP_OK`,
  );
  if (setup.status !== 0 || !/SETUP_OK/.test(setup.stdout ?? "")) {
    return t.skip(`cannot stage fake fcitx5 (${setup.stderr?.trim() || setup.status})`);
  }
  const result = bashRun(
    `${requireImeBinarySource()}
PATH=/tmp/sumeru-ime-bin
SUMERU_IME=fcitx
require_ime_binary
echo REACHED_END
`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /REACHED_END/);
});
