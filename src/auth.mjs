/**
 * 认证内核（HTTP 面 `/gw` + `/mcp` 的唯一凭据实现）。
 *
 * 设计约束见 docs/auth.md：
 * - 凭据只在内存里以 `sha256` digest 形式存在，不落盘、不复制明文；
 * - 单值：`SUMERU_API_KEY` 整串即一个 token（不支持逗号多值）；
 * - 校验用 `crypto.timingSafeEqual` 比较 digest（长度恒定）；
 * - 失败只按"缺失 / 无效"两态返回，调用方负责 HTTP 语义（401 + WWW-Authenticate）；
 * - 认证变量在 spawn chrome 前必须剥离（`sanitizeChildEnv`），
 *   否则渲染进程的 `/proc/<pid>/environ` 里会有控制面凭据。
 *
 * 本模块不做任何 I/O 策略决定：读哪个环境变量、文件优先与否都写死在这里，
 * 由 `loadConfig` 调用一次，之后只读。
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

/** `SUMERU_MCP_AUTH` 的三个取值。 */
export const MCP_AUTH_MODES = Object.freeze(["auto", "required", "off"]);

/** 未显式配置 realm 时 `WWW-Authenticate` 里的值。 */
export const DEFAULT_REALM = "sumeru";

/** 凭据长度上限（字节）；超长直接判无效，避免对巨大输入做哈希。 */
export const MAX_TOKEN_BYTES = 512;

/** 短于此长度的 API key 会在启动时告警（不阻止启动）。 */
export const WEAK_TOKEN_LENGTH = 16;

/** 配置错误统一错误码（启动期抛出，由 index.mjs 打印后退出）。 */
export const AUTH_CONFIG_ERROR_CODE = "SUMERU_AUTH_CONFIG";

/**
 * 认证相关环境变量：读入内存后要从进程环境与子进程环境里剔除。
 * 注意 `SUMERU_GATEWAY_TOKEN` 不在列表里 —— chrome 需要它连 gateway。
 */
export const AUTH_ENV_VARS = Object.freeze([
  "SUMERU_API_KEY",
  "SUMERU_API_KEY_FILE",
  "SUMERU_VNC_PASSWORD",
  "SUMERU_VNC_PASSWORD_FILE",
]);

/** 未配置凭据时的认证状态（`/gw` 与 `/mcp` 都开放）。 */
export const OPEN_AUTH = Object.freeze({
  mode: "auto",
  realm: DEFAULT_REALM,
  source: "none",
  configured: false,
  enforceGateway: false,
  enforceMcp: false,
  digest: null,
  warnings: Object.freeze([]),
});

function configError(message) {
  return Object.assign(new Error(message), { code: AUTH_CONFIG_ERROR_CODE });
}

/** 只去掉一个行尾换行（文件写入器的默认产物），其余空白保留。 */
export function trimTrailingNewline(value) {
  return String(value).replace(/\r?\n$/, "");
}

function readSecretFile(path, label) {
  try {
    return trimTrailingNewline(readFileSync(path, "utf8"));
  } catch (error) {
    throw configError(`${label}: cannot read ${path}: ${error?.message ?? error}`);
  }
}

/**
 * 校验唯一凭据。空串表示"未配置"（返回空串），非法值抛出配置错误。
 *
 * 空串之外的空白/逗号/超长都当配置错误：复制粘贴多行或逗号串是最常见的误配，
 * 静默接受会让"配了但没生效"变成线上谜题。
 */
export function validateApiKey(value) {
  const token = String(value ?? "");
  if (token === "") return "";
  if (/\s/.test(token)) {
    throw configError("SUMERU_API_KEY must not contain whitespace");
  }
  if (token.includes(",")) {
    throw configError("SUMERU_API_KEY is a single token and must not contain a comma");
  }
  const bytes = Buffer.byteLength(token, "utf8");
  if (bytes > MAX_TOKEN_BYTES) {
    throw configError(`SUMERU_API_KEY must be at most ${MAX_TOKEN_BYTES} bytes (got ${bytes})`);
  }
  return token;
}

/** token → sha256 digest（内存里只保留这个）。 */
export function digestToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest();
}

/** 日志用的指纹前缀：可区分 token，但不可反推。 */
export function fingerprint(token) {
  return `sha256:${digestToken(token).toString("hex").slice(0, 12)}`;
}

function readMode(raw) {
  const value = String(raw ?? "auto").trim().toLowerCase();
  if (!MCP_AUTH_MODES.includes(value)) {
    throw configError(
      `SUMERU_MCP_AUTH must be one of ${MCP_AUTH_MODES.join(" / ")} (got "${raw}")`,
    );
  }
  return value;
}

/**
 * 一次性解析认证配置。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   mode: string,
 *   realm: string,
 *   source: "none"|"env"|"file",
 *   configured: boolean,
 *   enforceGateway: boolean,
 *   enforceMcp: boolean,
 *   digest: Buffer|null,
 *   warnings: string[],
 * }}
 */
