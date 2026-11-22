#!/usr/bin/env node
/**
 * End-to-end smoke test for a running Sumeru runtime ().
 *
 *   node scripts/smoke.mjs
 *   SUMERU_GATE_URL=http://127.0.0.1:18880 node scripts/smoke.mjs
 *
 * It only uses the public HTTP surface: GET /healthz + POST /gw + POST /mcp.
 * When SUMERU_API_KEY is set in the *caller's* env it is sent as a bearer token,
 * and the unauthenticated paths are asserted instead (docs/auth.md §9.2).
 */
const BASE = (process.env.SUMERU_GATE_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const GW = `${BASE}/gw`;
const MCP = `${BASE}/mcp`;
const API_KEY = process.env.SUMERU_API_KEY ?? "";
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

function withAuth(headers = {}) {
  return API_KEY ? { ...headers, authorization: `Bearer ${API_KEY}` } : headers;
}

async function gw(method, params = {}, timeoutMs = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(GW, {
      method: "POST",
      headers: withAuth({ "content-type": "application/json" }),
      body: JSON.stringify({ method, params }),
      signal: ac.signal,
    });
    const json = await res.json();
    if (!json.ok) {
      throw Object.assign(new Error(json.error?.message ?? "gateway error"), {
        code: json.error?.code,
      });
    }
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

/** 一次 MCP 调用；`auth: false` 用于探测未认证路径。 */
async function mcp(payload, { auth = true } = {}) {
  const headers = auth
    ? withAuth({ "content-type": "application/json" })
    : { "content-type": "application/json" };
  const res = await fetch(MCP, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, challenge: res.headers.get("www-authenticate") ?? "" };
}

async function healthz() {
  const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(5000) });
  return { status: res.status, json: await res.json() };
}

async function main() {
  console.log(`[smoke] ${BASE}`);

  const h = await healthz();
  check("healthz", h.json?.ready === true, `status=${h.status}`);
  check("healthz-gateway-layer", h.json?.layers?.gateway === true);
  check("healthz-kernel-layer", h.json?.layers?.kernel === true);

  // 认证矩阵：有 key 时两个面都必须拒绝匿名请求；没 key 时保持开放。
  const toolsList = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  if (API_KEY) {
    const anonymousGw = await fetch(GW, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "ping", params: {} }),
      signal: AbortSignal.timeout(5000),
    });
    check("gw-unauthorized", anonymousGw.status === 401, `status=${anonymousGw.status}`);

    const anonymousMcp = await mcp(toolsList, { auth: false });
    check("mcp-unauthorized", anonymousMcp.status === 401, `status=${anonymousMcp.status}`);
    check(
      "mcp-challenge",
      anonymousMcp.challenge.startsWith("Bearer"),
      anonymousMcp.challenge,
    );

    const authedMcp = await mcp(toolsList);
    check(
      "mcp-tools-list",
      authedMcp.status === 200 && authedMcp.json?.result?.tools?.length === 12,
      `status=${authedMcp.status}`,
    );
    check("healthz-auth-mcp", h.json?.auth?.mcp === "token");
  } else {
    const openMcp = await mcp(toolsList, { auth: false });
    check(
      "mcp-open",
      openMcp.status === 200 && openMcp.json?.result?.tools?.length === 12,
      `status=${openMcp.status}${openMcp.status === 401 ? " (runtime requires auth; export SUMERU_API_KEY)" : ""}`,
    );
    check("healthz-auth-mcp", h.json?.auth?.mcp === "open");
  }

  const ping = await gw("ping");
  check("ping", ping?.pong === true);

  const before = await gw("listTabs");
  const baseCount = before?.tabs?.length ?? 0;
  check("listTabs", Array.isArray(before?.tabs), `tabs=${baseCount}`);

  const created = await gw("createTab", { url: "about:blank" });
  const targetId = created?.targetId;
  check("createTab", typeof targetId === "string" && targetId.length > 0, targetId ?? "");

  try {
    await gw("navigateTarget", {
      targetId,
      url: "data:text/html,<title>smoke</title><h1 id=v>ok</h1>",
    });
    const value = await gw("evaluateTarget", { targetId, expression: "1+1" });
    check("evaluateTarget", value?.value === 2, `value=${JSON.stringify(value?.value)}`);

    const ax = await gw("snapshotAX", { targetId });
    check("snapshotAX", typeof ax?.content === "string" && ax.content.includes("ok"));

    const shot = await gw("captureScreenshot", { targetId });
    check(
      "captureScreenshot",
      typeof shot?.pngBase64 === "string" && shot.pngBase64.length > 1000,
      `bytes=${shot?.pngBase64?.length ?? 0}`,
    );
  } finally {
    if (targetId && baseCount > 0) {
      await gw("closeTab", { targetId }).catch((error) =>
        console.log(`[smoke] cleanup closeTab failed: ${error.message}`),
      );
    }
    const after = await gw("listTabs").catch(() => null);
    check("cleanup", after == null || (after.tabs?.length ?? -1) === baseCount);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[smoke] ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`[smoke] ERROR: ${error?.stack ?? error}`);
  process.exit(1);
});
