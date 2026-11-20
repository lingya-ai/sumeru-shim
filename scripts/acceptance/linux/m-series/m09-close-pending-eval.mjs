#!/usr/bin/env node
/**
 * m09 regression: close a tab while an evaluate is in flight must not abort.
 *
 * This is the regression gate for the socket-thread abort:
 *   - start A/B tabs
 *   - fire a slow evaluate on A, close A without waiting
 *   - assert /healthz and ping still work (browser alive)
 *   - then run a cross-tab concurrent evaluate and assert no crash/hang
 *
 * Run only against a disposable runtime:
 *   SUMERU_GATE_URL=http://127.0.0.1:8080 node scripts/acceptance/linux/m-series/m09-close-pending-eval.mjs
 */
const BASE = (process.env.SUMERU_GATE_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const GW = `${BASE}/gw`;

async function gw(method, params = {}, timeoutMs = 5000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(GW, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
      signal: ac.signal,
    });
    const json = await res.json();
    if (!json.ok) throw Object.assign(new Error(json.error?.message ?? "gw error"), { code: json.error?.code });
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

async function healthz() {
  const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(3000) });
  return res.json();
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

async function browserAlive(label) {
  try {
    const ping = await gw("ping", {}, 3000);
    check(`${label}-ping`, ping?.pong === true);
  } catch (error) {
    check(`${label}-ping`, false, error.message);
  }
  try {
    const h = await healthz();
    check(`${label}-healthz`, h?.ready === true && h?.layers?.kernel === true);
  } catch (error) {
    check(`${label}-healthz`, false, error.message);
  }
}

async function main() {
  console.log(`[m09] ${BASE}`);
  const start = await gw("listTabs");
  const baseCount = start.tabs.length;
  const a = (await gw("createTab", { url: "about:blank" })).targetId;
  const b = (await gw("createTab", { url: "about:blank" })).targetId;
  await gw("navigateTarget", { targetId: a, url: "data:text/html,<title>A</title>" });
  await gw("navigateTarget", { targetId: b, url: "data:text/html,<title>B</title>" });

  // Stage 1: close a tab with an in-flight evaluate.
  const slow = gw(
    "evaluateTarget",
    {
      targetId: a,
      expression: "const t=Date.now(); while (Date.now()-t < 1500) {}; 'slow-done'",
    },
    4000,
  ).catch((error) => ({ error: error.message }));
  await new Promise((r) => setTimeout(r, 150));
  try {
    await gw("closeTab", { targetId: a }, 3000);
    check("close-with-pending", true);
  } catch (error) {
    check("close-with-pending", false, error.message);
  }
  await new Promise((r) => setTimeout(r, 500));
  await browserAlive("after-close");
  await slow;

  // Stage 2: cross-tab concurrency should either both complete or fail cleanly.
  let alive = false;
  try {
    alive = (await healthz())?.ready === true;
  } catch {
    alive = false;
  }
  if (!alive) {
    check("concurrent-eval", false, "browser not alive; skipped");
    return finish();
  }
  const c = (await gw("createTab", { url: "about:blank" })).targetId;
  await gw("navigateTarget", { targetId: c, url: "data:text/html,<title>C</title>" });
  const slowB = gw(
    "evaluateTarget",
    { targetId: b, expression: "const t=Date.now(); while (Date.now()-t < 600) {}; 'slow-b'" },
    4000,
  )
    .then((r) => ({ ok: true, r }))
    .catch((error) => ({ ok: false, error: error.message }));
  await new Promise((r) => setTimeout(r, 50));
  const fastC = gw("evaluateTarget", { targetId: c, expression: "'fast-c'" }, 4000)
    .then((r) => ({ ok: true, r }))
    .catch((error) => ({ ok: false, error: error.message }));
  const [s, f] = await Promise.all([slowB, fastC]);
  check("concurrent-fast", f.ok, f.ok ? "" : f.error);
  check("concurrent-browser-alive", (await healthz().catch(() => null))?.ready === true || s.ok);
  await gw("closeTab", { targetId: b }).catch(() => {});
  await gw("closeTab", { targetId: c }).catch(() => {});

  const remaining = await gw("listTabs").catch(() => null);
  check("cleanup", remaining == null || remaining.tabs.length === baseCount, `tabs=${remaining?.tabs?.length}`);
  return finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[m09] ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`[m09] ERROR: ${error?.stack ?? error}`);
  process.exit(1);
});
