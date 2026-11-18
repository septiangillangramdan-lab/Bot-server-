"use strict";
// Fitur tambahan: /goto /follow /come, mode aman, tidur, memancing, balas chat, live view, kontrol Telegram.
// Semua dibungkus try/catch supaya kegagalan di sini tidak pernah menjatuhkan bot.
const https = require("https");
const { goals, Movements } = require("mineflayer-pathfinder");
const { GoalNear, GoalFollow, GoalXZ } = goals;
const logger = require("./logger");

// port internal viewer; kalau sama dengan port panel (env PORT), geser satu angka
function viewerPort(cfg) {
  const p = Number(cfg.viewer && cfg.viewer.port) || 3007;
  return p === (Number(process.env.PORT) || 5000) ? p + 1 : p;
}

const chat = []; // buffer chat untuk tab Chat
const ctx = {}; // diisi more.js (manager)
let tg = null; // { token, chatId } kalau Telegram aktif
let viewer = null; // { bot } pemilik live view saat ini
let lastNote = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function tgCall(token, method, body) {
  return new Promise((ok) => {
    const data = JSON.stringify(body || {});
    const r = https.request(
      { hostname: "api.telegram.org", path: `/bot${token}/${method}`, method: "POST", timeout: 35000,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => { let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => { try { ok(JSON.parse(s)); } catch (e) { ok(null); } }); }
    );
    r.on("error", () => ok(null));
    r.on("timeout", () => r.destroy());
    r.write(data); r.end();
  });
}

// notifikasi satu arah ke Telegram (dibatasi 1 pesan / 10 detik agar tidak spam)
function notify(text) {
  if (!tg || Date.now() - lastNote < 10000) return;
  lastNote = Date.now();
  tgCall(tg.token, "sendMessage", { chat_id: tg.chatId, text: String(text).slice(0, 3500) });
}

// ---------- /goto /follow /come /stop ----------
function command(cmd, targets) {
  const [c, ...a] = cmd.trim().split(/\s+/);
  if (!["/goto", "/follow", "/come", "/stop"].includes(c)) return null;
  return targets.map((b) => {
    const bot = b.bot;
    if (!bot || !b.botState.connected || !bot.pathfinder) return `[${b.name}] belum terhubung`;
    try {
      { const hm = (require("./settings.json").movement || {}).human; bot.pathfinder.setMovements(require("./human").applyMovements(new Movements(bot), bot.registry, !hm || hm.dig !== false)); }
      if (c === "/stop") { bot.pathfinder.setGoal(null); return `[${b.name}] berhenti`; }
      if (c === "/goto") {
        const [x, y, z] = a.map(Number);
        if (a.length < 3 || [x, y, z].some(Number.isNaN)) return "Format: /goto x y z";
        bot.pathfinder.setGoal(new GoalNear(x, y, z, 1));
        return `[${b.name}] menuju ${x} ${y} ${z}`;
      }
      const p = a[0] && bot.players[a[0]] && bot.players[a[0]].entity;
      if (!p) return `[${b.name}] pemain ${a[0] || "?"} tidak terlihat (format: ${c} <pemain>)`;
      if (c === "/follow") bot.pathfinder.setGoal(new GoalFollow(p, 2), true);
      else bot.pathfinder.setGoal(new GoalNear(p.position.x, p.position.y, p.position.z, 1));
      return `[${b.name}] ${c.slice(1)} ${a[0]}`;
    } catch (e) { return `[${b.name}] error: ${e.message}`; }
  });
}

