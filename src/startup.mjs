/**
 * 启动就绪等待（gateway-only）：
 * 轮询 gateway `ping`，最多 60s。收缩后**不再依赖 listTaskSpaces**——
 * 现行内核没有 `listTabs`，窗口恢复也不再由 shim 编排，ready 条件就是「ping 通」。
 */

/** gateway 未在超时内应答 ping 时抛出的错误码。 */
export const KERNEL_NOT_READY = "SUMERU_KERNEL_NOT_READY";

/**
 * @param {object} options
 * @param {() => Promise<unknown>} options.ping 一次 gateway `ping`（返回 `{pong:true}`）
 * @param {number} [options.timeoutMs=60000]
 * @param {number} [options.intervalMs=250]
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.delay]
 * @param {(attempt: number, error: Error) => void} [options.onAttempt] 诊断钩子
 */
export async function waitForBrowserReady({
  ping,
  timeoutMs = 60_000,
  intervalMs = 250,
  now = Date.now,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onAttempt = () => {},
} = {}) {
  if (typeof ping !== "function") {
    throw new TypeError("waitForBrowserReady requires a ping function");
  }
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let lastError;

  for (;;) {
    attempts += 1;
    try {
      const reply = await ping();
      if (reply?.pong === true) {
        return { ready: true, attempts, waitedMs: now() - startedAt };
      }
      lastError = new Error(
        `unexpected ping reply: ${JSON.stringify(reply ?? null).slice(0, 200)}`,
      );
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    onAttempt(attempts, lastError);
    if (now() >= deadline) {
      throw Object.assign(
        new Error(
          `kernel gateway not ready after ${timeoutMs}ms ` +
            `(${attempts} ping attempts): ${lastError?.message ?? "no reply"}`,
        ),
        { code: KERNEL_NOT_READY, attempts, cause: lastError },
      );
    }
    await delay(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
}