export function loadAuthConfig(env = {}) {
  const warnings = [];
  const file = env.SUMERU_API_KEY_FILE ?? "";
  const fromEnv = env.SUMERU_API_KEY ?? "";
  let token = "";
  let source = "none";

  if (file) {
    token = readSecretFile(file, "SUMERU_API_KEY_FILE");
    source = "file";
    if (fromEnv) {
      warnings.push(
        "SUMERU_API_KEY and SUMERU_API_KEY_FILE are both set; the file wins",
      );
    }
  } else if (fromEnv) {
    token = fromEnv;
    source = "env";
  }

  token = validateApiKey(token);
  if (token !== "" && Buffer.byteLength(token, "utf8") < WEAK_TOKEN_LENGTH) {
    warnings.push(
      `SUMERU_API_KEY is shorter than ${WEAK_TOKEN_LENGTH} chars; use a long random value`,
    );
  }

  const mode = readMode(env.SUMERU_MCP_AUTH);
  if (mode === "required" && token === "") {
    throw configError(
      "SUMERU_MCP_AUTH=required but neither SUMERU_API_KEY nor SUMERU_API_KEY_FILE is set",
    );
  }

  // 单值：要么有凭据要么没有，没有"多 key 并存"。
  const configured = token !== "";
  return {
    mode,
    realm: DEFAULT_REALM,
    source,
    configured,
    enforceGateway: configured,
    enforceMcp: mode === "required" || (mode === "auto" && configured),
    digest: configured ? digestToken(token) : null,
    warnings,
  };
}

/**
 * 从 `Authorization: Bearer <token>` 取凭据。
 *
 * Node 会把重复请求头用 ", " 合并，因此只取第一个逗号前的段；token 本身不允许
 * 含逗号（见 `validateApiKey`），所以不存在歧义。
 */
export function bearerToken(headers = {}) {
  // `req.headers` 的键总是小写；这里兼容直接调用 handleRequest 时传入的大写形式。
  const raw = headers?.authorization ?? headers?.Authorization;
  if (typeof raw !== "string" || raw === "") return null;
  const first = raw.split(",")[0].trim();
  const match = /^Bearer[ \t]+(.+)$/i.exec(first);
  if (!match) return null;
  const token = match[1].trim();
  return token === "" ? null : token;
}

/** 实际提交的凭据：Bearer 优先，回退 `X-Sumeru-Token`（`/gw` 老客户端与 CLI）。 */
export function presentedToken(headers = {}) {
  const bearer = bearerToken(headers);
  if (bearer !== null) return bearer;
  const legacy = headers?.["x-sumeru-token"] ?? headers?.["X-Sumeru-Token"];
  const value = Array.isArray(legacy) ? legacy[0] : legacy;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 校验一次请求的凭据。
 *
 * @param {object} headers Node 的 `req.headers`（键已小写）
 * @param {object} auth `loadAuthConfig()` 的结果
 * @returns {{ok: boolean, reason?: "missing"|"invalid", fingerprint?: string}}
 */
export function verifyCredential(headers, auth = OPEN_AUTH) {
  const token = presentedToken(headers);
  if (token === null) return { ok: false, reason: "missing" };
  const bytes = Buffer.byteLength(token, "utf8");
  if (bytes === 0 || bytes > MAX_TOKEN_BYTES) return { ok: false, reason: "invalid" };
  if (!auth?.digest) return { ok: false, reason: "invalid" };
  const given = digestToken(token);
  if (given.length !== auth.digest.length) return { ok: false, reason: "invalid" };
  return timingSafeEqual(given, auth.digest)
    ? { ok: true }
    : { ok: false, reason: "invalid", fingerprint: fingerprint(token) };
}

/**
 * 401 的挑战头。
 *
 * RFC 6750：未带凭据时不要给 `error` 参数，凭据无效时才给 `error="invalid_token"`。
 *
 * @param {object} auth
 * @param {{error?: string}} [options]
 */
export function challengeHeaders(auth = OPEN_AUTH, { error = "" } = {}) {
  const realm = auth?.realm ?? DEFAULT_REALM;
  const parts = [`Bearer realm="${realm}"`];
  if (error) parts.push(`error="${error}"`);
  return { "www-authenticate": parts.join(", ") };
}

/** `/healthz` 暴露的认证姿态（只说明开没开，不含凭据）。 */
export function describeAuth(auth = OPEN_AUTH) {
  return {
    gw: auth.enforceGateway ? "token" : "open",
    mcp: auth.enforceMcp ? "token" : "open",
    mcpMode: auth.mode ?? "auto",
  };
}

/** 给子进程用的 env：剔除认证变量（chrome 不需要、也不该拿到）。 */
export function sanitizeChildEnv(env = {}) {
  const out = { ...env };
  for (const name of AUTH_ENV_VARS) delete out[name];
  return out;
}

/**
 * 读入内存后抹掉本进程环境里的认证变量。
 *
 * 返回**有值**且被删掉的变量名（空串变量也会删，但不值得在日志里点名）。
 * 注意：`unsetenv` 不会改写 /proc/<pid>/environ 里 exec 时的初始环境块，
 * 真正防止扩散靠"不给子进程传"（`sanitizeChildEnv` / start-all.sh 的 unset）。
 */
export function deleteAuthEnv(env = {}) {
  const removed = [];
  for (const name of AUTH_ENV_VARS) {
    if (!Object.prototype.hasOwnProperty.call(env, name)) continue;
    const value = env[name];
    delete env[name];
    if (value !== "" && value !== undefined) removed.push(name);
  }
  return removed;
}
