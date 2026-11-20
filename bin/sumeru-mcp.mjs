#!/usr/bin/env node
// 须弥 MCP server（gateway-only）：
// 工具面 = gateway 方法 **1:1**。每个工具的调用都是 `POST {gate}/gw {method, params}`，
// 内核返回的结果/错误码/错误信息原样转成 MCP 结果，MCP 层不翻译、不改写。
//
// 协议：JSON-RPC over stdio（MCP 标准传输），支持 initialize / tools/list / tools/call。
//
// 用法（MCP 客户端配置）：
//   command: node
//   args: ["<repo>/sumeru-shim/bin/sumeru-mcp.mjs", "--gate", "http://127.0.0.1:8080", "--key", "<SUMERU_API_KEY>"]
//
// 环境变量：SUMERU_GATE_URL（默认 http://127.0.0.1:8080）、SUMERU_API_KEY
//          （设置时随每次调用带 `X-Sumeru-Token` 头）。
//
// 删除面：sumeru_round / sumeru_snapshot（`/round` 已不存在）、
// sumeru_visual / sumeru_spaces（多空间与视觉镜像已删除）。

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};

const GATE = arg("gate", process.env.SUMERU_GATE_URL ?? "http://127.0.0.1:8080");
const KEY = arg("key", process.env.SUMERU_API_KEY ?? "");

const targetId = {
  type: "string",
  description: "页面 target id（list_tabs 拿到的 targetId）",
};

// 工具清单 = gateway 方法 1:1（方法名 → 工具名做 snake_case 直译）。
const TOOLS = [
  {
    name: "ping",
    method: "ping",
    description: "探活内核 gateway。返回 {pong:true} 表示操作面在。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_tabs",
    method: "listTabs",
    description: "列出浏览器标签（原生窗口内的 tab），每项含 targetId/url/title/active。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "create_tab",
    method: "createTab",
    description: "新建标签并返回其 targetId。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "要打开的地址" },
      },
      required: ["url"],
    },
  },
  {
    name: "close_tab",
    method: "closeTab",
    description: "关闭标签。",
    inputSchema: {
      type: "object",
      properties: { targetId },
      required: ["targetId"],
    },
  },
  {
    name: "activate_tab",
    method: "activateTab",
    description: "激活（切到前台）标签；后台标签的截图/求值前先激活。",
    inputSchema: {
      type: "object",
      properties: { targetId },
      required: ["targetId"],
    },
  },
  {
    name: "navigate_target",
    method: "navigateTarget",
    description: "让指定标签导航到 URL。",
    inputSchema: {
      type: "object",
      properties: {
        targetId,
        url: { type: "string", description: "目标地址" },
      },
      required: ["targetId", "url"],
    },
  },
  {
    name: "evaluate_target",
    method: "evaluateTarget",
    description: "在指定标签的页面里求值 JS 表达式并返回结果（被求值页内无注入痕迹）。",
    inputSchema: {
      type: "object",
      properties: {
        targetId,
        expression: { type: "string", description: "JS 表达式；返回对象请自行 JSON.stringify" },
      },
      required: ["targetId", "expression"],
    },
  },
  {
    name: "capture_page",
    method: "captureScreenshot",
    description: "截取指定标签的页面（PNG，不含浏览器 chrome），返回 base64。",
    inputSchema: {
      type: "object",
      properties: { targetId },
      required: ["targetId"],
    },
  },
  {
    name: "snapshot_ax",
    method: "snapshotAX",
    description: "取指定标签的可访问性树快照（AX 扁平化树，含 role/name/ref）。",
    inputSchema: {
      type: "object",
      properties: { targetId },
      required: ["targetId"],
    },
  },
  {
    name: "dispatch_key",
    method: "dispatchKey",
    description: "向指定标签派发真实键盘事件（isTrusted=true，非 JS 合成）。",
    inputSchema: {
      type: "object",
      properties: {
        targetId,
        type: {
          type: "string",
          enum: ["keyDown", "keyUp", "rawKeyDown", "char"],
          description: "事件类型",
        },
        key: { type: "string", description: "按键名，如 Enter / a" },
        code: { type: "string", description: "物理键码，如 KeyA / Enter" },
        windowsVirtualKeyCode: { type: "number" },
        nativeVirtualKeyCode: { type: "number" },
        text: { type: "string", description: "char 事件的文本" },
      },
      required: ["targetId", "type"],
    },
  },
  {
    name: "dispatch_mouse",
    method: "dispatchMouse",
    description: "向指定标签派发真实鼠标事件（isTrusted=true，非 JS 合成）。",
    inputSchema: {
      type: "object",
      properties: {
        targetId,
        type: {
          type: "string",
          enum: ["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"],
          description: "事件类型",
        },
        x: { type: "number", description: "视口内 x" },
        y: { type: "number", description: "视口内 y" },
        button: { type: "string", description: "left/right/middle/none" },
        clickCount: { type: "number" },
        deltaX: { type: "number", description: "mouseWheel 横向增量" },
        deltaY: { type: "number", description: "mouseWheel 纵向增量" },
      },
      required: ["targetId", "type", "x", "y"],
    },
  },
  {
    name: "ime_compose",
    method: "imeCompose",
    description: "以 IME 语义在指定标签提交文本（中文上屏路径，isTrusted）。",
    inputSchema: {
      type: "object",
      properties: {
        targetId,
        text: { type: "string", description: "输入法组字文本" },
        commit: { type: "string", description: "要提交（上屏）的文本" },
        selectionStart: { type: "number", description: "组字选区起点，缺省=正文长度" },
      },
      required: ["targetId", "text"],
    },
  },
];