// ---------- dipasang ke tiap bot saat spawn ----------
function attach(bot, mcData, move, log, addInterval, config, state) {
  const on = (k) => config[k] && config[k].enabled;
  const up = () => state.connected && bot._client && !bot._client.ended;

  // Mode aman: bot TIDAK PERNAH keluar dari server (tidak ada bot.quit karena HP rendah).
  // Hanya kabur dari pemain asing (opsional) dan makan kalau HP/lapar turun.
  if (on("safe")) {
    const s = config.safe, wl = (s.whitelist || []).map((x) => String(x).toLowerCase());
    let cool = 0;
    addInterval(() => {
      if (!up() || !bot.entity) return;
      if (s["flee-strangers"] && Date.now() > cool) {
        const o = Object.values(bot.players).find((p) => p.entity && p.username !== bot.username &&
          !wl.includes(p.username.toLowerCase()) && bot.entity.position.distanceTo(p.entity.position) < (s.radius || 16));
        if (!o) return;
        cool = Date.now() + 15000;
        const d = bot.entity.position.minus(o.entity.position), len = Math.hypot(d.x, d.z) || 1;
        const t = bot.entity.position.offset((d.x / len) * 30, 0, (d.z / len) * 30);
        log(`Safe mode: pemain asing ${o.username} mendekat, kabur`); notify(`👀 Pemain asing ${o.username} dekat ${bot.username}`);
        bot.pathfinder.setMovements(move); bot.pathfinder.setGoal(new GoalXZ(t.x, t.z));
      }
    }, 1000);
  }

  // Pengaman global: apa pun yang memanggil bot.quit() dari dalam bot (kecuali tombol Hentikan di panel) diabaikan
  if (!bot.__noQuit) {
    bot.__noQuit = true;
    const realQuit = bot.quit.bind(bot);
    bot.quit = (reason) => {
      if (bot.__allowQuit) return realQuit(reason);
      log("[Anti-keluar] Permintaan keluar diabaikan" + (reason ? ` (${reason})` : ""));
    };
  }

  // Tidur otomatis saat malam
  if (on("sleep")) {
    let busy = false;
    addInterval(async () => {
      if (busy || !up() || !bot.entity || bot.isSleeping || !bot.time || bot.time.isDay) return;
      const bed = bot.findBlock({ matching: (b) => bot.isABed(b), maxDistance: 32 });
      if (!bed) return;
      busy = true;
      try {
        bot.pathfinder.setMovements(move);
        await bot.pathfinder.goto(new GoalNear(bed.position.x, bed.position.y, bed.position.z, 2));
        await bot.sleep(bed); log("Tidur di kasur");
      } catch (e) {}
      busy = false;
    }, 10000);
  }

  // Memancing
  if (on("fishing")) {
    (async () => {
      let warned = false;
      await wait(8000);
      while (up()) {
        try {
          const rod = bot.inventory.items().find((i) => i.name === "fishing_rod");
          const water = bot.findBlock({ matching: mcData.blocksByName.water.id, maxDistance: 6 });
          if (!rod || !water) {
            if (!warned) { warned = true; log("Memancing: butuh fishing_rod di inventory dan air dalam 6 blok"); }
            await wait(15000); continue;
          }
          await bot.equip(rod, "hand");
          await bot.lookAt(water.position.offset(0.5, 0.5, 0.5));
          await bot.fish();
        } catch (e) { await wait(3000); }
      }
    })();
  }

  // Buffer chat untuk tab Chat
  const pushChat = (user, msg, dm) => { chat.push({ t: Date.now(), bot: bot.username, user, msg, dm }); if (chat.length > 100) chat.shift(); };
  bot.on("chat", (u, m) => pushChat(u, m, false));
  bot.on("whisper", (u, m) => pushChat(u, m, true));

  // Pemicu dari pesan server: "teks => notify | restart | cmd:/spawn"
  const trig = Array.isArray(config.triggers) ? config.triggers : [];
  if (trig.length) {
    let coolT = 0;
    bot.on("messagestr", (msg) => {
      if (Date.now() < coolT) return;
      const low = msg.toLowerCase(), t = trig.find((x) => x.match && low.includes(String(x.match).toLowerCase()));
      if (!t) return;
      coolT = Date.now() + 10000;
      log(`Pemicu "${t.match}" -> ${t.action}`);
      if (t.action === "notify") notify(`🔔 ${bot.username}: ${msg.slice(0, 200)}`);
      else if (t.action === "restart") { const b = ctx.manager && ctx.manager.list.find((x) => x.bot === bot); if (b) { ctx.manager.stop(b); ctx.manager.startLater(b, 3000); } }
      else if (t.action === "cmd" && t.arg) bot.chat(t.arg);
    });
  }

  // Pakai armor terbaik di inventory
  if (on("armor")) {
    const tiers = ["leather", "golden", "chainmail", "iron", "diamond", "netherite"], slots = { helmet: "head", chestplate: "torso", leggings: "legs", boots: "feet" };
    const rank = (i) => tiers.indexOf(i.name.split("_")[0]);
    addInterval(async () => {
      if (!up() || !bot.entity) return;
      for (const [part, dest] of Object.entries(slots)) {
        const best = bot.inventory.items().filter((i) => i.name.endsWith("_" + part)).sort((a, b) => rank(b) - rank(a))[0];
        if (!best) continue;
        const cur = bot.inventory.slots[bot.getEquipmentDestSlot(dest)];
        if (cur && rank(cur) >= rank(best)) continue;
        try { await bot.equip(best, dest); } catch (e) {}
      }
    }, 30000);
  }

  // Aturan balas chat: "kata kunci => balasan". {bot} dan {player} diganti otomatis, "*" = semua DM
  const rules = Array.isArray(config.rules) ? config.rules : [];
  if (rules.length) {
    const last = {};
    const react = (user, msg, dm) => {
      if (user === bot.username || Date.now() - (last[user] || 0) < 5000) return;
      const low = msg.toLowerCase();
      const r = rules.find((x) => x.match && ((x.match === "*" && dm) ||
        low.includes(String(x.match).replace(/{bot}/g, bot.username).toLowerCase())));
      if (!r) return;
      last[user] = Date.now();
      // "halo | hai {player}" = beberapa variasi, dipilih acak (tidak sama dengan sebelumnya)
      const text = require("./human2").pickVariant(r.reply, r.match + ":" + bot.username).replace(/{player}/g, user).replace(/{bot}/g, bot.username);
      const out = dm ? `/msg ${user} ${text}` : text;
      if (state.say) state.say(out, { dedupe: true });
      else setTimeout(() => { if (up()) bot.chat(out); }, 1500 + Math.random() * 1500);
    };
    bot.on("chat", (u, m) => react(u, m, false));
    bot.on("whisper", (u, m) => react(u, m, true));
  }

  // Live view dari mata bot utama (butuh: npm i prismarine-viewer)
  const v = config.viewer;
  if (v && v.enabled) {
    if (viewer && viewer.bot._client && viewer.bot._client.ended) {
      try { viewer.bot.viewer.close(); } catch (e) {}
      viewer = null;
    }
    if (!viewer) {
      try {
        const port = viewerPort(config);
        require("prismarine-viewer").mineflayer(bot, { port, firstPerson: true });
        viewer = { bot }; log(`Live view aktif di port ${port}`);
      } catch (e) { log("Live view gagal (jalankan: npm i prismarine-viewer): " + e.message); }
    }
  }
}

