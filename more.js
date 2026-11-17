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
  const pingCache = {};
  const flat = (d) => {
    if (d == null) return "";
    if (typeof d === "string") return d;
    return (d.text || "") + (Array.isArray(d.extra) ? d.extra.map(flat).join("") : "");
  };
  async function pingServer(host, port) {
    port = Number(port) || 25565;
    const key = host + ":" + port, c = pingCache[key];
    if (c && Date.now() - c.t < 20000) return c.data;
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
    pingCache[key] = { t: Date.now(), data };
    return data;
  }
  app.get("/api/overview", async (req, res) => {
    const m = process.memoryUsage();
    // satu entri per server berbeda (bot bisa berada di server berbeda-beda)
    const groups = {};
    manager.list.forEach((b) => { const k = b.srv.ip + ":" + (Number(b.srv.port) || 25565); (groups[k] = groups[k] || { ip: b.srv.ip, port: Number(b.srv.port) || 25565, bots: [] }).bots.push(b.id); });
    const servers = await Promise.all(Object.values(groups).slice(0, 6).map(async (g) => ({ ...g, ...(await pingServer(g.ip, g.port)) })));
    res.json({
      servers,
      server: servers[0] || (await pingServer(config.server.ip, config.server.port)),
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

  // ---------- inventory visual: baca slot + aksi (pegang, makan, pakai armor, buang) ----------
  // slot jendela inventory: 5-8 armor (kepala, dada, kaki, sepatu), 9-35 tas, 36-44 hotbar, 45 tangan kiri
  const ARMOR = { helmet: "head", chestplate: "torso", leggings: "legs", boots: "feet", elytra: "torso" };
  const armorDest = (name) => { const k = Object.keys(ARMOR).find((x) => name.endsWith(x)); return k ? ARMOR[k] : null; };
  const liveBot = (id) => { const b = manager.list.find((x) => x.id === id); return b && b.botState.connected && b.bot && b.bot.inventory ? b.bot : null; };
  const within = (p, ms = 6000) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error("timeout")), ms))]);
  const snap = (bot) => {
    const out = [];
    for (let i = 0; i <= 45; i++) {
      const it = bot.inventory.slots[i];
      if (!it) continue;
      let max = 0, used = 0;
      try { max = it.maxDurability || 0; used = max ? it.durabilityUsed || 0 : 0; } catch (e) {}
      out.push({ s: i, name: it.name, display: it.displayName || it.name, count: it.count, food: !!it.foodPoints, armor: !!armorDest(it.name), max, used });
    }
    return { slots: out, held: bot.quickBarSlot, hp: bot.health != null ? Math.round(bot.health) : null, food: bot.food != null ? bot.food : null };
  };
  app.get("/api/inventory/:id", (req, res) => {
    const bot = liveBot(req.params.id);
    if (!bot) return res.json({ success: false, msg: "Bot belum terhubung" });
    res.json({ success: true, ...snap(bot) });
  });
  app.post("/api/inventory/:id", async (req, res) => {
    const bot = liveBot(req.params.id);
    if (!bot) return res.json({ success: false, msg: "Bot belum terhubung" });
    const { action } = req.body || {}, slot = Number((req.body || {}).slot);
    if (!Number.isInteger(slot) || slot < 0 || slot > 45) return res.json({ success: false, msg: "Slot tidak valid" });
    const it = bot.inventory.slots[slot];
    if (!it) return res.json({ success: false, msg: "Slot sudah kosong" });
    const label = it.displayName || it.name;
    try {
      if (action === "hold") {
        if (slot >= 36 && slot <= 44) bot.setQuickBarSlot(slot - 36);
        else await within(bot.equip(it, "hand"));
        return res.json({ success: true, msg: label + " dipegang" });
      }
      if (action === "offhand") { await within(bot.equip(it, "off-hand")); return res.json({ success: true, msg: label + " di tangan kiri" }); }
      if (action === "wear") {
        const d = armorDest(it.name);
        if (!d) return res.json({ success: false, msg: label + " bukan armor" });
        await within(bot.equip(it, d)); return res.json({ success: true, msg: label + " dipakai" });
      }
      if (action === "unwear") {
        const d = { 5: "head", 6: "torso", 7: "legs", 8: "feet", 45: "off-hand" }[slot];
        if (!d) return res.json({ success: false, msg: "Bukan slot armor" });
        await within(bot.unequip(d)); return res.json({ success: true, msg: label + " dilepas" });
      }
      if (action === "eat") {
        if (!it.foodPoints) return res.json({ success: false, msg: label + " tidak bisa dimakan" });
        await within(bot.equip(it, "hand"));
        bot.consume().catch(() => {}); // makan butuh ~1,6 detik, tidak perlu ditunggu
        return res.json({ success: true, msg: "Memakan " + label + "…" });
      }
      if (action === "drop1" || action === "dropall") {
        if (action === "dropall") await within(bot.tossStack(it));
        else await within(bot.toss(it.type, it.metadata == null ? null : it.metadata, 1));
        addLog(`[Inventory] ${bot.username} membuang ${action === "dropall" ? it.count + "x " : "1x "}${label}`);
        return res.json({ success: true, msg: label + " dibuang" });
      }
      res.json({ success: false, msg: "Aksi tidak dikenal" });
    } catch (e) { res.json({ success: false, msg: "Gagal: " + String(e.message || e).slice(0, 80) }); }
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

  // ---------- patroli area (pemain & blok di dalam kotak koordinat) ----------
  try { require("./patrol").routes(app, manager, config, addLog); } catch (e) { addLog("[Patroli] rute gagal: " + e.message); }
};
