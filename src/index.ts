#!/usr/bin/env node
/**
 * anchor-activity-mcp — cross-platform desktop activity tracking as MCP server.
 *
 * Speaks MCP 2025-06-18 over stdio. Exposes 4 tools:
 *   activity_capture_now    — current active window (app/title/url)
 *   activity_recent         — last N captures from local SQLite ring buffer
 *   activity_summary        — aggregated app-time / unique activities last N hours
 *   activity_status         — health (last capture timestamp, total in 24h)
 *
 * Uses npm `active-win` (Mac/Win/Linux X11). Stores captures in a small
 * local SQLite ring buffer (default 30 days, configurable via env).
 *
 * No network calls. No telemetry. Data stays on disk where this process runs.
 */
import {
  captureActiveWindow,
  recentCaptures,
  generateActivitySummary,
  getActivityStatus,
  startBackgroundCapture,
} from "./activity.js";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "anchor-activity-mcp", version: "0.1.0" };

interface JsonRpcRequest { jsonrpc: "2.0"; id?: number | string; method: string; params?: any }
interface JsonRpcResponse { jsonrpc: "2.0"; id: number | string; result?: any; error?: { code: number; message: string } }

const TOOLS = [
  {
    name: "activity_capture_now",
    description: "Capture current active window: app, title, URL (browsers only).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "activity_recent",
    description: "Get the last N captures from the local ring buffer.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "How many captures to return (default 20, max 200)" } },
    },
  },
  {
    name: "activity_summary",
    description: "Aggregated activity for the last N hours: top apps, unique activities, meetings.",
    inputSchema: {
      type: "object",
      properties: { hours: { type: "number", description: "Window in hours (default 24, max 168)" } },
    },
  },
  {
    name: "activity_status",
    description: "Health snapshot: last capture timestamp, total captures in 24h, platform.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = req.id ?? 0;

  if (req.method === "initialize") {
    return {
      jsonrpc: "2.0", id,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
    };
  }

  if (req.method === "notifications/initialized") {
    return null;  // notifications get no response
  }

  if (req.method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }

  if (req.method === "tools/call") {
    const { name, arguments: args } = req.params ?? {};
    try {
      const text = await callTool(name, args ?? {});
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
    } catch (err: any) {
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }], isError: true } };
    }
  }

  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${req.method}` } };
}

async function callTool(name: string, args: Record<string, any>): Promise<string> {
  switch (name) {
    case "activity_capture_now": {
      const r = await captureActiveWindow();
      if (!r) return "No active window detected (active-win unavailable on this platform/permission).";
      return JSON.stringify(r, null, 2);
    }
    case "activity_recent": {
      const limit = Math.min(Number(args.limit ?? 20), 200);
      return JSON.stringify(recentCaptures(limit), null, 2);
    }
    case "activity_summary": {
      const hours = Math.min(Number(args.hours ?? 24), 168);
      return JSON.stringify(generateActivitySummary(hours), null, 2);
    }
    case "activity_status":
      return JSON.stringify(getActivityStatus(), null, 2);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── stdio transport ─────────────────────────────────────────────────────────

let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      const req: JsonRpcRequest = JSON.parse(line);
      const res = await handleRequest(req);
      if (res) process.stdout.write(JSON.stringify(res) + "\n");
    } catch (err: any) {
      process.stderr.write(`[parse-error] ${err?.message ?? err}\n`);
    }
  }
});

process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

// Optional: kick off a background capture loop when CAPTURE_INTERVAL_MS is set.
// Otherwise, host calls activity_capture_now on its own cron.
const interval = parseInt(process.env.CAPTURE_INTERVAL_MS ?? "0", 10);
if (interval > 0) startBackgroundCapture(interval);

process.stderr.write(`[anchor-activity-mcp] ready on stdio (platform=${process.platform})\n`);
