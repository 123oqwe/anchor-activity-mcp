/**
 * Activity capture core. Uses npm `active-win` for cross-platform reads,
 * stores in a local SQLite ring buffer (default: ~/.anchor-activity-mcp/data.db).
 *
 * This is a self-contained MCP server — no shared DB with anchor-backend.
 * Backend reads activity by calling our MCP tools, not by sharing schema.
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import Database from "better-sqlite3";
import { nanoid } from "nanoid";

// ── Storage (own SQLite, ring buffer) ──────────────────────────────────────

const DB_DIR = process.env.ANCHOR_ACTIVITY_DIR ?? path.join(os.homedir(), ".anchor-activity-mcp");
const DB_PATH = path.join(DB_DIR, "data.db");
const RETENTION_DAYS = parseInt(process.env.ANCHOR_ACTIVITY_RETENTION_DAYS ?? "30", 10);

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS captures (
    id TEXT PRIMARY KEY,
    app_name TEXT NOT NULL,
    window_title TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    captured_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_captured_at ON captures(captured_at);
`);

// ── Active window read (active-win 9.x ESM) ────────────────────────────────

type ActiveWinResult = {
  title: string;
  owner: { name: string; bundleId?: string; path?: string; processId?: number };
  url?: string;
  bounds?: { x: number; y: number; width: number; height: number };
} | undefined;

let warned = false;
async function readActiveWindow(): Promise<ActiveWinResult> {
  try {
    const mod = await import("active-win");
    const fn: () => Promise<ActiveWinResult> = (mod as any).activeWindow ?? (mod as any).default;
    if (typeof fn !== "function") throw new Error("active-win missing activeWindow()");
    return await fn();
  } catch (err: any) {
    if (!warned) { process.stderr.write(`[anchor-activity-mcp] active-win failed: ${err?.message?.slice(0, 100)}\n`); warned = true; }
    return undefined;
  }
}

// ── Public API (called by MCP tool handlers) ───────────────────────────────

export interface Capture { app: string; title: string; url: string; capturedAt: string }

export async function captureActiveWindow(): Promise<Capture | null> {
  const w = await readActiveWindow();
  if (!w?.owner?.name) return null;
  const app = w.owner.name.trim();
  const title = (w.title ?? "").trim();
  const url = (w.url ?? "").trim();
  const capturedAt = new Date().toISOString();
  db.prepare("INSERT INTO captures (id, app_name, window_title, url, captured_at) VALUES (?,?,?,?,?)")
    .run(nanoid(), app, title, url, capturedAt);
  prune();
  return { app, title, url, capturedAt };
}

export function recentCaptures(limit = 20): Capture[] {
  const rows = db.prepare(
    "SELECT app_name, window_title, url, captured_at FROM captures ORDER BY captured_at DESC LIMIT ?"
  ).all(limit) as any[];
  return rows.map(r => ({ app: r.app_name, title: r.window_title, url: r.url, capturedAt: r.captured_at }));
}

export interface ActivitySummary {
  windowHours: number;
  totalCaptures: number;
  topApps: { app: string; captures: number; minutes: number }[];
  recentActivities: { app: string; title: string; url: string; capturedAt: string }[];
  meetings: { title: string; durationMinutes: number }[];
  platform: NodeJS.Platform;
}

export function generateActivitySummary(hours = 24): ActivitySummary {
  const since = `-${hours} hours`;
  const apps = db.prepare(`
    SELECT app_name as app, COUNT(*) as captures FROM captures
    WHERE captured_at >= datetime('now', ?) AND app_name != ''
    GROUP BY app_name ORDER BY captures DESC LIMIT 10
  `).all(since) as any[];

  const totalCaptures = apps.reduce((s, a) => s + a.captures, 0);

  const recentRaw = db.prepare(`
    SELECT app_name, window_title, url, captured_at FROM captures
    WHERE captured_at >= datetime('now', ?) AND window_title != ''
    ORDER BY captured_at DESC LIMIT 50
  `).all(since) as any[];
  const seen = new Set<string>();
  const recentActivities = recentRaw.filter(r => {
    const key = `${r.app_name}|${r.window_title}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 20).map(r => ({ app: r.app_name, title: r.window_title, url: r.url, capturedAt: r.captured_at }));

  const meetings = (db.prepare(`
    SELECT window_title, COUNT(*) as captures FROM captures
    WHERE captured_at >= datetime('now', ?)
    AND (app_name IN ('zoom.us','Zoom','Microsoft Teams','FaceTime','Google Meet','Slack')
         OR window_title LIKE '%Meeting%' OR window_title LIKE '%Meet -%' OR window_title LIKE '%Huddle%')
    GROUP BY window_title
  `).all(since) as any[]).map(m => ({ title: m.window_title, durationMinutes: m.captures * 5 }));

  return {
    windowHours: hours,
    totalCaptures,
    topApps: apps.map(a => ({ app: a.app, captures: a.captures, minutes: a.captures * 5 })),
    recentActivities,
    meetings,
    platform: process.platform,
  };
}

export function getActivityStatus() {
  const last = db.prepare("SELECT captured_at FROM captures ORDER BY captured_at DESC LIMIT 1").get() as any;
  const total24h = (db.prepare("SELECT COUNT(*) as c FROM captures WHERE captured_at >= datetime('now', '-24 hours')").get() as any)?.c ?? 0;
  return {
    lastCaptureAt: last?.captured_at ?? null,
    capturesLast24h: total24h,
    platform: process.platform,
    retentionDays: RETENTION_DAYS,
    dbPath: DB_PATH,
  };
}

// ── Background capture (optional via env CAPTURE_INTERVAL_MS) ──────────────

let intervalHandle: NodeJS.Timeout | null = null;
export function startBackgroundCapture(intervalMs: number): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(() => {
    captureActiveWindow().catch(err => process.stderr.write(`[capture-loop] ${err?.message}\n`));
  }, intervalMs);
  process.stderr.write(`[anchor-activity-mcp] background capture every ${intervalMs}ms\n`);
}

// ── Ring-buffer pruning (every capture, cheap) ─────────────────────────────

function prune(): void {
  db.prepare("DELETE FROM captures WHERE captured_at < datetime('now', ?)").run(`-${RETENTION_DAYS} days`);
}
