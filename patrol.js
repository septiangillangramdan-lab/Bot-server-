"use strict";
// Patroli area: bot berjalan keliling kotak yang dibatasi Posisi 1 dan Posisi 2,
// mencatat pemain yang masuk area serta blok yang ditaruh / dihancurkan (lengkap dengan waktu),
// dan menghindari lubang, jurang, serta lava. Semua dibungkus try/catch agar tidak menjatuhkan bot.
const fs = require("fs");
const path = require("path");
const { goals, Movements } = require("mineflayer-pathfinder");
const { GoalNear, GoalXZ } = goals;
const extras = require("./extras");

const FILE = path.join(process.env.DATA_DIR || __dirname, "patrol.json");
const MAX_LOG = 3000;
const MAX_SIDE = 256;
const AIR = new Set(["air", "cave_air", "void_air"]);
const REPLACEABLE = /^(water|lava|short_grass|grass|tall_grass|fern|large_fern|seagrass|tall_seagrass|snow|vine|dead_bush|light)$/;
const DANGER = /lava|fire|magma|cactus|sweet_berry|campfire|powder_snow|wither_rose/;
const SAFE_FLOOR = /water|ladder|vine|scaffolding|bubble_column/;

const DEFAULT_CFG = { enabled: false, bot: "", p1: null, p2: null, ignore: [], notify: false, step: 6 };
let data = { cfg: { ...DEFAULT_CFG }, log: [] };
try {
  const d = JSON.parse(fs.readFileSync(FILE, "utf8"));
  data.cfg = { ...DEFAULT_CFG, ...(d.cfg || {}) };
  data.log = Array.isArray(d.log) ? d.log.slice(-MAX_LOG) : [];
} catch (e) {}

let dirty = false;
const save = () => {
  dirty = false;
  fs.writeFile(FILE, JSON.stringify(data), () => {});
};
const flush = setInterval(() => { if (dirty) save(); }, 10000);
if (flush.unref) flush.unref();

const ctx = { manager: null };
const status = { t: 0, bot: "", msg: "", inside: [], wp: 0, wpTotal: 0, holes: 0 };

const lower = (s) => String(s || "").toLowerCase();
const validBox = (c) => !!(c && c.p1 && c.p2);
function boxOf(c) {
  const a = c.p1, b = c.p2;
  return {
    x1: Math.min(a.x, b.x), x2: Math.max(a.x, b.x),
    y1: Math.min(a.y, b.y), y2: Math.max(a.y, b.y),
    z1: Math.min(a.z, b.z), z2: Math.max(a.z, b.z),
  };
}

// ---------- pencatatan ----------
function record(player, kind, detail, pos, extra) {
  const now = Date.now(), L = data.log;
  if (kind === "taruh" || kind === "hancur") {
    // gabungkan aksi beruntun yang sama (pemain, jenis, blok) dalam 8 detik menjadi satu baris
    for (let i = L.length - 1; i >= 0 && i > L.length - 25; i--) {
      const e = L[i];
      if (e.p === player && e.k === kind && e.d === detail && now - (e.t2 || e.t) < 8000) {
        e.n = (e.n || 1) + 1; e.t2 = now; dirty = true; return;
      }
    }
  }
  const e = { t: now, p: player, k: kind, d: detail || "", n: 1 };
  if (pos) { e.x = Math.floor(pos.x); e.y = Math.floor(pos.y); e.z = Math.floor(pos.z); }
  if (extra && extra.dur != null) e.dur = extra.dur;
  L.push(e);
  if (L.length > MAX_LOG) L.splice(0, L.length - MAX_LOG);
  dirty = true;
  if (data.cfg.notify && kind !== "keluar") {
    const at = pos ? ` (${e.x} ${e.y} ${e.z})` : "";
    extras.notify(kind === "masuk" ? `👀 ${player} masuk area patroli${at}` : `${kind === "taruh" ? "🧱" : "⛏"} ${player} ${kind === "taruh" ? "menaruh" : "menghancurkan"} ${detail}${at}`);
  }
}

