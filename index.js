"use strict";

const { addLog, getLogs } = require("./logger");
const rootLog = addLog;
const mineflayer = require("mineflayer");
const { Movements, pathfinder, goals } = require("mineflayer-pathfinder");
const { GoalBlock } = goals;
const config = require("./settings.json");
const express = require("express");
const http = require("http");
const https = require("https");

// ============================================================
// EXPRESS SERVER - Keep Render/Aternos alive
// ============================================================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 5000;

// ============================================================
// WEB PANEL (public/index.html) + API
// Set PANEL_PASSWORD env var to protect the panel with a password.
// ============================================================
const path = require("path");
const fs = require("fs");
const SECRET = "********";

app.use((req, res, next) => {
  const pass = process.env.PANEL_PASSWORD;
  if (!pass || req.path === "/ping" || req.path.startsWith("/hook/")) return next();
  const [scheme, token] = (req.headers.authorization || "").split(" ");
  const given =
    scheme === "Basic"
      ? Buffer.from(token || "", "base64").toString().split(":").slice(1).join(":")
      : "";
  if (given === pass) return next();
  res.set("WWW-Authenticate", 'Basic realm="AFK Bot Panel"').status(401).send("Password required");
});

app.use(express.static(path.join(__dirname, "public"), { index: false })); // manifest, service worker, ikon
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/api/logs", (req, res) => res.json({ logs: getLogs() }));
app.get("/api/logs/download", (req, res) =>
  res.download(require("./logger").file, "bot.log", (err) => { if (err && !res.headersSent) res.status(404).send("Belum ada log"); }));

app.get("/api/config", (req, res) => {
  const c = JSON.parse(JSON.stringify(config));
  if (c["bot-account"]?.password) c["bot-account"].password = SECRET;
  if (c.utils?.["auto-auth"]?.password) c.utils["auto-auth"].password = SECRET;
  if (c.discord?.webhookUrl) c.discord.webhookUrl = SECRET;
  if (c.telegram?.token) c.telegram.token = SECRET;
  if (c.api?.token) c.api.token = SECRET;
  res.json(c);
});

// Ubah alasan kick (JSON chat, komponen chat, atau NBT 1.20.3+) menjadi teks biasa
function simplifyNbt(n) {
  if (n && typeof n === "object" && typeof n.type === "string" && "value" in n) {
    if (n.type === "compound") {
      const o = {};
      for (const k of Object.keys(n.value || {})) o[k] = simplifyNbt(n.value[k]);
      return o;
    }
    if (n.type === "list") {
      const v = n.value && n.value.value !== undefined ? n.value.value : [];
      return (Array.isArray(v) ? v : [v]).map((x) => simplifyNbt(n.value && n.value.type === "compound" ? { type: "compound", value: x } : x));
    }
    return n.value;
  }
  return n;
}
function flattenChat(c, depth) {
  depth = depth || 0;
  if (c == null || depth > 12) return "";
  if (typeof c === "string") return c;
  if (typeof c === "number" || typeof c === "boolean") return String(c);
  if (Array.isArray(c)) return c.map((x) => flattenChat(x, depth + 1)).join("");
  let out = "";
  if (c.text != null) out += flattenChat(c.text, depth + 1);
  else if (c.translate) {
    const args = Array.isArray(c.with) ? c.with.map((x) => flattenChat(x, depth + 1)) : [];
    out += args.length ? args.join(" ") : String(c.translate);
  }
  if (c.extra) out += flattenChat(c.extra, depth + 1);
  return out;
}
function readableReason(reason) {
  try {
    let r = reason;
    if (typeof r === "string") {
      const t = r.trim();
      if (t[0] === "{" || t[0] === "[") { try { r = JSON.parse(t); } catch (e) { return t.replace(/§./g, "").trim(); } }
      else return t.replace(/§./g, "").trim();
    }
    const txt = flattenChat(simplifyNbt(r)).replace(/§./g, "").replace(/\s+/g, " ").trim();
    return txt || JSON.stringify(reason);
  } catch (e) { return String(reason); }
}

function mergeConfig(target, src) {
  for (const k of Object.keys(src)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (src[k] === SECRET) continue; // unchanged secret
    if (src[k] && typeof src[k] === "object" && !Array.isArray(src[k])) {
      if (!target[k] || typeof target[k] !== "object") target[k] = {};
      mergeConfig(target[k], src[k]);
    } else target[k] = src[k];
  }
}

// Penyimpanan permanen: set env DATA_DIR ke folder Volume (mis. /data)
const DATA_DIR = process.env.DATA_DIR;
const SETTINGS_FILE = path.join(DATA_DIR || __dirname, "settings.json");
if (DATA_DIR) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(SETTINGS_FILE)) mergeConfig(config, JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")));
  } catch (e) { addLog("[Server] Gagal memuat settings dari DATA_DIR: " + e.message); }
}

app.post("/api/config", (req, res) => {
  const b = req.body || {};
  const sv = b.server || {};
  if (sv.ip !== undefined && !String(sv.ip).trim())
    return res.status(400).json({ success: false, msg: "Server IP is empty" });
  if (sv.port !== undefined && !(Number(sv.port) > 0 && Number(sv.port) < 65536))
    return res.status(400).json({ success: false, msg: "Invalid port" });
  try {
    mergeConfig(config, b);
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(config, null, 2));
    addLog("[Control] Settings saved - restarting bot");
    manager.build();
    setTimeout(() => manager.startAll(), 3000);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, msg: e.message });
  }
});