function jsonRpc(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

/** 只把工具 schema 里声明的参数原样送出去（多给的键丢弃，缺的保持缺省）。 */
function pickParams(tool, input = {}) {
  const properties = tool.inputSchema?.properties ?? {};
  const params = {};
  for (const key of Object.keys(properties)) {
    if (input[key] !== undefined) params[key] = input[key];
  }
  return params;
}

/** POST /gw：方法/参数原样到达 gateway，错误码/错误信息原样上抛。 */
async function gatewayCall(method, params) {
  const headers = { "content-type": "application/json" };
  if (KEY) headers["x-sumeru-token"] = KEY;
  const res = await fetch(`${GATE}/gw`, {
    method: "POST",
    headers,
    body: JSON.stringify({ method, params }),
  });
  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error(
        "网关鉴权失败（401）：检查 SUMERU_API_KEY 与 X-Sumeru-Token 头是否一致",
      );
    }
    throw new Error(`网关 /gw 返回 ${res.status}: ${JSON.stringify(payload).slice(0, 300)}`);
  }
  if (payload?.ok === false) {
    const error = new Error(payload?.error?.message ?? "gateway error");
    error.code = payload?.error?.code ?? "SUMERU_OPERATION_FAILED";
    throw error;
  }
  return payload?.result === undefined ? null : payload.result;
}

function textResult(value) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
  return { content: [{ type: "text", text }] };
}

async function callTool(name, input = {}) {
  const tool = TOOLS.find((item) => item.name === name);
  if (!tool) throw new Error(`未知工具: ${name}`);
  return textResult(await gatewayCall(tool.method, pickParams(tool, input)));
}

async function handleRequest(req) {
  const { id, method, params } = req;

  switch (method) {
    case "initialize":
      return jsonRpc(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "sumeru-mcp", version: "0.2.0" },
      });

    case "tools/list":
      return jsonRpc(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });

    case "tools/call": {
      const name = params?.name;
      try {
        const result = await callTool(name, params?.arguments ?? {});
        return jsonRpc(id, result);
      } catch (error) {
        const code = error?.code ? `[${error.code}] ` : "";
        return jsonRpc(id, {
          content: [{ type: "text", text: `工具失败: ${code}${error?.message ?? error}` }],
          isError: true,
        });
      }
    }

    case "notifications/initialized":
      return null; // 通知无需响应

    default:
      return jsonRpcError(id, -32601, `未实现的方法: ${method}`);
  }
}

// —— stdio 主循环（按行分隔的 JSON-RPC）——
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      process.stdout.write(jsonRpcError(null, -32700, "JSON 解析失败") + "\n");
      continue;
    }
    const response = await handleRequest(req);
    if (response) process.stdout.write(response + "\n");
  }
});

process.stdin.on("end", () => process.exit(0));
