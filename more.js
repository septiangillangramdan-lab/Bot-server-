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
  manager.summary = () => oldSummary().map((s, i) => ({ ...s, near: near(manager.list[i]) }));

  // ---------- statistik + deteksi ban/whitelist (dicek tiap 5 detik) ----------
  const last = {};
  setInterval(() => {
    const d = new Date().toISOString().slice(0, 10);
    const S = (stats[d] = stats[d] || { up: 0, run: 0, conn: 0, drops: 0, reasons: {} });
    manager.list.forEach((b) => {
      const st = b.botState, was = last[b.id];
      if (b.running) S.run += 5;
      if (st.connected) S.up += 5;
      if (was !== true && st.connected) S.conn++;
      if (was === true && !st.connected && b.running) {
        const r = String(st.lastIssue || "tidak diketahui").slice(0, 60);
        S.drops++; S.reasons[r] = (S.reasons[r] || 0) + 1;
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
  setInterval(() => fs.writeFile(statsFile, JSON.stringify(stats), () => {}), 60000);

  app.get("/api/stats", (req, res) => res.json(stats));
  app.get("/api/chat", (req, res) => res.json({ chat: extras.chat }));

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