// Old built-in dashboard (still available)
app.get('/classic', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name} Dashboard</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" media="print" onload="this.media='all'"
              href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
        <style>
          *, *::before, *::after { box-sizing: border-box; }

          body {
            font-family: 'Inter', -apple-system, sans-serif;
            background: #0d1117;
            color: #e6edf3;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            padding: 24px;
          }

          main { width: 100%; max-width: 400px; }

          header { margin-bottom: 28px; }
          header h1 {
            font-size: 26px;
            font-weight: 700;
            color: #f0f6fc;
            margin: 0;
            line-height: 1.2;
          }
          header p {
            font-size: 14px;
            color: #8b949e;
            margin: 6px 0 0;
            line-height: 1.5;
          }

          .status-section {
            border-radius: 12px;
            padding: 20px 24px;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 16px;
            transition: background 0.3s, border-color 0.3s;
          }
          .status-section.online  { background: #0d2218; border: 2px solid #238636; }
          .status-section.offline { background: #200d0d; border: 2px solid #da3633; }

          .status-icon {
            width: 44px; height: 44px;
            border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            font-size: 20px; flex-shrink: 0;
            transition: background 0.3s;
          }
          .status-icon.online  { background: #238636; }
          .status-icon.offline { background: #da3633; }

          .status-label { font-size: 18px; font-weight: 700; line-height: 1.2; transition: color 0.3s; }
          .status-label.online  { color: #3fb950; }
          .status-label.offline { color: #f85149; }
          .status-detail { font-size: 13px; color: #8b949e; margin-top: 3px; }

          dl { margin: 0; }
          .stat-card {
            background: #161b22;
            border: 1px solid #21262d;
            border-radius: 10px;
            padding: 16px 20px;
            margin-bottom: 10px;
          }
          dt { font-size: 12px; color: #8b949e; font-weight: 600; margin-bottom: 4px; }
          dd { margin: 0; font-size: 17px; font-weight: 600; color: #e6edf3; line-height: 1.3; }
          .stat-detail { margin: 4px 0 0; font-size: 11px; color: #6e7681; }

          .controls { margin-top: 8px; }
          .btn-grid { display: grid; gap: 10px; margin-bottom: 10px; }
          .btn-grid-2 { grid-template-columns: 1fr 1fr; }

          .btn-primary {
            min-height: 52px; border-radius: 10px;
            font-size: 15px; font-weight: 700;
            cursor: pointer; letter-spacing: 0.3px;
            transition: opacity 0.2s, filter 0.2s;
            font-family: inherit;
          }
          .btn-primary:hover  { filter: brightness(1.1); }
          .btn-primary:active { opacity: 0.85; }
          .btn-start { border: 2px solid #238636; background: #0d2218; color: #3fb950; }
          .btn-stop  { border: 2px solid #da3633; background: #200d0d; color: #f85149; }

          .btn-secondary {
            min-height: 44px; border-radius: 10px;
            border: 1px solid #21262d; background: #161b22; color: #8b949e;
            font-size: 13px; font-weight: 500;
            text-decoration: none;
            display: flex; align-items: center; justify-content: center;
            font-family: inherit; cursor: pointer;
            transition: background 0.2s, color 0.2s;
          }
          .btn-secondary:hover { background: #21262d; color: #c9d1d9; }

          footer { margin-top: 20px; text-align: center; }
          footer p { font-size: 12px; color: #484f58; margin: 0; }
        </style>
      </head>
      <body>
        <main role="main" aria-label="AFK Bot Dashboard">

          <header>
            <h1>AFK Bot Dashboard</h1>
            <p>Minecraft server bot &middot; Live status</p>
          </header>

          <section
            id="status-section"
            role="status"
            aria-live="polite"
            aria-label="Bot connection status"
            class="status-section offline"
          >
            <div id="status-icon" aria-hidden="true" class="status-icon offline">&#x2717;</div>
            <div>
              <div id="status-label" class="status-label offline">Connecting…</div>
              <div id="status-detail" class="status-detail">Establishing connection</div>
            </div>
          </section>

          <section aria-label="Bot statistics">
            <dl>
              <div class="stat-card">
                <dt>Uptime</dt>
                <dd id="uptime-text">—</dd>
                <p class="stat-detail">Time since last connection</p>
              </div>
              <div class="stat-card">
                <dt>Coordinates</dt>
                <dd id="coords-text">Searching…</dd>
                <p class="stat-detail">Bot's current in-game position</p>
              </div>
              <div class="stat-card">
                <dt>Server address</dt>
                <dd>${config.server.ip}</dd>
                <p class="stat-detail">Minecraft server hostname</p>
              </div>
            </dl>
          </section>

          <section class="controls" aria-label="Bot controls">
            <div class="btn-grid btn-grid-2">
              <button class="btn-primary btn-start" onclick="startBot()" aria-label="Start bot">Start bot</button>
              <button class="btn-primary btn-stop" onclick="stopBot()" aria-label="Stop bot">Stop bot</button>
            </div>
            <div class="btn-grid btn-grid-2">
              <a href="/tutorial" class="btn-secondary" aria-label="View setup guide">Setup guide</a>
              <a href="/logs" class="btn-secondary" aria-label="View bot logs">View logs</a>
            </div>
          </section>

          <footer>
            <p>Status updates every 5 seconds</p>
          </footer>

        </main>

        <script>
          function formatUptime(s) {
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            const sec = s % 60;
            if (h > 0) return h + 'h ' + m + 'm ' + sec + 's';
            if (m > 0) return m + 'm ' + sec + 's';
            return sec + ' seconds';
          }

          async function update() {
            try {
              const r = await fetch('/health');
              const data = await r.json();
              const online = data.status === 'connected';

              const section = document.getElementById('status-section');
              const icon    = document.getElementById('status-icon');
              const label   = document.getElementById('status-label');
              const detail  = document.getElementById('status-detail');

              section.className = 'status-section ' + (online ? 'online' : 'offline');
              icon.className    = 'status-icon '    + (online ? 'online' : 'offline');
              icon.textContent  = online ? '✓' : '✗';
              label.className   = 'status-label '   + (online ? 'online' : 'offline');
              label.textContent = online ? 'Connected' : 'Disconnected';
              detail.textContent = online ? 'Bot is active on the server' : 'Attempting to reconnect';

              document.getElementById('uptime-text').textContent = formatUptime(data.uptime);

              if (data.coords) {
                const x = Math.floor(data.coords.x);
                const y = Math.floor(data.coords.y);
                const z = Math.floor(data.coords.z);
                document.getElementById('coords-text').textContent = 'X ' + x + ', Y ' + y + ', Z ' + z;
              } else {
                document.getElementById('coords-text').textContent = 'Searching…';
              }
            } catch (e) {
              const label = document.getElementById('status-label');
              label.className = 'status-label offline';
              label.textContent = 'Unreachable';
            }
          }

          async function startBot() {
            const r = await fetch('/start', { method: 'POST' });
            const data = await r.json();
            alert(data.success ? 'Bot started!' : data.msg);
            update();
          }

          async function stopBot() {
            const r = await fetch('/stop', { method: 'POST' });
            const data = await r.json();
            alert(data.success ? 'Bot stopped!' : data.msg);
            update();
          }

          setInterval(update, 5000);
          update();
        </script>
      </body>
    </html>
  `);
});
app.get("/tutorial", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name} - Setup Guide</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" media="print" onload="this.media='all'"
              href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
        <style>
          *, *::before, *::after { box-sizing: border-box; }

          body {
            font-family: 'Inter', -apple-system, sans-serif;
            background: #0d1117;
            color: #e6edf3;
            margin: 0;
            padding: 40px 24px;
          }

          main {
            width: 100%;
            max-width: 560px;
            margin: 0 auto;
          }

          .back-btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 13px;
            font-weight: 500;
            color: #8b949e;
            text-decoration: none;
            background: #161b22;
            border: 1px solid #21262d;
            border-radius: 8px;
            padding: 7px 14px;
            margin-bottom: 32px;
            transition: color 0.2s, background 0.2s;
          }
          .back-btn:hover { background: #21262d; color: #c9d1d9; }

          header { margin-bottom: 32px; }
          header h1 {
            font-size: 26px;
            font-weight: 700;
            color: #f0f6fc;
            margin: 0;
            line-height: 1.2;
          }
          header p {
            font-size: 14px;
            color: #8b949e;
            margin: 6px 0 0;
            line-height: 1.5;
          }

          .step-card {
            background: #161b22;
            border: 1px solid #21262d;
            border-radius: 12px;
            padding: 24px;
            margin-bottom: 16px;
          }

          .step-header {
            display: flex;
            align-items: center;
            gap: 14px;
            margin-bottom: 18px;
          }

          .step-number {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            background: #0d2218;
            border: 2px solid #238636;
            color: #3fb950;
            font-size: 14px;
            font-weight: 700;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
          }

          .step-title {
            font-size: 16px;
            font-weight: 700;
            color: #f0f6fc;
            margin: 0;
          }

          ol {
            margin: 0;
            padding: 0;
            list-style: none;
            display: flex;
            flex-direction: column;
            gap: 10px;
          }

          li {
            font-size: 14px;
            color: #8b949e;
            line-height: 1.6;
            padding-left: 20px;
            position: relative;
          }

          li::before {
            content: "·";
            position: absolute;
            left: 6px;
            color: #3fb950;
            font-weight: 700;
          }

          li strong { color: #e6edf3; font-weight: 600; }

          code {
            background: #21262d;
            border: 1px solid #30363d;
            padding: 2px 7px;
            border-radius: 5px;
            font-family: 'SF Mono', 'Fira Code', monospace;
            font-size: 12px;
            color: #e6edf3;
          }

          a { color: #58a6ff; text-decoration: none; }
          a:hover { text-decoration: underline; }

          footer {
            margin-top: 32px;
            text-align: center;
          }
          footer p { font-size: 12px; color: #484f58; margin: 0; }
        </style>
      </head>
      <body>
        <main>
          <a href="/" class="back-btn">&#8592; Back to Dashboard</a>

          <header>
            <h1>Setup Guide</h1>
            <p>Get your AFK bot running in under 15 minutes</p>
          </header>

          <div class="step-card">
            <div class="step-header">
              <div class="step-number">1</div>
              <h2 class="step-title">Configure Aternos</h2>
            </div>
            <ol>
              <li>Go to <strong>Aternos</strong> and open your server.</li>
              <li>Install <strong>Paper/Bukkit</strong> as your server software.</li>
              <li>Enable <strong>Cracked</strong> mode using the green switch.</li>
              <li>Install these plugins: <code>ViaVersion</code>, <code>ViaBackwards</code>, <code>ViaRewind</code></li>
            </ol>
          </div>

          <div class="step-card">
            <div class="step-header">
              <div class="step-number">2</div>
              <h2 class="step-title">GitHub Setup</h2>
            </div>
            <ol>
              <li>Download this project as a ZIP and extract it.</li>
              <li>Edit <code>settings.json</code> with your server IP and port.</li>
              <li>Upload all files to a new <strong>GitHub Repository</strong>.</li>
            </ol>
          </div>

          <div class="step-card">
            <div class="step-header">
              <div class="step-number">3</div>
              <h2 class="step-title">Deploy on Replit (Free 24/7)</h2>
            </div>
            <ol>
              <li>Import your GitHub repo into <strong>Replit</strong>.</li>
              <li>Set the run command to <code>npm start</code>.</li>
              <li>Hit <strong>Run</strong> — the bot connects automatically.</li>
              <li>The bot pings itself every 10 minutes to stay alive.</li>
            </ol>
          </div>

          <footer>
            <p>AFK Bot Dashboard &middot; ${config.name}</p>
          </footer>
        </main>
      </body>
    </html>
  `);
});

app.get("/health", (req, res) => {
  const b = manager.summary();
  const first = b.find((x) => x.connected) || b[0] || {};
  res.json({
    status: b.some((x) => x.connected) ? "connected" : "disconnected",
    running: b.some((x) => x.running),
    uptime: Math.floor(process.uptime()),
    coords: first.coords || null,
    reconnectAttempts: first.reconnects || 0,
    memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024,
    bots: b,
  });
});

app.get("/ping", (req, res) => res.send("pong"));

app.get("/logs", (req, res) => {
  const logs = getLogs();

  const escapeHTML = (str) =>
    str.replace(
      /[&<>"']/g,
      (m) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[m],
    );

  const logCount = logs.length;

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name} - Logs</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" media="print" onload="this.media='all'"
              href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
        <style>
          *, *::before, *::after { box-sizing: border-box; }

          body {
            font-family: 'Inter', -apple-system, sans-serif;
            background: #0d1117;
            color: #e6edf3;
            margin: 0;
            padding: 40px 24px;
          }

          main {
            width: 100%;
            max-width: 760px;
            margin: 0 auto;
          }

          .back-btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 13px;
            font-weight: 500;
            color: #8b949e;
            text-decoration: none;
            background: #161b22;
            border: 1px solid #21262d;
            border-radius: 8px;
            padding: 7px 14px;
            margin-bottom: 32px;
            transition: color 0.2s, background 0.2s;
          }
          .back-btn:hover { background: #21262d; color: #c9d1d9; }

          .page-header {
            display: flex;
            align-items: flex-end;
            justify-content: space-between;
            margin-bottom: 20px;
            gap: 12px;
            flex-wrap: wrap;
          }

          .page-header-left h1 {
            font-size: 26px;
            font-weight: 700;
            color: #f0f6fc;
            margin: 0;
            line-height: 1.2;
          }
          .page-header-left p {
            font-size: 14px;
            color: #8b949e;
            margin: 6px 0 0;
          }

          .badge {
            font-size: 12px;
            font-weight: 600;
            color: #8b949e;
            background: #161b22;
            border: 1px solid #21262d;
            border-radius: 20px;
            padding: 4px 12px;
            white-space: nowrap;
          }

          .log-card {
            background: #0d1117;
            border: 1px solid #21262d;
            border-radius: 12px;
            overflow: hidden;
          }

          .log-card-header {
            background: #161b22;
            border-bottom: 1px solid #21262d;
            padding: 12px 18px;
            display: flex;
            align-items: center;
            gap: 8px;
          }

          .dot { width: 10px; height: 10px; border-radius: 50%; }
          .dot-red   { background: #ff5f57; }
          .dot-yellow{ background: #ffbd2e; }
          .dot-green { background: #28c840; }

          .log-card-title {
            font-size: 12px;
            font-weight: 500;
            color: #484f58;
            margin-left: 4px;
          }

          .log-body {
            padding: 16px 18px;
            max-height: 560px;
            overflow-y: auto;
            font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
            font-size: 12.5px;
            line-height: 1.7;
          }

          .log-entry { display: block; padding: 1px 0; white-space: pre-wrap; word-break: break-all; }
          .log-entry.error   { color: #ff7b72; }
          .log-entry.warn    { color: #e3b341; }
          .log-entry.success { color: #3fb950; }
          .log-entry.control { color: #58a6ff; }
          .log-entry.default { color: #8b949e; }

          .empty-state {
            text-align: center;
            padding: 40px 20px;
            color: #484f58;
            font-size: 13px;
          }

          .refresh-bar {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 6px;
            margin-top: 12px;
            font-size: 12px;
            color: #484f58;
          }
          .refresh-dot {
            width: 7px; height: 7px;
            border-radius: 50%;
            background: #3fb950;
            animation: pulse 2s infinite;
          }
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.3; }
          }

          .console-row {
            display: flex;
            align-items: center;
            border-top: 1px solid #21262d;
            background: #0d1117;
            padding: 10px 18px;
            gap: 10px;
          }

          .console-prompt {
            font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
            font-size: 13px;
            color: #3fb950;
            font-weight: 700;
            flex-shrink: 0;
            user-select: none;
          }

          .console-input {
            flex: 1;
            background: transparent;
            border: none;
            outline: none;
            font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
            font-size: 12.5px;
            color: #e6edf3;
            caret-color: #3fb950;
          }

          .console-input::placeholder { color: #484f58; }

          .console-send {
            background: #0d2218;
            border: 1px solid #238636;
            color: #3fb950;
            font-size: 12px;
            font-weight: 600;
            padding: 5px 14px;
            border-radius: 6px;
            cursor: pointer;
            font-family: inherit;
            transition: background 0.2s;
            flex-shrink: 0;
          }
          .console-send:hover { background: #122d1a; }
          .console-send:disabled { opacity: 0.5; cursor: default; }

          .console-wrap {
            position: relative;
          }

          .cmd-suggestions {
            display: none;
            position: absolute;
            bottom: calc(100% + 6px);
            left: 0; right: 0;
            background: #161b22;
            border: 1px solid #30363d;
            border-radius: 10px;
            overflow: hidden;
            box-shadow: 0 8px 24px rgba(0,0,0,0.5);
            z-index: 10;
          }

          .cmd-suggestions.visible { display: block; }

          .cmd-item {
            display: flex;
            align-items: baseline;
            gap: 12px;
            padding: 9px 16px;
            cursor: pointer;
            transition: background 0.12s;
            border-bottom: 1px solid #21262d;
          }
          .cmd-item:last-child { border-bottom: none; }
          .cmd-item:hover, .cmd-item.active {
            background: #21262d;
          }

          .cmd-name {
            font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
            font-size: 12.5px;
            font-weight: 700;
            color: #3fb950;
            flex-shrink: 0;
            min-width: 90px;
          }

          .cmd-desc {
            font-size: 12px;
            color: #6e7681;
          }

          footer { margin-top: 32px; text-align: center; }
          footer p { font-size: 12px; color: #484f58; margin: 0; }
        </style>
      </head>
      <body>
        <main>
          <a href="/" class="back-btn">&#8592; Back to Dashboard</a>

          <div class="page-header">
            <div class="page-header-left">
              <h1>Bot Logs</h1>
              <p>Live output from the AFK bot</p>
            </div>
            <span class="badge">${logCount} ${logCount === 1 ? "entry" : "entries"}</span>
          </div>

          <div class="log-card">
            <div class="log-card-header">
              <span class="dot dot-red"></span>
              <span class="dot dot-yellow"></span>
              <span class="dot dot-green"></span>
              <span class="log-card-title">bot.log</span>
            </div>
            <div class="log-body" id="log-body">
              ${logCount === 0
                ? `<div class="empty-state">No log entries yet. Start the bot to see output.</div>`
                : logs.map((l) => {
                    const escaped = escapeHTML(l);
                    const lower = l.toLowerCase();
                    let cls = "default";
                    if (lower.includes("error") || lower.includes("fail")) cls = "error";
                    else if (lower.includes("warn")) cls = "warn";
                    else if (lower.includes("[control]")) cls = "control";
                    else if (lower.includes("connect") || lower.includes("join") || lower.includes("spawn")) cls = "success";
                    return `<span class="log-entry ${cls}">${escaped}</span>`;
                  }).join("")
              }
            </div>
            <div class="console-wrap">
              <div class="cmd-suggestions" id="cmd-suggestions"></div>
              <div class="console-row">
                <span class="console-prompt">&gt;</span>
                <input
                  id="console-input"
                  class="console-input"
                  type="text"
                  placeholder="Type / for commands, or any message…"
                  autocomplete="off"
                  spellcheck="false"
                >
                <button id="console-send" class="console-send">Send</button>
              </div>
            </div>
          </div>

          <div class="refresh-bar">
            <span class="refresh-dot"></span>
            <span id="refresh-label">Auto-refreshing every 5 seconds</span>
          </div>

          <footer>
            <p>AFK Bot Dashboard &middot; ${config.name}</p>
          </footer>
        </main>

        <script>
          (function() {
            var logBody  = document.getElementById('log-body');
            var input    = document.getElementById('console-input');
            var sendBtn  = document.getElementById('console-send');
            var label    = document.getElementById('refresh-label');
            var sugBox   = document.getElementById('cmd-suggestions');
            var refreshTimer = null;
            var typing = false;
            var activeIdx = -1;

            var COMMANDS = [
              { name: '/help',   desc: 'Show all available commands' },
              { name: '/pos',    desc: "Show bot's current coordinates" },
              { name: '/status', desc: 'Show connection status & uptime' },
              { name: '/list',   desc: 'List players on the server' },
              { name: '/say',    desc: 'Send a chat message in-game' },
            ];

            function scrollBottom() {
              if (logBody) logBody.scrollTop = logBody.scrollHeight;
            }

            function scheduleRefresh() {
              clearTimeout(refreshTimer);
              if (!typing) {
                refreshTimer = setTimeout(function() { location.reload(); }, 5000);
              }
            }

            function appendLocalEntry(text, cls) {
              var span = document.createElement('span');
              span.className = 'log-entry ' + (cls || 'control');
              span.textContent = text;
              logBody.appendChild(span);
              scrollBottom();
            }

            function hideSuggestions() {
              sugBox.classList.remove('visible');
              sugBox.innerHTML = '';
              activeIdx = -1;
            }

            function setActive(idx) {
              var items = sugBox.querySelectorAll('.cmd-item');
              items.forEach(function(el, i) {
                el.classList.toggle('active', i === idx);
              });
              activeIdx = idx;
            }

            function showSuggestions(val) {
              var query = val.toLowerCase();
              var matches = COMMANDS.filter(function(c) {
                return c.name.startsWith(query);
              });

              if (!matches.length) { hideSuggestions(); return; }

              sugBox.innerHTML = matches.map(function(c, i) {
                return '<div class="cmd-item" data-cmd="' + c.name + '">' +
                  '<span class="cmd-name">' + c.name + '</span>' +
                  '<span class="cmd-desc">' + c.desc + '</span>' +
                '</div>';
              }).join('');

              sugBox.querySelectorAll('.cmd-item').forEach(function(el) {
                el.addEventListener('mousedown', function(e) {
                  e.preventDefault();
                  input.value = el.dataset.cmd + ' ';
                  hideSuggestions();
                  input.focus();
                });
              });

              activeIdx = -1;
              sugBox.classList.add('visible');
            }

            input.addEventListener('input', function() {
              var val = input.value;
              if (val.startsWith('/')) {
                showSuggestions(val);
              } else {
                hideSuggestions();
              }
            });

            input.addEventListener('keydown', function(e) {
              var items = sugBox.querySelectorAll('.cmd-item');
              if (sugBox.classList.contains('visible') && items.length) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive(Math.min(activeIdx + 1, items.length - 1));
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive(Math.max(activeIdx - 1, 0));
                  return;
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && activeIdx >= 0)) {
                  e.preventDefault();
                  var chosen = items[activeIdx >= 0 ? activeIdx : 0];
                  input.value = chosen.dataset.cmd + ' ';
                  hideSuggestions();
                  return;
                }
                if (e.key === 'Escape') {
                  hideSuggestions();
                  return;
                }
              }
              if (e.key === 'Enter') sendCommand();
            });

            function sendCommand() {
              var cmd = input.value.trim();
              if (!cmd) return;
              hideSuggestions();
              input.value = '';
              sendBtn.disabled = true;
              appendLocalEntry('> ' + cmd, 'control');

              fetch('/command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: cmd })
              })
              .then(function(r) { return r.json(); })
              .then(function(data) {
                if (data.msg) {
                  data.msg.split('\\n').forEach(function(line) {
                    appendLocalEntry(line, data.success ? 'default' : 'error');
                  });
                }
              })
              .catch(function() {
                appendLocalEntry('Failed to send command.', 'error');
              })
              .finally(function() {
                sendBtn.disabled = false;
                input.focus();
                scheduleRefresh();
              });
            }

            sendBtn.addEventListener('click', sendCommand);

            input.addEventListener('focus', function() {
              typing = true;
              clearTimeout(refreshTimer);
              label.textContent = 'Auto-refresh paused while typing';
            });
            input.addEventListener('blur', function() {
              setTimeout(function() {
                hideSuggestions();
                typing = false;
                label.textContent = 'Auto-refreshing every 5 seconds';
                scheduleRefresh();
              }, 150);
            });

            scrollBottom();
            scheduleRefresh();
          })();
        </script>
      </body>
    </html>
  `);
});

// Data bot tambahan: username + (opsional) server sendiri + pesan otomatis sendiri
function cleanBot(b) {
  const o = { username: String(b.username || "").trim() };
  const ip = String(b.ip || "").trim();
  if (ip) {
    if (!/^[A-Za-z0-9._:-]{1,253}$/.test(ip)) throw new Error("IP / hostname tidak valid");
    const port = b.port === "" || b.port == null ? 25565 : Number(b.port);
    if (!(port > 0 && port < 65536)) throw new Error("Port tidak valid (1-65535)");
    o.server = { ip, port };
    const v = String(b.version || "").trim();
    if (v) o.server.version = v;
  }
  const msgs = (Array.isArray(b.messages) ? b.messages : []).map((m) => String(m).trim()).filter(Boolean).slice(0, 30);
  if (msgs.length) o.messages = msgs;
  const d = Number(b.delay);
  if (msgs.length && d > 0) o.delay = Math.max(5, Math.floor(d));
  return o;
}

app.post("/api/bots", (req, res) => {
  let entry;
  try { entry = cleanBot(req.body || {}); } catch (e) { return res.status(400).json({ success: false, msg: e.message }); }
  const name = entry.username;
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name))
    return res.status(400).json({ success: false, msg: "Username: 3-16 huruf/angka/_" });
  if (manager.get(name))
    return res.status(400).json({ success: false, msg: "Username sudah dipakai" });
  config.bots = (config.bots || []).concat(entry);
  manager.save();
  const b = makeBot(name, entry, config);
  manager.list.push(b);
  manager.startLater(b, 0);
  addLog(`[Control] Added bot ${name}${entry.server ? " -> " + entry.server.ip + ":" + entry.server.port : ""}`);
  res.json({ success: true });
});

// Ubah server / pesan bot tambahan; bot dimulai ulang bila sedang berjalan
app.put("/api/bots/:id", (req, res) => {
  const i = manager.list.findIndex((b) => b.id === req.params.id);
  if (i < 1) return res.status(400).json({ success: false, msg: i === 0 ? "Bot utama diubah lewat tab Pengaturan" : "Bot tidak ditemukan" });
  let entry;
  try { entry = cleanBot(Object.assign({}, req.body, { username: req.params.id })); } catch (e) { return res.status(400).json({ success: false, msg: e.message }); }
  config.bots = (config.bots || []).map((b) => (b.username === entry.username ? entry : b));
  manager.save();
  const old = manager.list[i], was = old.running;
  manager.stop(old);
  const nb = makeBot(entry.username, entry, config);
  manager.list[i] = nb;
  if (was) manager.startLater(nb, 1500);
  addLog(`[Control] Updated bot ${entry.username}`);
  res.json({ success: true });
});

app.delete("/api/bots/:id", (req, res) => {
  const i = manager.list.findIndex((b) => b.id === req.params.id);
  if (i < 1)
    return res.status(400).json({ success: false, msg: i === 0 ? "Bot utama tidak bisa dihapus" : "Bot tidak ditemukan" });
  manager.stop(manager.list[i]);
  manager.list.splice(i, 1);
  config.bots = (config.bots || []).filter((b) => b.username !== req.params.id);
  manager.save();
  addLog(`[Control] Removed bot ${req.params.id}`);
  res.json({ success: true });
});

app.post("/api/bots/:id/:action", (req, res) => {
  const t = req.params.id === "all" ? manager.list : manager.list.filter((b) => b.id === req.params.id);
  if (!t.length) return res.status(404).json({ success: false, msg: "Bot tidak ditemukan" });
  if (req.params.action === "start") t.forEach((b, i) => !b.running && manager.startLater(b, i * 6000));
  else if (req.params.action === "stop") t.forEach((b) => manager.stop(b));
  else if (req.params.action === "restart") t.forEach((b, i) => { manager.stop(b); manager.startLater(b, 1500 + i * 6000); });
  else return res.status(400).json({ success: false, msg: "Aksi tidak dikenal" });
  addLog(`[Control] ${req.params.action} ${req.params.id}`);
  res.json({ success: true });
});

// Old dashboard buttons
app.post("/start", (req, res) => { manager.startAll(); res.json({ success: true }); });
app.post("/stop", (req, res) => { manager.list.forEach((b) => manager.stop(b)); res.json({ success: true }); });

app.post("/command", (req, res) => {
  const cmd = (req.body.command || "").trim();
  if (!cmd) return res.json({ success: false, msg: "Empty command." });
  const t = req.body.bot || "all";
  const targets = t === "all" ? manager.list : manager.list.filter((b) => b.id === t);
  if (!targets.length) return res.json({ success: false, msg: "Bot not found." });
  addLog(`[Console] > ${cmd}`);

  if (cmd === "/help") {
    const lines = [
      "/help  /pos  /status  /list  /say <msg>",
      "/goto x y z  /follow <player>  /come <player>  /stop",
      "/<anything> = Minecraft command, plain text = chat",
    ];
    lines.forEach((l) => addLog(`[Console] ${l}`));
    return res.json({ success: true, msg: lines.join("\n") });
  }

  const mv = require("./extras").command(cmd, targets);
  if (mv) { mv.forEach((l) => addLog(`[Console] ${l}`)); return res.json({ success: true, msg: mv.join("\n") }); }

  const out = targets.map((b) => {
    const bot = b.bot, st = b.botState;
    if (cmd === "/pos" || cmd === "/coords") {
      const p = bot && bot.entity ? bot.entity.position : null;
      return p ? `[${b.name}] X=${Math.floor(p.x)} Y=${Math.floor(p.y)} Z=${Math.floor(p.z)}` : `[${b.name}] position unavailable`;
    }
    if (cmd === "/status")
      return `[${b.name}] ${st.connected ? "Connected" : "Disconnected"} | Reconnects: ${st.reconnectAttempts}`;
    if (!bot || !st.connected || typeof bot.chat !== "function") return `[${b.name}] not connected`;
    try { bot.chat(cmd); return `[${b.name}] Sent: ${cmd}`; }
    catch (e) { return `[${b.name}] Error: ${e.message}`; }
  });
  out.forEach((l) => addLog(`[Console] ${l}`));
  res.json({ success: true, msg: out.join("\n") });
});

// ============================================================
//                    END OF WEB TOOLS
//============================================================

let lastDiscordSend = 0;
const DISCORD_RATE_LIMIT_MS = 5000; // min 5s between webhook calls

// FIX: handle port conflict gracefully - try next port if taken
const server = app.listen(PORT, "0.0.0.0", () => {
  addLog(`[Server] HTTP server started on port ${server.address().port} `);
});
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    const fallbackPort = PORT + 1;
    addLog(`[Server] Port ${PORT} in use - trying port ${fallbackPort} `);
    server.listen(fallbackPort, "0.0.0.0");
  } else {
    addLog(`[Server] HTTP server error: ${err.message} `);
  }
});

require("./liveproxy")(app, server, config);

// FIX: only one definition of formatUptime
function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s} s`;
}

// ============================================================
// SELF-PING - Prevent Render from sleeping
// FIX: only ping if RENDER_EXTERNAL_URL is set (skip useless localhost ping)
// ============================================================
const SELF_PING_INTERVAL = 10 * 60 * 1000;

function startSelfPing() {
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  if (!renderUrl) {
    addLog(
      "[KeepAlive] No RENDER_EXTERNAL_URL set - self-ping disabled (running locally)",
    );
    return;
  }
  setInterval(() => {
    const protocol = renderUrl.startsWith("https") ? https : http;
    protocol
      .get(`${renderUrl}/ping`, (res) => {
        // Silent success
      })
      .on("error", (err) => {
        addLog(`[KeepAlive] Self-ping failed: ${err.message}`);
      });
  }, SELF_PING_INTERVAL);
  addLog("[KeepAlive] Self-ping system started (every 10 min)");
}

startSelfPing();

// ============================================================
// MEMORY MONITORING
// ============================================================
setInterval(
  () => {
    const mem = process.memoryUsage();
    const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(2);
    addLog(`[Memory] Heap: ${heapMB} MB`);
  },
  5 * 60 * 1000,
);

// ============================================================
// BOT CREATION WITH RECONNECTION LOGIC
// ============================================================
// ============================================================
// RECONNECTION & TIMEOUT MANAGEMENT
// ============================================================
// ============================================================
// ONE BOT INSTANCE (each bot has its own state, timers and username)
// ============================================================
function makeBot(id, account, baseConfig) {
  const name = account.username;
  const addLog = (m) => rootLog(`[${name}] ${m}`);
  const config = Object.assign({}, baseConfig, {
    "bot-account": Object.assign({}, baseConfig["bot-account"], account),
  });
  if (baseConfig.modules && baseConfig.modules.survival) {
    // survival replaces random walking / blind combat, which would fight over the pathfinder
    config.movement = Object.assign({}, baseConfig.movement, { enabled: false });
    config.position = Object.assign({}, baseConfig.position, { enabled: false });
    config.modules = Object.assign({}, baseConfig.modules, { avoidMobs: false, combat: false });
    config.utils = Object.assign({}, baseConfig.utils, { "anti-afk": { enabled: false } });
  }
  // server & pesan khusus per bot (dari config.bots): kosong = ikut pengaturan utama
  if (account.server && account.server.ip) {
    config.server = Object.assign({}, baseConfig.server, account.server, { version: account.server.version || "" });
  }
  if (Array.isArray(account.messages) && account.messages.length) {
    const cm = Object.assign({}, config.utils["chat-messages"], { enabled: true, repeat: true, messages: account.messages });
    if (account.delay > 0) cm["repeat-delay"] = account.delay;
    config.utils = Object.assign({}, config.utils, { "chat-messages": cm });
  }
  let botRunning = false;
  const botState = {
    lastIssue: "",
    drops: 0,
    connected: false,
    connectedAt: 0,
    lastActivity: Date.now(),
    reconnectAttempts: 0,
    errors: [],
    wasThrottled: false,
  };

  let bot = null;
  let activeIntervals = [];
  let reconnectTimeoutId = null;
  let connectionTimeoutId = null;
  let isReconnecting = false;

  function clearBotTimeouts() {
    if (reconnectTimeoutId) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }
    if (connectionTimeoutId) {
      clearTimeout(connectionTimeoutId);
      connectionTimeoutId = null;
    }
  }


  function clearAllIntervals() {
    addLog(`[Cleanup] Clearing ${activeIntervals.length} intervals`);
    activeIntervals.forEach((id) => clearInterval(id));
    activeIntervals = [];
  }

  function addInterval(callback, delay) {
    const id = setInterval(callback, delay);
    activeIntervals.push(id);
    return id;
  }

  function getReconnectDelay() {
    if (botState.wasThrottled) {
      botState.wasThrottled = false;
      const throttleDelay = 60000 + Math.floor(Math.random() * 60000);
      addLog(
        `[Bot] Throttle detected - using extended delay: ${throttleDelay / 1000}s`,
      );
      return throttleDelay;
    }

    // FIX: read auto-reconnect-delay from settings as base delay
    const baseDelay = config.utils["auto-reconnect-delay"] || 3000;
    const maxDelay = config.utils["max-reconnect-delay"] || 30000;
    const delay = Math.min(
      baseDelay * Math.pow(2, botState.reconnectAttempts),
      maxDelay,
    );
    const jitter = Math.floor(Math.random() * 2000);
    return delay + jitter;
  }

  function createBot() {
    if (isReconnecting) {
      addLog("[Bot] Already reconnecting, skipping...");
      return;
    }

    // Cleanup previous bot properly to avoid ghost bots
    if (bot) {
      clearAllIntervals();
      try {
        bot.removeAllListeners();
        bot.end();
      } catch (e) {
        addLog("[Cleanup] Error ending previous bot:", e.message);
      }
      bot = null;
    }

    addLog(`[Bot] Creating bot instance...`);
    addLog(`[Bot] Connecting to ${config.server.ip}:${config.server.port}`);

    try {
      // FIX: use version:false to auto-detect server version so the bot can join any server.
      // If the user explicitly sets a version in settings.json it is still respected.
      const botVersion =
        config.server.version && config.server.version.trim() !== ""
          ? config.server.version
          : false;
      bot = mineflayer.createBot({
        username: config["bot-account"].username,
        password: config["bot-account"].password || undefined,
        auth: config["bot-account"].type,
        host: config.server.ip,
        port: config.server.port,
        version: botVersion,
        hideErrors: false,
        checkTimeoutInterval: 600000,
      });

      bot.loadPlugin(pathfinder);

      // FIX: connection timeout - end the old bot before reconnecting to avoid ghost bots
      clearBotTimeouts();
      connectionTimeoutId = setTimeout(() => {
        if (!botState.connected) {
          addLog("[Bot] Connection timeout - no spawn received");
          try {
            bot.removeAllListeners();
            bot.end();
          } catch (e) {
            /* ignore */
          }
          bot = null;
          scheduleReconnect();
        }
      }, 150000); // 150s - Aternos servers can take 90-120s to finish spawning a player

      // FIX: guard against spawn firing twice (can happen on some servers)
      let spawnHandled = false;

      bot.once("spawn", () => {
        if (spawnHandled) return;
        spawnHandled = true;

        clearBotTimeouts();
        botState.connected = true;
        botState.connectedAt = Date.now();
        botState.lastActivity = Date.now();
        const upAt = botState.connectedAt;
        setTimeout(() => {
          if (botState.connected && botState.connectedAt === upAt) {
            botState.reconnectAttempts = 0;
            botState.drops = 0;
            botState.lastIssue = "";
          }
        }, 60000);
        isReconnecting = false;

        addLog(
          `[Bot] [+] Successfully spawned on server! (Version: ${bot.version})`,
        );
        if (
          config.discord &&
          config.discord.events &&
          config.discord.events.connect
        ) {
          sendDiscordWebhook(
            `[+] **Connected** to \`${config.server.ip}\``,
            0x4ade80,
          );
        }

        // FIX: use bot.version (auto-detected) instead of config value so minecraft-data always matches
        const mcData = require("minecraft-data")(bot.version);
        const defaultMove = new Movements(bot, mcData);
        defaultMove.allowFreeMotion = false;
        defaultMove.canDig = false;
        defaultMove.liquidCost = 1000;
        defaultMove.fallDamageCost = 1000;

        initializeModules(bot, mcData, defaultMove);

        // Attempt creative mode (only works if bot has OP and enabled in settings)
        setTimeout(() => {
          if (bot && botState.connected && config.server["try-creative"]) {
            bot.chat("/gamemode creative");
            addLog("[INFO] Attempted to set creative mode (requires OP)");
          }
        }, 3000);

        bot.on("messagestr", (message) => {
          if (
            message.includes("commands.gamemode.success.self") ||
            message.includes("Set own game mode to Creative Mode")
          ) {
            addLog("[INFO] Bot is now in Creative Mode.");
          }
        });
      });

      // FIX: 'kicked' fires before 'end'. Remove the scheduleReconnect from 'kicked'
      // so that 'end' is the single source of reconnect truth, preventing double-trigger.
      bot.on("kicked", (reason) => {
        // FIX: stringify reason if it's an object to make it readable in logs
        const kickReason = readableReason(reason);
        addLog(`[Bot] Kicked: ${kickReason}`);
      botState.lastIssue = "Kicked: " + String(kickReason).slice(0, 110);
      if (/another location|already (online|logged|connected)|duplicate_login|same name/i.test(String(kickReason))) {
        botState.wasThrottled = true;
        botState.lastIssue = "Username dipakai di tempat lain (bot dobel?) - matikan salah satu";
        addLog("[Bot] Duplicate login: username ini sedang online dari tempat lain. Matikan bot yang dobel.");
      }
        botState.connected = false;
        botState.errors.push({
          type: "kicked",
          reason: kickReason,
          time: Date.now(),
        });
        clearAllIntervals();

        const reasonStr = String(kickReason).toLowerCase();
        if (
          reasonStr.includes("throttl") ||
          reasonStr.includes("wait before reconnect") ||
          reasonStr.includes("too fast")
        ) {
          addLog(
            "[Bot] Throttle kick detected - will use extended reconnect delay",
          );
          botState.wasThrottled = true;
        }

        if (
          config.discord &&
          config.discord.events &&
          config.discord.events.disconnect
        ) {
          sendDiscordWebhook(`[!] **Kicked**: ${kickReason}`, 0xff0000);
        }
        // NOTE: do NOT call scheduleReconnect() here - 'end' will fire right after 'kicked' and handle it
      });

      // FIX: 'end' is the single reconnect trigger
      bot.on("end", (reason) => {
        addLog(`[Bot] Disconnected: ${reason || "Unknown reason"}`);
      botState.drops++;
      if (!botState.lastIssue) botState.lastIssue = "Putus: " + String(reason || "unknown").slice(0, 80);
        botState.connected = false;
        clearAllIntervals();
        spawnHandled = false; // reset for next connection

        if (
          config.discord &&
          config.discord.events &&
          config.discord.events.disconnect
        ) {
          sendDiscordWebhook(
            `[-] **Disconnected**: ${reason || "Unknown"}`,
            0xf87171,
          );
        }

        // ALWAYS reconnect — bot must never leave the server
        scheduleReconnect();
      });

      bot.on("error", (err) => {
        const msg = err.message || "";
        addLog(`[Bot] Error: ${msg}`);
      botState.lastIssue = "Error: " + msg.slice(0, 100);
        botState.errors.push({ type: "error", message: msg, time: Date.now() });
        // Don't reconnect on error - let 'end' event handle it
      });
    } catch (err) {
      addLog(`[Bot] Failed to create bot: ${err.message}`);
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (!botRunning) return;
    clearBotTimeouts();

    // FIX: don't stack reconnect if already waiting
    if (isReconnecting) {
      addLog("[Bot] Reconnect already scheduled, skipping duplicate.");
      return;
    }

    isReconnecting = true;
    botState.reconnectAttempts++;

    const delay = getReconnectDelay();
    addLog(
      `[Bot] Reconnecting in ${delay / 1000}s (attempt #${botState.reconnectAttempts})`,
    );

    reconnectTimeoutId = setTimeout(() => {
      reconnectTimeoutId = null;
      isReconnecting = false;
      createBot();
    }, delay);
  }

  // ============================================================
  // MODULE INITIALIZATION
  // ============================================================
  function initializeModules(bot, mcData, defaultMove) {
    addLog("[Modules] Initializing all modules...");

    // ---------- AUTO AUTH (REAKTIF) ----------
    // Akun baru -> /register <pw> <pw>; akun lama -> /login <pw>. Dibaca dari balasan server,
    // jadi urutannya otomatis benar walau tebakan pertama salah.
    if (config.utils["auto-auth"] && config.utils["auto-auth"].enabled) {
      const password = String(config.utils["auto-auth"].password || "");
      const st = { done: false, last: 0, sent: { login: 0, register: 0 }, at: Date.now() };
      const RE = {
        regPrompt: /\/reg(?:ister)?\b/i,
        logPrompt: /\/l(?:ogin)?\b/i,
        needReg: /(not|n't)\s+(yet\s+)?registered|register\s+first|must\s+register|please\s+register|unregistered|belum\s+(terdaftar|register|daftar)|daftar\s+dulu/i,
        hasAcc: /already\s+(registered|have\s+an?\s+account|exists?)|account\s+(already\s+)?exists?|sudah\s+(terdaftar|register|daftar)/i,
        bad: /not\s+(yet\s+)?(logged|authenticated)|belum\s+login|wrong\s+password|incorrect\s+password|salah/i,
        ok: /successful(ly)?\s+(logged|login|registered|authenticated)|(logged|log)\s*in\s+successful|you\s+are\s+(now\s+)?logged\s+in|already\s+logged\s+in|login\s+success|authenticated|berhasil\s+(login|masuk|daftar|register)|welcome\s+back|registered\s+successfully|register\s+success/i,
      };
      const regCmd = (msg) => {
        const m = msg.match(/\/reg(?:ister)?((?:\s+[<\[][^>\]]*[>\]])*)/i);
        const n = m ? (m[1].match(/[<\[]/g) || []).length : 2;
        return n === 1 ? `/register ${password}` : `/register ${password} ${password}`;
      };
      const send = (type, msg) => {
        if (st.done || !bot || !botState.connected) return;
        if (!password) { if (!st.warned) { st.warned = true; addLog("[Auth] Password kosong, isi dulu di Pengaturan"); } return; }
        const now = Date.now();
        if (now - st.last < 2500 || st.sent[type] >= 3) return;
        st.last = now; st.sent[type]++;
        if (!st.viaFailsafe) st.prompted = true;
        const cmd = type === "register" ? regCmd(msg || "") : `/login ${password}`;
        setTimeout(() => {
          if (st.done || !bot || !botState.connected) return;
          try { bot.chat(cmd); } catch (e) {}
          addLog(`[Auth] Mengirim /${type}${st.sent[type] > 1 ? ` (percobaan ${st.sent[type]})` : ""}`);
        }, 700);
      };

      bot.on("messagestr", (message, position, json) => {
        if (st.done) return;
        if (json && json.translate === "chat.type.text") return; // chat pemain biasa
        const msg = String(message || "");
        if (RE.bad.test(msg) && !RE.needReg.test(msg)) { if (/wrong|incorrect|salah/i.test(msg)) st.wrong = true; return; }
        if (RE.needReg.test(msg)) return send("register", msg);
        if (RE.hasAcc.test(msg)) return send("login", msg);
        if (RE.ok.test(msg) && !RE.bad.test(msg)) {
          st.done = true;
          addLog("[Auth] Berhasil masuk / terdaftar");
          return;
        }
        const early = Date.now() - st.at < 25000 && !/[»:]\s/.test(msg) && !/^</.test(msg);
        if (RE.regPrompt.test(msg) && !RE.logPrompt.test(msg)) return send("register", msg);
        if (RE.logPrompt.test(msg)) return send("login", msg);
        if (early && /register|daftar|등록|가입/i.test(msg) && /password|pass|kata\s*sandi|비밀번호/i.test(msg)) return send("register", msg);
        if (early && /login|log in|masuk|로그인/i.test(msg) && /password|pass|kata\s*sandi|비밀번호/i.test(msg)) return send("login", msg);
      });

      // Cadangan bila server tidak mengirim petunjuk lewat chat:
      // 10 dtk -> coba /login, 18 dtk -> coba /register (akun baru). Perintah yang tidak perlu tidak berbahaya.
      setTimeout(() => {
        if (st.done || st.sent.login || st.sent.register) return;
        addLog("[Auth] Tidak ada petunjuk dari server, mencoba /login");
        st.viaFailsafe = true; send("login", ""); st.viaFailsafe = false;
      }, 10000);
      setTimeout(() => {
        if (st.done || st.sent.register || st.prompted || st.wrong) return;
        addLog("[Auth] Belum ada tanda berhasil, mencoba /register");
        st.last = 0; st.viaFailsafe = true;
        send("register", "");
        st.viaFailsafe = false;
      }, 18000);
    }

    // ---------- CHAT MESSAGES ----------
    if (config.utils["chat-messages"] && config.utils["chat-messages"].enabled) {
      const messages = config.utils["chat-messages"].messages;
      if (config.utils["chat-messages"].repeat) {
        let i = 0;
        addInterval(() => {
          if (bot && botState.connected) {
            bot.chat(messages[i]);
            botState.lastActivity = Date.now();
            i = (i + 1) % messages.length;
          }
        }, config.utils["chat-messages"]["repeat-delay"] * 1000);
      } else {
        messages.forEach((msg, idx) => {
          setTimeout(() => {
            if (bot && botState.connected) bot.chat(msg);
          }, idx * 1000);
        });
      }
    }

    // ---------- MOVE TO POSITION ----------
    // FIX: only use position goal if circle-walk is NOT enabled (they fight over pathfinder)
    if (
      config.position &&
      config.position.enabled &&
      !(
        config.movement &&
        config.movement["circle-walk"] &&
        config.movement["circle-walk"].enabled
      )
    ) {
      bot.pathfinder.setMovements(defaultMove);
      bot.pathfinder.setGoal(
        new GoalBlock(config.position.x, config.position.y, config.position.z),
      );
      addLog("[Position] Navigating to configured position...");
    }

    // ---------- ANTI-AFK ----------
    if (config.utils["anti-afk"] && config.utils["anti-afk"].enabled) {
      // Arm swinging
      addInterval(
        () => {
          if (!bot || !botState.connected) return;
          try {
            bot.swingArm();
          } catch (e) {}
        },
        10000 + Math.floor(Math.random() * 50000),
      );

      // Hotbar cycling
      addInterval(
        () => {
          if (!bot || !botState.connected) return;
          try {
            const slot = Math.floor(Math.random() * 9);
            bot.setQuickBarSlot(slot);
          } catch (e) {}
        },
        30000 + Math.floor(Math.random() * 90000),
      );

      // Teabagging
      addInterval(
        () => {
          if (
            !bot ||
            !botState.connected ||
            typeof bot.setControlState !== "function"
          )
            return;
          if (Math.random() > 0.9) {
            let count = 2 + Math.floor(Math.random() * 4);
            const doTeabag = () => {
              if (count <= 0 || !bot || typeof bot.setControlState !== "function")
                return;
              try {
                bot.setControlState("sneak", true);
                setTimeout(() => {
                  if (bot && typeof bot.setControlState === "function")
                    bot.setControlState("sneak", false);
                  count--;
                  setTimeout(doTeabag, 150);
                }, 150);
              } catch (e) {}
            };
            doTeabag();
          }
        },
        120000 + Math.floor(Math.random() * 180000),
      );

      // FIX: micro-walk only when circle-walk is NOT running, to avoid interrupting pathfinder
      if (
        !(
          config.movement &&
          config.movement["circle-walk"] &&
          config.movement["circle-walk"].enabled
        )
      ) {
        addInterval(
          () => {
            if (
              !bot ||
              !botState.connected ||
              typeof bot.setControlState !== "function"
            )
              return;
            try {
              if (botState.patrolActive) return;
              const yaw = Math.random() * Math.PI * 2;
              bot.look(yaw, 0, true);
              bot.setControlState("forward", true);
              setTimeout(
                () => {
                  if (bot && typeof bot.setControlState === "function")
                    bot.setControlState("forward", false);
                },
                500 + Math.floor(Math.random() * 1500),
              );
              botState.lastActivity = Date.now();
            } catch (e) {
              addLog("[AntiAFK] Walk error:", e.message);
            }
          },
          120000 + Math.floor(Math.random() * 360000),
        );
      }

      if (config.utils["anti-afk"].sneak) {
        try {
          if (typeof bot.setControlState === "function")
            bot.setControlState("sneak", true);
        } catch (e) {}
      }
    }

    // ---------- MOVEMENT MODULES ----------
    // FIX: check top-level movement.enabled flag
    if (config.movement && config.movement.enabled !== false) {
      // FIX: circle-walk and random-jump both jump - only run one jumping mechanism
      // random-jump is skipped if anti-afk jump is handled elsewhere; we only use random-jump here
      if (
        config.movement["circle-walk"] &&
        config.movement["circle-walk"].enabled
      ) {
        startCircleWalk(bot, defaultMove);
      }
      // FIX: only run random-jump if circle-walk is NOT running (circle-walk also keeps bot moving)
      if (
        config.movement["random-jump"] &&
        config.movement["random-jump"].enabled &&
        !(
          config.movement["circle-walk"] && config.movement["circle-walk"].enabled
        )
      ) {
        startRandomJump(bot);
      }
      if (
        config.movement["look-around"] &&
        config.movement["look-around"].enabled
      ) {
        startLookAround(bot);
      }
    }

    // ---------- CUSTOM MODULES ----------
    // FIX: avoidMobs AND combatModule conflict - if combat is enabled, don't run avoidMobs at the same time
    if (config.modules.avoidMobs && !config.modules.combat) {
      avoidMobs(bot);
    }
    if (config.modules.combat) {
      combatModule(bot, mcData);
    }
    if (config.modules.beds) {
      bedModule(bot, mcData);
    }
    if (config.modules.chat) {
      chatModule(bot);
    }
    if (config.modules.survival) require("./survival")(bot, mcData, defaultMove, addLog, addInterval, botState);
    try { require("./extras").attach(bot, mcData, defaultMove, addLog, addInterval, config, botState); } catch (e) { addLog("[Extras] " + e.message); }
    try { require("./patrol").attach(bot, addLog, addInterval, botState); } catch (e) { addLog("[Patroli] " + e.message); }

    addLog("[Modules] All modules initialized!");
  }

  // ============================================================
  // MOVEMENT HELPERS
  // ============================================================
  function startCircleWalk(bot, defaultMove) {
    const radius = config.movement["circle-walk"].radius;
    let angle = 0;
    let lastPathTime = 0;

    addInterval(() => {
      if (!bot || !botState.connected) return;
      if (botState.patrolActive) return;
      const now = Date.now();
      if (now - lastPathTime < 2000) return;
      lastPathTime = now;
      try {
        const x = bot.entity.position.x + Math.cos(angle) * radius;
        const z = bot.entity.position.z + Math.sin(angle) * radius;
        bot.pathfinder.setMovements(defaultMove);
        bot.pathfinder.setGoal(
          new GoalBlock(
            Math.floor(x),
            Math.floor(bot.entity.position.y),
            Math.floor(z),
          ),
        );
        angle += Math.PI / 4;
        botState.lastActivity = Date.now();
      } catch (e) {
        addLog("[CircleWalk] Error:", e.message);
      }
    }, config.movement["circle-walk"].speed);
  }

  function startRandomJump(bot) {
    addInterval(() => {
      if (
        !bot ||
        !botState.connected ||
        typeof bot.setControlState !== "function"
      )
        return;
      if (botState.patrolActive) return;
      try {
        bot.setControlState("jump", true);
        setTimeout(() => {
          if (bot && typeof bot.setControlState === "function")
            bot.setControlState("jump", false);
        }, 300);
        botState.lastActivity = Date.now();
      } catch (e) {
        addLog("[RandomJump] Error:", e.message);
      }
    }, config.movement["random-jump"].interval);
  }

  function startLookAround(bot) {
    addInterval(() => {
      if (!bot || !botState.connected) return;
      try {
        const yaw = Math.random() * Math.PI * 2 - Math.PI;
        const pitch = (Math.random() * Math.PI) / 2 - Math.PI / 4;
        bot.look(yaw, pitch, false);
        botState.lastActivity = Date.now();
      } catch (e) {
        addLog("[LookAround] Error:", e.message);
      }
    }, config.movement["look-around"].interval);
  }

  // ============================================================
  // CUSTOM MODULES
  // ============================================================

  // Avoid mobs/players
  // FIX: e.username only exists on players; use e.name for mobs - now handled properly
  function avoidMobs(bot) {
    const safeDistance = 5;
    addInterval(() => {
      if (
        !bot ||
        !botState.connected ||
        typeof bot.setControlState !== "function"
      )
        return;
      if (botState.patrolActive) return;
      try {
        const entities = Object.values(bot.entities).filter(
          (e) =>
            e.type === "mob" ||
            (e.type === "player" && e.username !== bot.username),
        );
        for (const e of entities) {
          if (!e.position) continue;
          const distance = bot.entity.position.distanceTo(e.position);
          if (distance < safeDistance) {
            bot.setControlState("back", true);
            setTimeout(() => {
              if (bot && typeof bot.setControlState === "function")
                bot.setControlState("back", false);
            }, 500);
            break;
          }
        }
      } catch (e) {
        addLog("[AvoidMobs] Error:", e.message);
      }
    }, 2000);
  }

  // Combat module
  // FIX: attack cooldown for 1.9+ (600ms minimum between attacks)
  // FIX: lock onto a target for multiple ticks instead of randomly switching every tick
  // FIX: autoEat - use i.foodPoints directly (mineflayer item property) instead of broken mcData lookup
  function combatModule(bot, mcData) {
    let lastAttackTime = 0;
    let lockedTarget = null;
    let lockedTargetExpiry = 0;

    // FIX: use physicsTick (not the deprecated physicTick)
    bot.on("physicsTick", () => {
      if (!bot || !botState.connected) return;
      if (!config.combat["attack-mobs"]) return;

      const now = Date.now();
      // FIX: 1.9+ attack cooldown - respect at least 600ms between swings
      if (now - lastAttackTime < 620) return;

      try {
        // FIX: only pick a new target if current one is gone or lock expired
        if (
          lockedTarget &&
          now < lockedTargetExpiry &&
          bot.entities[lockedTarget.id] &&
          lockedTarget.position
        ) {
          const dist = bot.entity.position.distanceTo(lockedTarget.position);
          if (dist < 4) {
            bot.attack(lockedTarget);
            lastAttackTime = now;
            return;
          } else {
            lockedTarget = null;
          }
        }

        // Pick a new target
        const mobs = Object.values(bot.entities).filter(
          (e) =>
            e.type === "mob" &&
            e.position &&
            bot.entity.position.distanceTo(e.position) < 4,
        );
        if (mobs.length > 0) {
          lockedTarget = mobs[0];
          lockedTargetExpiry = now + 3000; // stick to same mob for 3 seconds
          bot.attack(lockedTarget);
          lastAttackTime = now;
        }
      } catch (e) {
        addLog("[Combat] Error:", e.message);
      }
    });

    // FIX: autoEat - check foodPoints property on the item directly (works reliably)
    bot.on("health", () => {
      if (!config.combat["auto-eat"]) return;
      try {
        if (bot.food < 14) {
          const food = bot.inventory
            .items()
            .find((i) => i.foodPoints && i.foodPoints > 0);
          if (food) {
            bot
              .equip(food, "hand")
              .then(() => bot.consume())
              .catch((e) => addLog("[AutoEat] Error:", e.message));
          }
        }
      } catch (e) {
        addLog("[AutoEat] Error:", e.message);
      }
    });
  }

  // Bed module
  // FIX: bot.isSleeping can be stale; use a local isTryingToSleep guard to prevent double-sleep errors
  // FIX: place-night was false in default settings - documentation note added
  function bedModule(bot, mcData) {
    let isTryingToSleep = false;

    addInterval(async () => {
      if (!bot || !botState.connected) return;
      if (!config.beds["place-night"]) return; // FIX: check flag (was always skipping before)

      try {
        const isNight =
          bot.time.timeOfDay >= 12500 && bot.time.timeOfDay <= 23500;

        // FIX: use local guard instead of stale bot.isSleeping
        if (isNight && !isTryingToSleep) {
          const bedBlock = bot.findBlock({
            matching: (block) => block.name.includes("bed"),
            maxDistance: 8,
          });

          if (bedBlock) {
            isTryingToSleep = true;
            try {
              await bot.sleep(bedBlock);
              addLog("[Bed] Sleeping...");
            } catch (e) {
              // Can't sleep - maybe not night enough or monsters nearby
            } finally {
              isTryingToSleep = false;
            }
          }
        }
      } catch (e) {
        isTryingToSleep = false;
        addLog("[Bed] Error:", e.message);
      }
    }, 10000);
  }

  // Chat module
  // FIX: wire up discord.events.chat flag
  function chatModule(bot) {
    bot.on("chat", (username, message) => {
      if (!bot || username === bot.username) return;

      try {
        // FIX: send chat events to Discord if enabled
        if (
          config.discord &&
          config.discord.enabled &&
          config.discord.events &&
          config.discord.events.chat
        ) {
          sendDiscordWebhook(`💬 **${username}**: ${message}`, 0x7289da);
        }

        if (config.chat && config.chat.respond) {
          const lowerMsg = message.toLowerCase();
          if (lowerMsg.includes("hello") || lowerMsg.includes("hi")) {
            bot.chat(`Hello, ${username}!`);
          }
          if (message.startsWith("!tp ")) {
            const target = message.split(" ")[1];
            if (target) bot.chat(`/tp ${target}`);
          }
        }
      } catch (e) {
        addLog("[Chat] Error:", e.message);
      }
    });
  }


  function stopBot() {
    botRunning = false;
    clearBotTimeouts();
    isReconnecting = false;
    botState.connected = false;
    clearAllIntervals();
    if (bot) {
      try {
        bot.removeAllListeners();
        bot.on("error", () => {});
        bot.end();
      } catch (e) {}
      bot = null;
    }
  }

  function startBot() {
    botRunning = true;
    botState.reconnectAttempts = 0;
    createBot();
  }

  // Used by crash handlers
  let recovering = false;
  function recover(delay) {
    if (recovering || !botRunning) return;
    recovering = true;
    clearAllIntervals();
    botState.connected = false;
    if (isReconnecting) {
      isReconnecting = false;
      if (reconnectTimeoutId) {
        clearTimeout(reconnectTimeoutId);
        reconnectTimeoutId = null;
      }
    }
    setTimeout(() => { recovering = false; scheduleReconnect(); }, delay);
  }

  return {
    id,
    name,
    botState,
    get bot() { return bot; },
    get srv() { return config.server; },
    get running() { return botRunning; },
    start: startBot,
    stop: stopBot,
    recover,
  };
}

// ============================================================
// BOT MANAGER - main bot (bot-account) + extra bots (config.bots)
// ============================================================
const manager = {
  list: [],
  build() {
    this.list.forEach((b) => this.stop(b));
    const extra = (config.bots || []).map((b) => Object.assign({}, b));
    this.list = [config["bot-account"], ...extra].map((a) => makeBot(a.username, a, config));
  },
  get(id) { return this.list.find((b) => b.id === id); },
  save() {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(config, null, 2));
  },
  stop(b) { clearTimeout(b.timer); b.stop(); },
  // stagger joins so the server does not throttle us
  startLater(b, delay) {
    clearTimeout(b.timer);
    b.timer = setTimeout(() => { if (!b.running) b.start(); }, delay);
  },
  startAll() { this.list.forEach((b, i) => !b.running && this.startLater(b, i * 6000)); },
  summary() {
    return this.list.map((b, i) => ({
      id: b.id,
      main: i === 0,
      server: b.srv.ip + ":" + b.srv.port,
      msgs: i === 0 ? null : ((config.bots || []).find((x) => x.username === b.id) || {}).messages?.length || 0,
      running: b.running,
      connected: b.botState.connected,
      coords: b.bot && b.bot.entity ? b.bot.entity.position : null,
      reconnects: b.botState.reconnectAttempts,
      issue: b.botState.lastIssue,
      drops: b.botState.drops,
      uptime: b.botState.connected ? Math.floor((Date.now() - b.botState.connectedAt) / 1000) : 0,
      hp: b.bot && b.bot.health != null ? Math.round(b.bot.health) : null,
      food: b.bot && b.bot.food != null ? b.bot.food : null,
      items: b.botState.connected && b.bot && b.bot.inventory ? b.bot.inventory.items().slice(0, 40).map((i) => i.name.replace(/_/g, " ") + " ×" + i.count) : [],
    }));
  },
};

// ============================================================
// CONSOLE COMMANDS (terminal) - applies to every connected bot
// ============================================================
require("./extras").telegram(manager, config, addLog);
require("./more")(app, manager, config, addLog);
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on("line", (line) => {
  const t = line.trim();
  const live = manager.list.filter((b) => b.botState.connected && b.bot);
  if (t === "status")
    return addLog(`Connected: ${live.length}/${manager.list.length}, Uptime: ${formatUptime(Math.floor(process.uptime()))}`);
  if (!live.length) return addLog("[Console] Bot not connected");
  const msg = t.startsWith("say ") ? t.slice(4) : t.startsWith("cmd ") ? "/" + t.slice(4) : t;
  live.forEach((b) => b.bot.chat(msg));
});

// ============================================================
// DISCORD WEBHOOK INTEGRATION
// FIX: use Buffer.byteLength for Content-Length (handles non-ASCII usernames correctly)
// FIX: rate limiting to avoid spam when bot is flapping
// ============================================================
function sendDiscordWebhook(content, color = 0x0099ff) {
  if (
    !config.discord ||
    !config.discord.enabled ||
    !config.discord.webhookUrl ||
    config.discord.webhookUrl.includes("YOUR_DISCORD")
  )
    return;

  // FIX: Discord rate limiting - skip if sent too recently
  const now = Date.now();
  if (now - lastDiscordSend < DISCORD_RATE_LIMIT_MS) {
    addLog("[Discord] Rate limited - skipping webhook");
    return;
  }
  lastDiscordSend = now;

  const protocol = config.discord.webhookUrl.startsWith("https") ? https : http;
  const urlParts = new URL(config.discord.webhookUrl);

  const payload = JSON.stringify({
    username: config.name,
    embeds: [
      {
        description: content,
        color: color,
        timestamp: new Date().toISOString(),
        footer: { text: "Slobos AFK Bot" },
      },
    ],
  });

  const options = {
    hostname: urlParts.hostname,
    port: 443,
    path: urlParts.pathname + urlParts.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // FIX: use Buffer.byteLength instead of payload.length - handles non-ASCII (e.g. usernames with accents/emoji)
      "Content-Length": Buffer.byteLength(payload, "utf8"),
    },
  };

  const req = protocol.request(options, (res) => {
    // Silent success
  });

  req.on("error", (e) => {
    addLog(`[Discord] Error sending webhook: ${e.message}`);
  });

  req.write(payload);
  req.end();
}

// ============================================================
// CRASH RECOVERY - IMMORTAL MODE
// ============================================================
function recoverAll(delay) {
  manager.list.filter((b) => b.running && !b.botState.connected).forEach((b) => b.recover(delay));
}

process.on("uncaughtException", (err) => {
  const msg = err.message || "Unknown";
  addLog(`[FATAL] Uncaught Exception: ${msg}`);
  const net = /PartialReadError|ECONNRESET|EPIPE|ETIMEDOUT|timed out|write after end|This socket has been ended/.test(msg);
  if (net) addLog("[FATAL] Known network/protocol error - recovering gracefully...");
  recoverAll(net ? 5000 : 10000);
});

process.on("unhandledRejection", (reason) => {
  const msg = String(reason);
  addLog(`[FATAL] Unhandled Rejection: ${reason}`);
  if (/ETIMEDOUT|ECONNRESET|EPIPE|ENOTFOUND|timed out|PartialReadError/.test(msg)) recoverAll(5000);
});

process.on("SIGTERM", () => {
  addLog("[System] SIGTERM received — ignoring, bot will stay alive.");
});

process.on("SIGINT", () => {
  addLog("[System] SIGINT received — ignoring, bot will stay alive.");
});

// =============================
//===============================
// START THE BOT
// ============================================================
addLog("=".repeat(50));
addLog("  Minecraft AFK Bot v2.5 - Bug-Fixed Edition");
addLog("=".repeat(50));
addLog(`Server: ${config.server.ip}:${config.server.port}`);
addLog(`Version: ${config.server.version}`);
addLog(
  `Auto-Reconnect: ${config.utils["auto-reconnect"] ? "Enabled" : "Disabled"}`,
);
addLog("=".repeat(50));

manager.build();
manager.startAll();
