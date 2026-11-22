// 认证内核：凭据加载、常量时间校验、挑战头、子进程 env 剥离。
//
// 行为契约见 docs/auth.md §4/§5.4：单值、只在内存、不落盘、重启以当次配置为准。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AUTH_CONFIG_ERROR_CODE,
  AUTH_ENV_VARS,
  MAX_TOKEN_BYTES,
  OPEN_AUTH,
  bearerToken,
  challengeHeaders,
  deleteAuthEnv,
  describeAuth,
  fingerprint,
  loadAuthConfig,
  presentedToken,
  sanitizeChildEnv,
  validateApiKey,
  verifyCredential,
} from "../src/auth.mjs";

const KEY = "a".repeat(48);

/** 临时 secret 文件（测试自己清理）。 */
function secretFile(content) {
  const dir = mkdtempSync(join(tmpdir(), "sumeru-auth-"));
  const path = join(dir, "key");
  writeFileSync(path, content, { mode: 0o600 });
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("loadAuthConfig：空配置 = 开放（/gw 与 /mcp 都放行）", () => {
  const auth = loadAuthConfig({});
  assert.equal(auth.configured, false);
  assert.equal(auth.enforceGateway, false);
  assert.equal(auth.enforceMcp, false);
  assert.equal(auth.digest, null);
  assert.equal(auth.source, "none");
  assert.equal(auth.mode, "auto");
  assert.deepEqual(auth.warnings, []);
  assert.deepEqual(describeAuth(auth), { gw: "open", mcp: "open", mcpMode: "auto" });
});

test("loadAuthConfig：设置 key 后 /gw 与 /mcp 都强制（auto 默认）", () => {
  const auth = loadAuthConfig({ SUMERU_API_KEY: KEY });
  assert.equal(auth.configured, true);
  assert.equal(auth.enforceGateway, true);
  assert.equal(auth.enforceMcp, true);
  assert.equal(auth.source, "env");
  assert.equal(auth.digest.length, 32); // sha256
  assert.deepEqual(describeAuth(auth), { gw: "token", mcp: "token", mcpMode: "auto" });
});

test("loadAuthConfig：SUMERU_MCP_AUTH=off 只放开 /mcp，/gw 仍要凭据", () => {
  const auth = loadAuthConfig({ SUMERU_API_KEY: KEY, SUMERU_MCP_AUTH: "off" });
  assert.equal(auth.enforceGateway, true);
  assert.equal(auth.enforceMcp, false);
  assert.deepEqual(describeAuth(auth), { gw: "token", mcp: "open", mcpMode: "off" });
});

test("loadAuthConfig：required 但没配 key → 配置错误", () => {
  assert.throws(
    () => loadAuthConfig({ SUMERU_MCP_AUTH: "required" }),
    (error) => error.code === AUTH_CONFIG_ERROR_CODE,
  );
});

test("loadAuthConfig：未知 mode → 配置错误", () => {
  assert.throws(
    () => loadAuthConfig({ SUMERU_MCP_AUTH: "whatever", SUMERU_API_KEY: KEY }),
    (error) => error.code === AUTH_CONFIG_ERROR_CODE && /SUMERU_MCP_AUTH/.test(error.message),
  );
});

test("loadAuthConfig：短 key 告警但不阻止启动", () => {
  const auth = loadAuthConfig({ SUMERU_API_KEY: "short" });
  assert.equal(auth.enforceGateway, true);
  assert.equal(auth.warnings.length, 1);
  assert.match(auth.warnings[0], /shorter than/);
});

test("validateApiKey：空白 / 逗号 / 超长都是配置错误", () => {
  assert.equal(validateApiKey(""), "");
  assert.throws(() => validateApiKey("has space"), (e) => e.code === AUTH_CONFIG_ERROR_CODE);
  assert.throws(() => validateApiKey("tab\there"), (e) => e.code === AUTH_CONFIG_ERROR_CODE);
  assert.throws(() => validateApiKey("a,b"), (e) => e.code === AUTH_CONFIG_ERROR_CODE);
  assert.throws(
    () => validateApiKey("x".repeat(MAX_TOKEN_BYTES + 1)),
    (e) => e.code === AUTH_CONFIG_ERROR_CODE,
  );
});

test("loadAuthConfig：_FILE 优先于 env，并给出告警；行尾换行被去掉", () => {
  const file = secretFile(`${KEY}\n`);
  try {
    const auth = loadAuthConfig({
      SUMERU_API_KEY: "from-env-token-value",
      SUMERU_API_KEY_FILE: file.path,
    });
    assert.equal(auth.source, "file");
    assert.equal(auth.configured, true);
    assert.ok(auth.warnings.some((w) => /file wins/.test(w)));
    // 行尾换行被去掉后，用文件里的 key 能通过校验
    assert.equal(verifyCredential({ authorization: `Bearer ${KEY}` }, auth).ok, true);
  } finally {
    file.cleanup();
  }
});

test("loadAuthConfig：_FILE 读不到 → 配置错误（不静默降级成无认证）", () => {
  assert.throws(
    () => loadAuthConfig({ SUMERU_API_KEY_FILE: join(tmpdir(), "sumeru-missing-key") }),
    (error) => error.code === AUTH_CONFIG_ERROR_CODE,
  );
});

test("bearerToken：scheme 大小写/多空白/重复头都按规范处理", () => {
  assert.equal(bearerToken({ authorization: `Bearer ${KEY}` }), KEY);
  assert.equal(bearerToken({ authorization: `bearer ${KEY}` }), KEY);
  assert.equal(bearerToken({ authorization: `  BEARER\t${KEY}  ` }), KEY);
  assert.equal(bearerToken({ authorization: `Bearer ${KEY}, Bearer other` }), KEY);
  assert.equal(bearerToken({ authorization: "Basic Zm9vOmJhcg==" }), null);
  assert.equal(bearerToken({ authorization: "Bearer " }), null);
  assert.equal(bearerToken({}), null);
});

test("presentedToken：Bearer 优先，回退 X-Sumeru-Token", () => {
  assert.equal(presentedToken({ authorization: `Bearer ${KEY}` }), KEY);
  assert.equal(presentedToken({ Authorization: `Bearer ${KEY}` }), KEY);
  assert.equal(presentedToken({ "x-sumeru-token": KEY }), KEY);
  assert.equal(presentedToken({ "X-Sumeru-Token": KEY }), KEY);
  assert.equal(presentedToken({ "x-sumeru-token": [KEY] }), KEY);
  assert.equal(
    presentedToken({ authorization: `Bearer ${KEY}`, "x-sumeru-token": "other" }),
    KEY,
  );
  assert.equal(presentedToken({ "x-sumeru-token": "   " }), null);
  assert.equal(presentedToken({}), null);
});

test("verifyCredential：正确 / 缺失 / 错误 / 超长 / Basic scheme", () => {
  const auth = loadAuthConfig({ SUMERU_API_KEY: KEY });
  assert.deepEqual(verifyCredential({ authorization: `Bearer ${KEY}` }, auth), { ok: true });
  assert.deepEqual(verifyCredential({ "x-sumeru-token": KEY }, auth), { ok: true });

  assert.equal(verifyCredential({}, auth).reason, "missing");
  assert.equal(
    verifyCredential({ authorization: `Bearer ${KEY}x` }, auth).reason,
    "invalid",
  );
  assert.equal(
    verifyCredential({ authorization: `Basic ${KEY}` }, auth).reason,
    "missing",
  );
  assert.equal(
    verifyCredential({ authorization: `Bearer ${"z".repeat(MAX_TOKEN_BYTES + 1)}` }, auth)
      .reason,
    "invalid",
  );
  // 同一前缀不同长度的 token 也必须判无效（digest 长度恒定，不靠长度分支）
  assert.equal(verifyCredential({ "x-sumeru-token": KEY.slice(0, 8) }, auth).ok, false);
});

test("verifyCredential：失败只回指纹，不回显 token", () => {
  const auth = loadAuthConfig({ SUMERU_API_KEY: KEY });
  const result = verifyCredential({ "x-sumeru-token": "wrong-token-value" }, auth);
  assert.equal(result.ok, false);
  assert.match(result.fingerprint, /^sha256:[0-9a-f]{12}$/);
  assert.ok(!JSON.stringify(result).includes("wrong-token-value"));
  assert.ok(!fingerprint(KEY).includes(KEY));
});

test("challengeHeaders：无凭据不带 error，凭据无效带 invalid_token", () => {
  const auth = loadAuthConfig({ SUMERU_API_KEY: KEY });
  assert.deepEqual(challengeHeaders(auth), {
    "www-authenticate": 'Bearer realm="sumeru"',
  });
  assert.deepEqual(challengeHeaders(auth, { error: "invalid_token" }), {
    "www-authenticate": 'Bearer realm="sumeru", error="invalid_token"',
  });
  assert.equal(challengeHeaders(OPEN_AUTH)["www-authenticate"], 'Bearer realm="sumeru"');
});

test("sanitizeChildEnv：剔除认证变量，保留 SUMERU_GATEWAY_TOKEN 等", () => {
  const env = {
    SUMERU_API_KEY: KEY,
    SUMERU_API_KEY_FILE: "/run/secrets/key",
    SUMERU_VNC_PASSWORD: "vncpass8",
    SUMERU_VNC_PASSWORD_FILE: "/run/secrets/vnc",
    SUMERU_GATEWAY_TOKEN: "gw-token",
    PATH: "/usr/bin",
  };
  const child = sanitizeChildEnv(env);
  for (const name of AUTH_ENV_VARS) assert.equal(child[name], undefined);
  assert.equal(child.SUMERU_GATEWAY_TOKEN, "gw-token");
  assert.equal(child.PATH, "/usr/bin");
  // 原对象不被修改：抹除是单独一步（deleteAuthEnv）
  assert.equal(env.SUMERU_API_KEY, KEY);
});

test("deleteAuthEnv：抹掉本进程环境里的认证变量并返回有值的名字", () => {
  const env = {
    SUMERU_API_KEY: KEY,
    SUMERU_VNC_PASSWORD: "vncpass8",
    SUMERU_VNC_PASSWORD_FILE: "",
    PATH: "/usr/bin",
  };
  const removed = deleteAuthEnv(env);
  assert.deepEqual(removed.sort(), ["SUMERU_API_KEY", "SUMERU_VNC_PASSWORD"]);
  assert.equal(env.SUMERU_API_KEY, undefined);
  // 空串变量也会被删掉，但不值得在日志里点名
  assert.equal(env.SUMERU_VNC_PASSWORD_FILE, undefined);
  assert.equal(env.PATH, "/usr/bin");
  assert.deepEqual(deleteAuthEnv({}), []);
});