// ---------- per bot ----------
function attach(bot, log, addInterval, botState) {
  const Vec3 = bot.entity.position.constructor;
  const st = { wp: [], sig: "", idx: 0, target: null, since: 0, lastPos: null, lastMove: 0, cool: 0, skipped: 0, noPath: 0, inside: new Map(), lastHole: 0, lastFall: 0, wasMine: false };

  const entry = () => ctx.manager && ctx.manager.list.find((b) => b.bot === bot);
  const mine = () => {
    const c = data.cfg;
    if (!c.enabled || !validBox(c) || !botState.connected || !bot.entity) return false;
    const e = entry();
    if (!e) return false;
    return c.bot ? e.id === c.bot : e === ctx.manager.list[0];
  };
  const botNames = () => new Set((ctx.manager ? ctx.manager.list : []).map((b) => lower(b.bot && b.bot.username)).concat(lower(bot.username)));
  const ignored = () => new Set((data.cfg.ignore || []).map(lower));
  const isStandable = (b) => b && b.boundingBox === "block" && !DANGER.test(b.name);

  function movements() {
    const m = new Movements(bot);
    m.canDig = false;
    m.allow1by1towers = false;
    m.allowParkour = false;
    m.allowSprinting = false;
    m.maxDropDown = 2;
    m.scafoldingBlocks = [];
    return m;
  }

  function genWaypoints(b, step) {
    const w = b.x2 - b.x1 + 1, d = b.z2 - b.z1 + 1;
    let s = Math.max(3, step);
    const axis = (from, len) => { const n = Math.max(1, Math.ceil(len / s)); return Array.from({ length: n }, (_, i) => Math.floor(from + ((i + 0.5) * len) / n)); };
    let xs = axis(b.x1, w), zs = axis(b.z1, d);
    while (xs.length * zs.length > 200) { s *= 1.5; xs = axis(b.x1, w); zs = axis(b.z1, d); }
    const out = [];
    zs.forEach((z, i) => (i % 2 ? xs.slice().reverse() : xs).forEach((x) => out.push({ x, z })));
    return out;
  }

  // y tempat berpijak di kolom (x,z): undefined = chunk belum termuat, null = tidak ada pijakan aman
  function groundY(b, x, z) {
    for (let y = b.y2 + 1; y >= b.y1 - 2; y--) {
      const f = bot.blockAt(new Vec3(x, y, z)), u1 = bot.blockAt(new Vec3(x, y + 1, z)), u2 = bot.blockAt(new Vec3(x, y + 2, z));
      if (!f || !u1 || !u2) return undefined;
      if (isStandable(f) && u1.boundingBox === "empty" && u2.boundingBox === "empty" && !/water|lava/.test(u1.name)) return y + 1;
    }
    return null;
  }

  // lubang / lava tepat di depan arah jalan bot (cadangan bila jalur lama belum dihitung ulang)
  function holeAhead() {
    const v = bot.entity.velocity, p = bot.entity.position;
    const sp = Math.hypot(v.x, v.z);
    if (sp < 0.04 || !bot.entity.onGround) return false;
    const dx = v.x / sp, dz = v.z / sp, fy = Math.floor(p.y);
    for (const dist of [1.1, 1.9]) {
      const x = Math.floor(p.x + dx * dist), z = Math.floor(p.z + dz * dist);
      let solid = false, danger = false;
      for (let y = fy - 1; y >= fy - 3; y--) {
        const b = bot.blockAt(new Vec3(x, y, z));
        if (!b) { solid = true; break; }
        if (DANGER.test(b.name)) { danger = true; break; }
        if (b.boundingBox === "block" || SAFE_FLOOR.test(b.name)) { solid = true; break; }
      }
      const feet = bot.blockAt(new Vec3(x, fy, z));
      if (feet && DANGER.test(feet.name)) danger = true;
      if (!solid || danger) return true;
    }
    return false;
  }

  const stopMoving = () => {
    try { bot.pathfinder.setGoal(null); } catch (e) {}
    try { ["forward", "back", "left", "right", "jump", "sprint"].forEach((k) => bot.setControlState(k, false)); } catch (e) {}
  };
  const skip = (why, wait) => {
    stopMoving();
    st.target = null; st.idx = (st.idx + 1) % Math.max(1, st.wp.length); st.skipped++;
    st.cool = Date.now() + (wait || 600);
    if (why) log("[Patroli] " + why);
  };

  bot.on("path_update", (r) => { if (r && r.status === "noPath") st.noPath = Date.now(); });

  // ---------- deteksi blok ditaruh / dihancurkan ----------
  bot.on("blockUpdate", (o, n) => {
    try {
      if (!o || !n || !n.position || !mine()) return;
      const b = boxOf(data.cfg), p = n.position;
      if (p.x < b.x1 || p.x > b.x2 || p.y < b.y1 - 1 || p.y > b.y2 + 1 || p.z < b.z1 || p.z > b.z2) return;
      const oa = AIR.has(o.name), na = AIR.has(n.name);
      let kind, name;
      if (oa && !na) { kind = "taruh"; name = n.name; }
      else if (!oa && na) { kind = "hancur"; name = o.name; }
      else if (!oa && !na && o.name !== n.name && REPLACEABLE.test(o.name) && !REPLACEABLE.test(n.name)) { kind = "taruh"; name = n.name; }
      else return;
      // pelaku = pemain terdekat dalam jangkauan (maks 7,5 blok); tanpa pemain di dekatnya dianggap proses alam
      const c = p.offset(0.5, 0.5, 0.5);
      let best = null, bd = 99;
      for (const e of Object.values(bot.entities)) {
        if (e.type !== "player" || !e.username || !e.position) continue;
        const d = e.position.offset(0, 1, 0).distanceTo(c);
        if (d < bd) { bd = d; best = e; }
      }
      if (!best || bd > 7.5) return;
      const who = best.username;
      if (botNames().has(lower(who)) || ignored().has(lower(who))) return;
      record(who, kind, name, p);
    } catch (e) {}
  });

  // ---------- loop utama ----------
  function tick() {
    const now = Date.now();
    if (!mine()) {
      if (st.wasMine) { st.wasMine = false; botState.patrolActive = false; st.target = null; st.inside.clear(); stopMoving(); }
      return;
    }
    if (!st.wasMine) { st.wasMine = true; st.target = null; st.cool = 0; log("[Patroli] Mulai berpatroli"); }
    botState.patrolActive = true;
    botState.lastActivity = now;

    const cfg = data.cfg, b = boxOf(cfg), pos = bot.entity.position;
    status.t = now; status.bot = (entry() || {}).id || ""; status.wpTotal = st.wp.length; status.wp = st.idx + 1;

    // titik patroli dibuat ulang bila area / jarak berubah
    const sig = [cfg.p1.x, cfg.p1.y, cfg.p1.z, cfg.p2.x, cfg.p2.y, cfg.p2.z, cfg.step].join(",");
    if (sig !== st.sig) { st.sig = sig; st.wp = genWaypoints(b, Number(cfg.step) || 6); st.idx = 0; st.target = null; st.skipped = 0; }

    // ---- deteksi pemain di dalam area ----
    const bots = botNames(), ign = ignored(), present = new Set();
    for (const e of Object.values(bot.entities)) {
      if (e.type !== "player" || !e.username || !e.position || e === bot.entity) continue;
      const name = e.username, ep = e.position;
      if (bots.has(lower(name)) || ign.has(lower(name))) continue;
      if (ep.x >= b.x1 - 0.5 && ep.x <= b.x2 + 1.5 && ep.z >= b.z1 - 0.5 && ep.z <= b.z2 + 1.5 && ep.y >= b.y1 - 2 && ep.y <= b.y2 + 3) {
        present.add(name);
        const cur = st.inside.get(name);
        if (cur) cur.last = now;
        else { st.inside.set(name, { since: now, last: now }); record(name, "masuk", "", ep); }
      }
    }
    for (const [name, v] of st.inside) {
      if (!present.has(name) && now - v.last > 15000) {
        st.inside.delete(name);
        record(name, "keluar", "", null, { dur: Math.round((v.last - v.since) / 1000) });
      }
    }
    status.inside = [...st.inside.keys()];

    // ---- jatuh ke bawah area ----
    if (pos.y < b.y1 - 4 && now - st.lastFall > 15000) {
      st.lastFall = now; status.holes++;
      log(`[Patroli] Bot turun jauh di bawah area (y ${Math.floor(pos.y)}), mencari jalan kembali`);
      st.target = null; st.cool = 0;
    }

    if (!st.wp.length) { status.msg = "Tidak ada titik patroli"; return; }
    if (now < st.cool) return;

    if (!st.target) {
      if (st.skipped >= st.wp.length) {
        st.skipped = 0; st.cool = now + 30000; stopMoving();
        status.msg = "Tidak ada titik aman, coba lagi sebentar lagi";
        log("[Patroli] Tidak ada titik aman di area (semua dilewati), menunggu 30 detik");
        return;
      }
      const wp = st.wp[st.idx % st.wp.length];
      const y = groundY(b, wp.x, wp.z);
      if (y === null) return skip(`Titik ${wp.x} ${wp.z} bolong / tidak ada pijakan, dilewati`, 200);
      try {
        bot.pathfinder.setMovements(movements());
        bot.pathfinder.setGoal(y === undefined ? new GoalXZ(wp.x + 0.5, wp.z + 0.5) : new GoalNear(wp.x + 0.5, y, wp.z + 0.5, 1.2));
      } catch (e) { return skip("Gagal menyusun jalur: " + e.message, 3000); }
      st.target = { x: wp.x + 0.5, y: y === undefined ? null : y, z: wp.z + 0.5 };
      st.since = now; st.lastMove = now; st.lastPos = pos.clone();
      status.msg = `Berpatroli (titik ${st.idx + 1}/${st.wp.length})`;
      return;
    }

    const t = st.target;
    const dh = Math.hypot(pos.x - t.x, pos.z - t.z);
    if (dh <= 1.8 && (t.y === null || Math.abs(pos.y - t.y) <= 2)) {
      // sampai: berhenti sebentar sambil menoleh ke sekitar lalu lanjut
      stopMoving();
      st.target = null; st.skipped = 0; st.idx = (st.idx + 1) % st.wp.length;
      st.cool = now + 1200 + Math.floor(Math.random() * 2500);
      try { bot.look(Math.random() * Math.PI * 2, 0, true); } catch (e) {}
      return;
    }
    // bergerak? (anggap macet bila 15 detik bergeser < 0,4 blok)
    if (st.lastPos.distanceTo(pos) > 0.4) { st.lastPos = pos.clone(); st.lastMove = now; }
    if (holeAhead()) {
      if (now - st.lastHole > 4000) log("[Patroli] Ada lubang / lava di depan, menghindar");
      st.lastHole = now; status.holes++;
      return skip(null, 900);
    }
    if (st.noPath > st.since) return skip("Jalur ke titik " + (st.idx + 1) + " tidak ditemukan, dilewati", 400);
    if (now - st.lastMove > 15000) return skip("Bot tersangkut, pindah ke titik berikutnya", 800);
    if (now - st.since > 90000) return skip("Terlalu lama menuju titik, dilewati", 400);
  }

  addInterval(() => { try { tick(); } catch (e) { log("[Patroli] " + e.message); } }, 700);
  bot.once("end", () => { botState.patrolActive = false; });
}