// ---------- kontrol Telegram (long polling, tanpa dependency) ----------
function telegram(manager, config, log) {
  const t = config.telegram;
  if (!t || !t.enabled || !t.token || !t.chatId) return;
  tg = { token: t.token, chatId: String(t.chatId) };
  const say = (text) => tgCall(tg.token, "sendMessage", { chat_id: tg.chatId, text: String(text).slice(0, 3500) });
  logger.onLog((l) => { if (/kicked|disconnect|safe mode/i.test(l)) notify("📣 " + l.replace(/^\[[^\]]*\]\s*/, "")); });

  const handle = (text) => {
    const [c0, ...a] = text.split(/\s+/), c = c0.replace(/^[!/]/, "").toLowerCase(), L = manager.list;
    if (c === "status") return say(L.map((b) => `${b.botState.connected ? "🟢" : b.running ? "🟡" : "🔴"} ${b.name} | HP ${b.bot && b.bot.health != null ? Math.round(b.bot.health) : "-"} | Lapar ${b.bot && b.bot.food != null ? b.bot.food : "-"}`).join("\n") || "Tidak ada bot");
    if (c === "pos") return say(L.map((b) => { const p = b.bot && b.bot.entity && b.bot.entity.position; return `${b.name}: ${p ? [p.x, p.y, p.z].map(Math.floor).join(" ") : "-"}`; }).join("\n"));
    if (c === "restart") { L.forEach((b) => { manager.stop(b); manager.startLater(b, 2000); }); return say("Restart semua bot…"); }
    if (c === "start") { manager.startAll(); return say("Menyalakan semua bot…"); }
    if (c === "stop") { L.forEach((b) => manager.stop(b)); return say("Semua bot dihentikan"); }
    if (c === "say") { L.forEach((b) => b.botState.connected && b.bot.chat(a.join(" "))); return say("Terkirim"); }
    if (["goto", "follow", "come"].includes(c)) {
      const out = command(`/${c} ${a.join(" ")}`, L.filter((b) => b.botState.connected));
      return say((out && out.join("\n")) || "Tidak ada bot online");
    }
    say("Perintah: !status !pos !restart !start !stop !say <teks> !goto x y z !follow <pemain> !come <pemain>");
  };

  let off = 0;
  (async () => {
    log("[Telegram] kontrol aktif");
    for (;;) {
      const r = await tgCall(tg.token, "getUpdates", { offset: off, timeout: 25 });
      if (!r || !r.ok) { await wait(5000); continue; }
      for (const u of r.result) {
        off = u.update_id + 1;
        const m = u.message;
        if (m && m.text && String(m.chat.id) === tg.chatId) { try { handle(m.text.trim()); } catch (e) {} }
      }
    }
  })();
}

module.exports = { attach, command, telegram, notify, viewerPort, chat, ctx };
