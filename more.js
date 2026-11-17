"use strict";
// Rute dan pemantau tambahan: /api/chat, /api/stats, /api/control, /hook/<token>/<aksi>,
// radar "sekitar bot" (ditempel ke manager.summary) dan deteksi ban/whitelist.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const extras = require("./extras");

module.exports = function more(app, manager, config, addLog) {
  extras.ctx.manager = manager;
  const statsFile = path.join(process.env.DATA_DIR || __dirname, "stats.json");
  let stats = {};
  try { stats = JSON.parse(fs.readFileSync(statsFile, "utf8")); } catch (e) {}

  // ---------- radar: pemain dan mob dalam 32 blok ----------
  const near = (b) => {
    const bot = b && b.bot;
    if (!bot || !b.botState.connected || !bot.entity) return [];
    return Object.values(bot.entities)
      .filter((e) => e !== bot.entity && e.position && ["player", "hostile", "mob"].includes(e.type))
      .map((e) => ({ n: e.username || e.name || e.type, k: e.type, d: Math.round(bot.entity.position.distanceTo(e.position)) }))
      .filter((x) => x.d <= 32).sort((a, b2) => a.d - b2.d).slice(0, 8);
  };
  const oldSummary = manager.summary.bind(manager);
  // info dunia & pemain untuk kartu bot
  const world = (b) => {
    const bot = b && b.bot;
    if (!bot || !b.botState.connected || !bot.entity) return {};
    const dim = String((bot.game && bot.game.dimension) || "").replace("minecraft:", "");
    return {
      dim,
      tod: bot.time && bot.time.timeOfDay != null ? bot.time.timeOfDay : null,
      players: Object.keys(bot.players || {}).length,
      ping: bot.player && bot.player.ping != null ? bot.player.ping : null,
      gm: bot.game ? bot.game.gameMode : null,
      xp: bot.experience ? bot.experience.level : null,
    };
  };
  manager.summary = () => oldSummary().map((s, i) => ({ ...s, near: near(manager.list[i]), ...world(manager.list[i]) }));

  // ---------- riwayat kejadian (join / putus / start / stop) ----------
  const eventsFile = path.join(process.env.DATA_DIR || __dirname, "events.json");
  let events = [];
  try { events = JSON.parse(fs.readFileSync(eventsFile, "utf8")).slice(-80); } catch (e) {}
  const pushEvent = (bot, type, msg) => { events.push({ t: Date.now(), bot, type, msg: String(msg || "").slice(0, 140) }); if (events.length > 80) events.shift(); };
  const lastRun = {};

  // ---------- statistik + deteksi ban/whitelist (dicek tiap 5 detik) ----------
  const last = {};
  setInterval(() => {
    const d = new Date().toISOString().slice(0, 10);
    const S = (stats[d] = stats[d] || { up: 0, run: 0, conn: 0, drops: 0, reasons: {} });
    manager.list.forEach((b) => {
      const st = b.botState, was = last[b.id];
      if (b.running) S.run += 5;
      if (st.connected) S.up += 5;
      if (lastRun[b.id] !== undefined && lastRun[b.id] !== b.running) pushEvent(b.id, b.running ? "start" : "stop", b.running ? "Dinyalakan" : "Dihentikan");
      lastRun[b.id] = b.running;
      if (was !== true && st.connected) { S.conn++; pushEvent(b.id, "join", "Masuk ke server"); }
      if (was === true && !st.connected && b.running) {
        const r = String(st.lastIssue || "tidak diketahui").slice(0, 60);
        S.drops++; S.reasons[r] = (S.reasons[r] || 0) + 1;
        pushEvent(b.id, "drop", r);
      }
      last[b.id] = st.connected;
      const sm = config["smart-reconnect"];
      if (sm && sm.enabled && b.running && /^Kicked:.*(banned|whitelist)/i.test(st.lastIssue || "")) {
        const why = st.lastIssue;
        st.lastIssue = "Dihentikan otomatis: " + why;
        addLog(`[Smart] ${b.id} dihentikan (${why})`);
        extras.notify(`⛔ ${b.id} dihentikan otomatis: ${why}`);
        manager.stop(b);
      }
    });
    Object.keys(stats).sort().slice(0, -30).forEach((k) => delete stats[k]);
  }, 5000);
  setInterval(() => {
    fs.writeFile(statsFile, JSON.stringify(stats), () => {});
    fs.writeFile(eventsFile, JSON.stringify(events), () => {});
  }, 60000);

  // ---------- restart terjadwal: config.schedule["restart-hours"] (0 = mati) ----------
  let lastRestart = Date.now();
  setInterval(() => {
    const h = Number(config.schedule && config.schedule["restart-hours"]) || 0;
    if (h <= 0) { lastRestart = Date.now(); return; }
    if (Date.now() - lastRestart < h * 3600e3) return;
    lastRestart = Date.now();
    const run = manager.list.filter((b) => b.running);
    if (!run.length) return;
    addLog(`[Jadwal] Restart otomatis setiap ${h} jam`);
    pushEvent("semua", "restart", `Restart terjadwal (${h} jam)`);
    run.forEach((b, i) => { manager.stop(b); manager.startLater(b, 2000 + i * 6000); });
  }, 60000);

  app.get("/api/stats", (req, res) => res.json(stats));
  app.get("/api/chat", (req, res) => res.json({ chat: extras.chat }));
  app.get("/api/events", (req, res) => res.json({ events: events.slice().reverse() }));

  // ---------- ping server Minecraft (dipakai kartu "Server") + info sistem ----------
  let pingCache = { t: 0, key: "", data: null };
  const flat = (d) => {
    if (d == null) return "";
    if (typeof d === "string") return d;
    return (d.text || "") + (Array.isArray(d.extra) ? d.extra.map(flat).join("") : "");
  };
  async function pingServer() {
    const host = config.server.ip, port = Number(config.server.port) || 25565, key = host + ":" + port;
    if (pingCache.key === key && Date.now() - pingCache.t < 20000) return pingCache.data;
    let data;
    try {
      const mc = require("minecraft-protocol");
      const t0 = Date.now();
      const r = await Promise.race([
        mc.ping({ host, port }),
        new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 6000)),
      ]);
      data = {
        online: true,
        latency: typeof r.latency === "number" ? r.latency : Date.now() - t0,
        version: r.version && r.version.name,
        players: r.players ? { online: r.players.online, max: r.players.max, sample: (r.players.sample || []).slice(0, 12).map((p) => p.name) } : null,
        motd: flat(r.description).replace(/§./g, "").replace(/\s+/g, " ").trim().slice(0, 120),
      };
    } catch (e) { data = { online: false, error: String(e.message || e).slice(0, 80) }; }
    pingCache = { t: Date.now(), key, data };
    return data;
  }
  app.get("/api/overview", async (req, res) => {
    const m = process.memoryUsage();
    res.json({
      server: await pingServer(),
      system: {
        uptime: Math.floor(process.uptime()),
        heapMB: Math.round(m.heapUsed / 1048576),
        rssMB: Math.round(m.rss / 1048576),
        node: process.version,
        protectedPanel: !!process.env.PANEL_PASSWORD,
        persistent: !!process.env.DATA_DIR,
      },
    });
  });

  // ---------- remote control dari tab Live ----------
  app.post("/api/control", (req, res) => {
    const { bot: id, action } = req.body || {};
    const b = manager.list.find((x) => x.id === id && x.botState.connected) || manager.list.find((x) => x.botState.connected);
    const bot = b && b.bot;
    if (!bot || !bot.entity) return res.json({ success: false, msg: "Bot belum terhubung" });
    const keys = { maju: "forward", mundur: "back", kiri: "left", kanan: "right", lompat: "jump", jongkok: "sneak" };
    try {
      if (keys[action]) {
        bot.setControlState(keys[action], true);
        setTimeout(() => { try { bot.setControlState(keys[action], false); } catch (e) {} }, action === "jongkok" ? 1500 : 450);
      } else if (action === "putar-kiri" || action === "putar-kanan") {
        bot.look(bot.entity.yaw + (action === "putar-kiri" ? 0.5 : -0.5), bot.entity.pitch, true);
      } else return res.json({ success: false, msg: "Aksi tidak dikenal" });
      res.json({ success: true });
    } catch (e) { res.json({ success: false, msg: e.message }); }
  });

  // ---------- tombol cepat: /hook/<token>/restart|start|stop|status (Tasker, Shortcuts) ----------
  app.all("/hook/:token/:action", (req, res) => {
    const tok = (config.api && config.api.token) || process.env.HOOK_TOKEN || "";
    const a = Buffer.from(String(req.params.token)), t = Buffer.from(tok);
    if (!tok || a.length !== t.length || !crypto.timingSafeEqual(a, t)) return res.status(403).send("Token salah");
    const L = manager.list, act = req.params.action;
    if (act === "restart") { L.forEach((b) => { manager.stop(b); manager.startLater(b, 2000); }); return res.send("restart"); }
    if (act === "start") { manager.startAll(); return res.send("start"); }
    if (act === "stop") { L.forEach((b) => manager.stop(b)); return res.send("stop"); }
    if (act === "status") return res.send(L.map((b) => `${b.id}: ${b.botState.connected ? "online" : b.running ? "menunggu" : "berhenti"}`).join("\n"));
    res.status(404).send("Aksi: restart | start | stop | status");
  });
};