// ---------- API untuk panel ----------
function routes(app, manager, config, addLog) {
  ctx.manager = manager;
  const num = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Math.floor(Number(v)));
  const point = (o) => {
    if (o === null) return null;
    if (!o || typeof o !== "object") return false;
    const x = num(o.x), y = num(o.y), z = num(o.z);
    if (x === null || y === null || z === null || [x, y, z].some((v) => Math.abs(v) > 3e7)) return false;
    return { x, y, z };
  };
  const sizeOk = (c) => { if (!validBox(c)) return true; const b = boxOf(c); return b.x2 - b.x1 + 1 <= MAX_SIDE && b.z2 - b.z1 + 1 <= MAX_SIDE; };
  const view = () => {
    const active = !!status.t && Date.now() - status.t < 3000 && data.cfg.enabled;
    let msg = status.msg;
    if (!data.cfg.enabled) msg = "Patroli mati";
    else if (!validBox(data.cfg)) msg = "Atur Posisi 1 dan Posisi 2 dulu";
    else if (!active) msg = "Menunggu bot masuk server";
    return {
      cfg: data.cfg,
      status: { active, msg, bot: status.bot, inside: active ? status.inside : [], wp: status.wp, wpTotal: status.wpTotal, holes: status.holes },
      bots: manager.list.map((b) => ({ id: b.id, online: !!b.botState.connected, main: b === manager.list[0] })),
      total: data.log.length,
      persistent: !!process.env.DATA_DIR,
      survival: !!(config.modules && config.modules.survival),
    };
  };

  app.get("/api/patrol", (req, res) => res.json({ success: true, ...view() }));

  app.post("/api/patrol/config", (req, res) => {
    const b = req.body || {}, c = { ...data.cfg };
    if (b.enabled !== undefined) c.enabled = !!b.enabled;
    if (b.notify !== undefined) c.notify = !!b.notify;
    if (b.p1 !== undefined) { const p = point(b.p1); if (p === false) return res.json({ success: false, msg: "Posisi 1 tidak valid" }); c.p1 = p; }
    if (b.p2 !== undefined) { const p = point(b.p2); if (p === false) return res.json({ success: false, msg: "Posisi 2 tidak valid" }); c.p2 = p; }
    if (b.bot !== undefined) {
      const id = String(b.bot || "");
      if (id && !manager.list.find((x) => x.id === id)) return res.json({ success: false, msg: "Bot tidak ditemukan" });
      c.bot = id;
    }
    if (b.step !== undefined) c.step = Math.min(16, Math.max(3, num(b.step) || 6));
    if (b.ignore !== undefined) {
      const arr = Array.isArray(b.ignore) ? b.ignore : String(b.ignore || "").split(/[\s,]+/);
      c.ignore = arr.map((s) => String(s).trim()).filter((s) => /^[A-Za-z0-9_.]{1,20}$/.test(s)).slice(0, 50);
    }
    if (!sizeOk(c)) return res.json({ success: false, msg: `Area terlalu besar (maksimal ${MAX_SIDE} blok per sisi)` });
    if (c.enabled && !validBox(c)) return res.json({ success: false, msg: "Atur Posisi 1 dan Posisi 2 dulu" });
    data.cfg = c; save();
    addLog(`[Patroli] Pengaturan disimpan (${c.enabled ? "aktif" : "mati"})`);
    res.json({ success: true, ...view() });
  });

  // ambil koordinat dari posisi bot saat ini
  app.post("/api/patrol/here", (req, res) => {
    const { which, bot: id } = req.body || {};
    if (which !== "p1" && which !== "p2") return res.json({ success: false, msg: "Pilih p1 atau p2" });
    const b = manager.list.find((x) => x.id === id && x.botState.connected) || manager.list.find((x) => x.botState.connected);
    const e = b && b.bot && b.bot.entity;
    if (!e) return res.json({ success: false, msg: "Bot belum terhubung" });
    const p = { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) };
    const c = { ...data.cfg, [which]: p };
    if (!sizeOk(c)) return res.json({ success: false, msg: `Area terlalu besar (maksimal ${MAX_SIDE} blok per sisi)` });
    data.cfg = c; save();
    res.json({ success: true, which, point: p, ...view() });
  });

  // daftar kejadian + ringkasan per pemain, difilter rentang waktu
  const query = (q) => {
    const since = Number(q.since) || 0, until = Number(q.until) || Date.now() + 1;
    const who = lower(q.player), kinds = q.kind ? new Set(String(q.kind).split(",")) : null;
    const rows = data.log.filter((e) => (e.t2 || e.t) >= since && e.t <= until && (!who || lower(e.p).includes(who)) && (!kinds || kinds.has(e.k)));
    const map = new Map();
    rows.forEach((e) => {
      let s = map.get(e.p);
      if (!s) map.set(e.p, (s = { p: e.p, first: e.t, last: e.t2 || e.t, masuk: 0, taruh: 0, hancur: 0 }));
      s.first = Math.min(s.first, e.t); s.last = Math.max(s.last, e.t2 || e.t);
      if (e.k === "masuk") s.masuk++;
      else if (e.k === "taruh") s.taruh += e.n || 1;
      else if (e.k === "hancur") s.hancur += e.n || 1;
    });
    return { rows, players: [...map.values()].sort((a, b) => b.last - a.last) };
  };
  app.get("/api/patrol/log", (req, res) => {
    const r = query(req.query || {});
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 150));
    res.json({ success: true, total: r.rows.length, rows: r.rows.slice(-limit).reverse(), players: r.players });
  });
  app.get("/api/patrol/log.csv", (req, res) => {
    const r = query(req.query || {});
    const q = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
    const lines = ["waktu_utc,pemain,aksi,detail,jumlah,x,y,z,durasi_detik"].concat(
      r.rows.map((e) => [new Date(e.t).toISOString(), e.p, e.k, e.d, e.n, e.x, e.y, e.z, e.dur].map(q).join(","))
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="patroli.csv"');
    res.send(lines.join("\n"));
  });
  app.delete("/api/patrol/log", (req, res) => { data.log = []; save(); res.json({ success: true }); });
  app.post("/api/patrol/log/clear", (req, res) => { data.log = []; save(); res.json({ success: true }); });
}

module.exports = { attach, routes };
