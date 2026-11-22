/**
 * Shared MCP tool core: tool definitions and JSON-RPC dispatch.
 *
 * Served by the shim's Streamable HTTP endpoint:
 *   POST /mcp  (stateless JSON-only, protocol 2025-06-18)
 *
 * No Node-specific I/O here; gatewayCall is injected.
 */

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_NAME = "sumeru-mcp";
export const SERVER_VERSION = "0.5.0";

const targetId = {
  type: "string",
  description: "页面 target id（list_tabs 拿到的 targetId）",
};

// 工具清单 = gateway 方法 1:1（方法名 → 工具名做 snake_case 直译）。
export const TOOLS = [
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
    description: "截取指定标签的页面（PNG，不含浏览器 chrome），返回 MCP image content（base64）。",
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


/** Only pass arguments declared in the tool schema; drop unknown keys. */
export function pickParams(tool, input = {}) {
  const properties = tool.inputSchema?.properties ?? {};
  const params = {};
  for (const key of Object.keys(properties)) {
    if (input[key] !== undefined) params[key] = input[key];
  }
  return params;
}

export function textResult(value) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
  return { content: [{ type: "text", text }] };
}

export function imageResult(value) {
  const data = value?.pngBase64;
  if (typeof data !== "string" || data.length === 0) {
    throw new Error("capture_page: gateway returned no pngBase64");
  }
  return {
    content: [
      {
        type: "image",
        data,
        mimeType: "image/png",
      },
    ],
  };
}

export async function callTool(name, input, gatewayCall) {
  const tool = TOOLS.find((item) => item.name === name);
  if (!tool) throw new Error(`未知工具: ${name}`);
  const value = await gatewayCall(tool.method, pickParams(tool, input ?? {}));
  return tool.name === "capture_page" ? imageResult(value) : textResult(value);
}

export function initializeResult() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  };
}

export function toolsListResult() {
  return {
    tools: TOOLS.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Handle one JSON-RPC message.
 * Returns an object, or null for notifications (no response).
 */
export async function handleMcpRequest(req, gatewayCall) {
  if (!req || typeof req !== "object" || Array.isArray(req)) {
    return rpcError(null, -32600, "Invalid Request");
  }
  const id = req.id ?? null;
  const method = req.method;

  if (method === "initialize") {
    return { jsonrpc: "2.0", id, result: initializeResult() };
  }
  if (method === "notifications/initialized") {
    return null;
  }
  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: toolsListResult() };
  }
  if (method === "tools/call") {
    const name = req?.params?.name;
    if (typeof name !== "string" || name.length === 0) {
      return rpcError(id, -32602, "tools/call: params.name must be a string");
    }
    try {
      return {
        jsonrpc: "2.0",
        id,
        result: await callTool(name, req?.params?.arguments ?? {}, gatewayCall),
      };
    } catch (error) {
      const code = error?.code ? `[${error.code}] ` : "";
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            { type: "text", text: `工具失败: ${code}${error?.message ?? error}` },
          ],
          isError: true,
        },
      };
    }
  }
  return rpcError(id, -32601, `未实现的方法: ${method ?? "(missing)"}`);
}
