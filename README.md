# anchor-activity-mcp

Cross-platform desktop activity tracking as an **MCP server**. Captures the active window (app, title, URL) on macOS / Windows / Linux. Stores in a local SQLite ring buffer. Exposes 4 MCP tools.

Built as part of the [anchor](https://github.com/123oqwe/anchor-backend) personal-AI ecosystem, but works standalone with any MCP host (Claude Desktop, Cursor, etc).

## Tools exposed

| Tool | Description |
|------|------|
| `activity_capture_now` | Capture current active window: app, title, URL (browsers only) |
| `activity_recent` | Get the last N captures from the local ring buffer |
| `activity_summary` | Aggregated activity for the last N hours: top apps, unique activities, meetings |
| `activity_status` | Health: last capture timestamp, total captures in 24h, platform |

## Install

```bash
npx -y @anchor/activity-mcp
```

Or globally:
```bash
npm i -g @anchor/activity-mcp
anchor-activity-mcp   # speaks MCP on stdio
```

## Use with anchor-backend

Add to anchor-backend's MCP server registry:

```bash
curl -X POST http://localhost:3001/api/mcp/servers -H "Content-Type: application/json" -d '{
  "name": "anchor-activity",
  "command": "npx",
  "args": ["-y", "@anchor/activity-mcp"]
}'
```

After connection, four tools auto-register as `mcp_anchor_activity_*`. Custom agents and Decision Agent can use them. Anchor's cron schedules `mcp_anchor_activity_capture_now` every 5 min.

## Use with Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac) or equivalent:

```json
{
  "mcpServers": {
    "anchor-activity": {
      "command": "npx",
      "args": ["-y", "@anchor/activity-mcp"]
    }
  }
}
```

## Background capture

By default, this server only captures when its tools are called. To capture every N ms in background, set:

```bash
CAPTURE_INTERVAL_MS=300000 anchor-activity-mcp   # 5 min
```

## Configuration

| Env var | Default | Meaning |
|---------|---------|------|
| `ANCHOR_ACTIVITY_DIR` | `~/.anchor-activity-mcp` | Where to store the SQLite DB |
| `ANCHOR_ACTIVITY_RETENTION_DAYS` | `30` | How long to keep captures before pruning |
| `CAPTURE_INTERVAL_MS` | `0` (off) | Background capture interval |

## Platform notes

- **macOS**: needs Accessibility permission for active-win to read window titles. Granted on first attempt; if denied, only app name is captured.
- **Windows**: works out of the box on Windows 10+.
- **Linux**: works on X11 (xdotool not required). Wayland support is best-effort.

## Privacy

- All captures stay on your machine in `ANCHOR_ACTIVITY_DIR`.
- No network calls. No telemetry.
- Old captures auto-prune per `ANCHOR_ACTIVITY_RETENTION_DAYS`.
- To wipe: `rm -rf ~/.anchor-activity-mcp`.

## License

MIT
