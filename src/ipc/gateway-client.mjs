/**
 * K-Gateway client (broker side, K-Gateway).
 *
 * Talks to the browser process's private UDS control channel — the
 * product control plane that replaces the external CDP pipe. Wire protocol:
 * newline-delimited JSON identical in shape to host-IPC v2.
 *
 * Env: SUMERU_GATEWAY_URL (default http-gateway-unix:<path> is NOT used —
 * this is a raw UDS socket client), SUMERU_GATEWAY_TOKEN.
 * Enabled by SUMERU_KERNEL_CHANNEL=gateway (default: off, CDP pipe path).
 */
import { connect } from "node:net";

export function createGatewayClient({
  socketPath = process.env.SUMERU_GATEWAY_SOCKET ?? "/data/sumeru-gateway.sock",
  token = process.env.SUMERU_GATEWAY_TOKEN ?? "sumeru-gateway",
  timeoutMs = 15_000,
} = {}) {
  let sock = null;
  let buffer = "";
  let nextId = 1;
  let welcomeResolve;
  let welcomeReject;
  const pending = new Map();
  const eventListeners = new Set();
  let lastSeq = 0;
  let connected = false;

  async function connectOnce() {
    // K3 flip: the shim may reach the gateway before the browser process has
    // created the socket (no CDP hop in between any more), so wait for it
    // instead of failing the whole startup on ENOENT.
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        return await new Promise((resolve, reject) => {
          const s = connect(socketPath);
          const timer = setTimeout(() => {
            s.destroy();
            reject(new Error("gateway connect timeout"));
          }, timeoutMs);
          s.once("error", (e) => { clearTimeout(timer); reject(e); });
          s.once("connect", () => {
            clearTimeout(timer);
            resolve(s);
          });
        });
      } catch (error) {
        const code = error?.code;
        if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw Object.assign(new Error("gateway socket never appeared"), {
      code: "GW_UNAVAILABLE",
    });
  }

  async function ensureConnected() {
    if (connected && sock && !sock.destroyed) {
      return;
    }
    sock = await connectOnce();
    buffer = "";
    connected = true;
    sock.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === "welcome") {
          welcomeResolve?.(msg);
        } else if (msg.type === "response" && pending.has(msg.id)) {
          const entry = pending.get(msg.id);
          pending.delete(msg.id);
          clearTimeout(entry.timer);
          if (msg.ok) entry.resolve(msg.result);
          else {
            const error = new Error(msg.error?.message ?? "gateway error");
            error.code = msg.error?.code;
            entry.reject(error);
          }
        } else if (msg.type === "event") {
          if (typeof msg.seq === "number") {
            lastSeq = msg.seq;
          }
          for (const fn of eventListeners) fn(msg);
        }
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      connected = false;
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error("gateway closed"));
      }
      pending.clear();
    });
    // Handshake.
    const welcome = new Promise((resolve, reject) => {
      welcomeResolve = resolve;
      welcomeReject = reject;
    });
    sock.write(JSON.stringify({ type: "hello", versions: [2], token }) + "\n");
    await Promise.race([
      welcome,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("gateway handshake timeout")), timeoutMs)),
    ]);
  }

  async function request(method, params = {}) {
    await ensureConnected();
    const id = nextId++;
    // The kernel gateway is a SINGLE-client server (one `client_` socket that a
    // new accept replaces). With SUMERU_GW_SHORT_CONN=1 the shim drops its
    // connection after each request so an external client (gates, diagnostics,
    // a second tool) can connect; the shim reconnects on demand.
    const shortConn = process.env.SUMERU_GW_SHORT_CONN === "1";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const error = new Error(`gateway ${method} timed out`);
        error.code = "GATEWAY_TIMEOUT";
        reject(error);
      }, timeoutMs);
      const finish = (fn) => (value) => {
        if (shortConn) {
          try { sock?.destroy(); } catch { /* already gone */ }
          connected = false;
        }
        fn(value);
      };
      pending.set(id, { resolve: finish(resolve), reject: finish(reject), timer });
      sock.write(JSON.stringify({ type: "request", id, method, params }) + "\n");
    });
  }

  // Gateway health: `/healthz` 的 kernel 层用它判断「gateway 连接存活」（收 shim 时
  // 不再有 CDP transport 可以探）。握手成功且 socket 未销毁才算存活。
  function isConnected() {
    return connected && !!sock && !sock.destroyed;
  }

  return {
    request,
    isConnected,
    onEvent(fn) { eventListeners.add(fn); return () => eventListeners.delete(fn); },
    get lastSeq() { return lastSeq; },
    close() { sock?.destroy(); connected = false; },
  };
}
