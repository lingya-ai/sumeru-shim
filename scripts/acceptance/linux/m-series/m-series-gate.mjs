// Gateway acceptance — gateway-only operation surface.
// Runs against the shim's /gw proxy (same path an external agent uses).
//   M02  no CDP surface          (flags/listeners asserted out of band)
//   M03  agent tab/page ops       (+ 1000 sequential evaluates, no stall)
//   M04  agent input              (isTrusted arrival)
//   M05  agent vision             (capture front + after activation)
//   M06  stealth                  (zero injection / no sumeru globals)
const BASE = process.env.GW_BASE ?? "http://127.0.0.1:8080/gw";
const results = [];
const check = (n, ok, d) => {
  results.push({ n, ok, d: String(d ?? "") });
  console.log(n, ok ? "PASS" : "FAIL", d ?? "");
};
const call = async (method, params = {}) => {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const json = await res.json();
  if (!json.ok) throw Object.assign(new Error(json.error?.message ?? "gw error"), { code: json.error?.code });
  return json.result;
};
const evalOn = async (targetId, expression) =>
  (await call("evaluateTarget", { targetId, expression }))?.value;

// ---- M03: tab/page operations + 1000 sequential evaluates -----------------
let r = await call("listTabs");
const baseCount = r.tabs.length;
r = await call("createTab", { url: "about:blank" });
const t1 = r.targetId;
await call("navigateTarget", { targetId: t1, url: "data:text/html,<title>m3</title><p id=v>0</p>" });
const first = await evalOn(t1, "document.getElementById('v').textContent");
check("M03-evaluate-basic", first === "0", `value=${first}`);

// 1000 sequential evaluates on one tab: no stall, no lost response.
const N = 1000;
const t0 = Date.now();
let worst = 0;
let failures = 0;
for (let i = 1; i <= N; i++) {
  const s = Date.now();
  try {
    const v = await evalOn(t1, `${i}`);
    if (Number(v) !== i) failures++;
  } catch {
    failures++;
  }
  worst = Math.max(worst, Date.now() - s);
}
const total = Date.now() - t0;
check(
  "M03-evaluate-1000",
  failures === 0,
  `failures=${failures} total=${total}ms avg=${(total / N).toFixed(1)}ms worst=${worst}ms`,
);
check("M03-worst-latency", worst < 2000, `worst=${worst}ms`);

// ---- M05: capture on the active tab, then on a freshly activated tab ------
await call("activateTab", { targetId: t1 });
r = await call("captureScreenshot", { targetId: t1 });
check("M05-capture-active", (r?.bytes ?? 0) > 500, `bytes=${r?.bytes}`);

r = await call("createTab", { url: "data:text/html,<title>m5b</title><body style='background:%23216'><h1 style='color:%23fff'>BG-CAPTURE</h1>" });
const t2 = r.targetId;
await call("activateTab", { targetId: t2 });
await call("activateTab", { targetId: t1 });          // t2 is now a background tab
const shotBg = await call("captureScreenshot", { targetId: t2 });
check("M05-capture-background", (shotBg?.bytes ?? 0) > 500, `bytes=${shotBg?.bytes}`);

// AX snapshot still parses for both.
const ax = await call("snapshotAX", { targetId: t2 });
check("M05-snapshotAX", JSON.stringify(ax ?? "").length > 20, `len=${JSON.stringify(ax ?? "").length}`);

// ---- M04: trusted input arrives -----------------------------------------
await call("navigateTarget", {
  targetId: t2,
  url: "data:text/html,<title>m4</title><input id=i autofocus><script>window.__k=[];addEventListener('keydown',e=>window.__k.push(e.key+':'+e.isTrusted))</script>",
});
await call("dispatchKey", { targetId: t2, type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
await call("dispatchKey", { targetId: t2, type: "char", text: "a", key: "a", windowsVirtualKeyCode: 65 });
const keys = await evalOn(t2, "window.__k.join(',')");
check("M04-dispatchKey-isTrusted", String(keys ?? "").includes("a:true"), `keys=${keys}`);

await call("imeCompose", { targetId: t2, text: "中文", commit: "中文" });
const composed = await evalOn(t2, "document.activeElement && document.activeElement.value");
check("M04-imeCompose", String(composed ?? "").includes("中文"), `value=${composed}`);

// ---- M06: no injection / no sumeru globals ------------------------------
const stealth = await evalOn(
  t2,
  `JSON.stringify({
     sumeru: typeof globalThis.sumeru,
     keys: Object.getOwnPropertyNames(globalThis).filter(k => /sumeru|__cdp|__agent/i.test(k)),
     webdriver: navigator.webdriver === true,
     ws: typeof globalThis.WebSocket,
   })`,
);
const st = JSON.parse(String(stealth));
check("M06-no-sumeru-global", st.sumeru === "undefined", `typeof=${st.sumeru}`);
check("M06-no-injected-keys", st.keys.length === 0, `keys=${JSON.stringify(st.keys)}`);
check("M06-not-webdriver", st.webdriver === false, `webdriver=${st.webdriver}`);

// ---- cleanup -----------------------------------------------------------
await call("closeTab", { targetId: t2 });
await call("closeTab", { targetId: t1 });
r = await call("listTabs");
check("M03-cleanup", r.tabs.length === baseCount, `tabs=${r.tabs.length}`);

const pass = results.filter((x) => x.ok).length;
console.log(`\nM-SERIES: ${pass}/${results.length}`);
process.exit(pass === results.length ? 0 : 1);
