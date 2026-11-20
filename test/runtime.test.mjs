// 配置面（gateway / §4.7）：chrome 参数里不得再有 CDP，且必须带原生窗口几何。
// 收缩后运行时只剩 config + /healthz + /gw —— 其余行为在 healthz / gateway-proxy 测试里。

import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/runtime.mjs";

test("loadConfig：默认端口 / gateway UDS / token / 超时", () => {
  const config = loadConfig({});
  assert.equal(config.port, 8080);
  assert.equal(config.chromePath, "chrome");
  assert.equal(config.gatewaySocket, "/data/sumeru-gateway.sock");
  assert.equal(config.gatewayToken, "sumeru-gateway");
  assert.equal(config.gatewayTimeoutMs, 15_000);
  // 就绪探针：60s 上限、250ms 间隔（gateway §5 H1「最多 60s」）
  assert.equal(config.readyTimeoutMs, 60_000);
  assert.equal(config.readyPollMs, 250);
  assert.equal(config.apiKey, "");
  assert.equal(config.ime, "");
});

test("窗口尺寸默认跟随 SUMERU_SCREEN；SUMERU_WINDOW_SIZE 可显式覆盖", () => {
  const wide = loadConfig({ SUMERU_SCREEN: "2560x1440x24" });
  assert.ok(wide.chromeArgs.includes("--window-size=2560,1440"));

  const small = loadConfig({ SUMERU_SCREEN: "1024x768x24" });
  assert.ok(small.chromeArgs.includes("--window-size=1024,768"));

  const explicit = loadConfig({ SUMERU_SCREEN: "1920x1080x24", SUMERU_WINDOW_SIZE: "1440,900" });
  assert.ok(explicit.chromeArgs.includes("--window-size=1440,900"));

  // 没给屏幕时不崩，退回产品默认 1280x800
  assert.ok(loadConfig({}).chromeArgs.includes("--window-size=1280,800"));
});

test("loadConfig：无 CDP 参数（A01/D8），且带 --window-position/--window-size", () => {
  const config = loadConfig({});
  const cdp = config.chromeArgs.filter((arg) => arg.includes("--remote-debugging"));
  assert.deepEqual(cdp, []);
  assert.ok(config.chromeArgs.includes("--window-position=0,0"));
  // 几何跟随 SUMERU_SCREEN（默认 1K）；这是渲染层唯一来源。
  assert.ok(config.chromeArgs.includes("--window-size=1280,800"));
  // 无空格形式：chrome 对 "--window-size 1280,800" 这种两段式不认
  assert.ok(config.chromeArgs.every((arg) => !arg.startsWith("--window-size ")));
  // 固定 profile / 缓存目录照旧
  assert.ok(config.chromeArgs.includes("--user-data-dir=/data/profile"));
  assert.ok(config.chromeArgs.includes("--disk-cache-dir=/data/hot/cache"));
});

test("loadConfig：SUMERU_HEADLESS=0 走 X11 原生窗口；默认 headless 仅调试用", () => {
  assert.ok(loadConfig({}).chromeArgs.includes("--headless=new"));
  const native = loadConfig({ SUMERU_HEADLESS: "0" }).chromeArgs;
  assert.ok(!native.includes("--headless=new"));
});

test("loadConfig：env 覆盖（端口 / chrome 路径 / socket / token / api key / 显示与端口）", () => {
  const config = loadConfig({
    SHIM_PORT: "9090",
    SUMERU_CHROME_PATH: "/opt/sumeru/chrome",
    SUMERU_GATEWAY_SOCKET: "/tmp/gw.sock",
    SUMERU_GATEWAY_TOKEN: "g3u-token",
    SUMERU_GATEWAY_TIMEOUT_MS: "3000",
    SUMERU_READY_TIMEOUT_MS: "1000",
    SUMERU_READY_POLL_MS: "25",
    SUMERU_API_KEY: "sk-test",
    SUMERU_DISPLAY: "98",
    SUMERU_NOVNC_PORT: "7001",
    SUMERU_VNC_PORT: "5901",
    SUMERU_IME: "fcitx",
  });
  assert.equal(config.port, 9090);
  assert.equal(config.chromePath, "/opt/sumeru/chrome");
  assert.equal(config.gatewaySocket, "/tmp/gw.sock");
  assert.equal(config.gatewayToken, "g3u-token");
  assert.equal(config.gatewayTimeoutMs, 3000);
  assert.equal(config.readyTimeoutMs, 1000);
  assert.equal(config.readyPollMs, 25);
  assert.equal(config.apiKey, "sk-test");
  assert.equal(config.display, "98");
  assert.equal(config.novncPort, 7001);
  assert.equal(config.vncPort, 5901);
  assert.equal(config.ime, "fcitx");
});

test("loadConfig：SUMERU_CHROME_EXTRA_ARGS 与沙箱开关", () => {
  const config = loadConfig({
    SUMERU_CHROME_EXTRA_ARGS: "--flag-a --flag-b",
    SUMERU_NO_SANDBOX: "0",
  });
  assert.ok(config.chromeArgs.includes("--flag-a"));
  assert.ok(config.chromeArgs.includes("--flag-b"));
  assert.ok(!config.chromeArgs.includes("--no-sandbox"));
  assert.ok(loadConfig({}).chromeArgs.includes("--no-sandbox"));
});
