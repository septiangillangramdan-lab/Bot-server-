"use strict";
// PvP ala HeroBot / Carpet-PVP untuk bot Mineflayer + ingatan musuh ("dendam").
//  - Siapa pun yang memukul bot dilawan sampai tuntas, dengan senjata apa pun yang ada (bahkan tangan kosong)
//  - Teknik: critical hit (lompat lalu pukul saat jatuh), sprint-reset (W-tap), strafe, jaga jarak, perisai, totem, gapple
//  - Ingatan permanen (pvp.json): jumlah pukulan & pembunuhan per pemain. Musuh yang pernah membunuh bot atau sering
//    memukul akan dikejar lagi begitu terlihat (bisa dimatikan: /pvp revenge off). Teman tidak pernah diserang.
const fs = require("fs");
const path = require("path");
const { goals, Movements } = require("mineflayer-pathfinder");
const { GoalFollow, GoalNear } = goals;
const human = require("./human");

const FILE = path.join(process.env.DATA_DIR || __dirname, "pvp.json");
const DEF = { players: {}, friends: [], revenge: true, enabled: true };
let mem = { ...DEF };
try { mem = { ...DEF, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch (e) {}
let dirty = false;
const save = () => { dirty = false; fs.writeFile(FILE, JSON.stringify(mem), () => {}); };
const flushT = setInterval(() => { if (dirty) save(); }, 8000);
if (flushT.unref) flushT.unref();
const touch = () => { dirty = true; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const lc = (s) => String(s || "").toLowerCase();

// ---------- fungsi murni ----------
// damage per serangan penuh dan jeda serangan (ms); dipakai memilih "senjata terbaik" dari apa pun di tas
const TIER_DMG = { wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 };
function weaponStats(name) {
  const tier = name.split("_")[0], t = TIER_DMG[tier];
  if (t === undefined && name !== "trident" && name !== "mace") return null;
  if (/_sword$/.test(name)) return { dmg: 4 + t, cd: 625 };
  if (/_axe$/.test(name)) return { dmg: [7, 9, 9, 9, 10][t], cd: tier === "iron" ? 1120 : tier === "wooden" || tier === "stone" ? 1250 : 1000 };
  if (/_pickaxe$/.test(name)) return { dmg: 2 + t, cd: 830 };
  if (/_shovel$/.test(name)) return { dmg: 2.5 + t * 0.9, cd: 1000 };
  if (/_hoe$/.test(name)) return { dmg: 1, cd: 500 };
  return null;
}
function bestWeapon(inv) {
  let best = null, bs = 4; // tangan kosong: 1 damage / 0.25 dtk = 4 dps
  for (const it of inv) {
    const w = it.name === "trident" ? { dmg: 9, cd: 1100 } : weaponStats(it.name);
    if (!w) continue;
    const dps = w.dmg / (w.cd / 1000);
    if (dps > bs) { bs = dps; best = { item: it, cd: w.cd, dps }; }
  }
  return best;
}
const ARMOR_RANK = { leather: 1, golden: 2, chainmail: 3, iron: 4, diamond: 5, netherite: 6, turtle: 2 };
const SLOT = { helmet: "head", chestplate: "torso", leggings: "legs", boots: "feet" };
function bestArmor(inv) {
  const out = {};
  for (const it of inv) {
    const m = /^(\w+?)_(helmet|chestplate|leggings|boots)$/.exec(it.name);
    if (!m) continue;
    const r = ARMOR_RANK[m[1]] || 0;
    if (!out[m[2]] || r > out[m[2]].r) out[m[2]] = { r, item: it };
  }
  return out;
}
const grudgeScore = (p) => (p ? p.kills * 10 + p.hits : 0);
function isEnemy(rec) { return !!rec && (rec.kills >= 1 || rec.hits >= 3 || rec.marked); }

function attach(bot, mcData, botState, config, log, addInterval) {
  const registry = bot.registry || mcData;
  const pcfg = Object.assign({ enabled: true, revenge: true, crits: true, shield: true, "revenge-radius": 32, "recover-items": true, "flee-hp": 0, whitelist: [], "forget-days": 14 }, (config && config.pvp) || {});
  const S = { target: null, since: 0, last: 0, cd: 625, strafe: 0, strafeUntil: 0, critWait: 0, blocking: false, eating: false, lastGear: 0, lastEnemySeen: 0, lastHitBy: null, lastHitAt: 0, swings: new Map(), lastHp: bot.health, gone: 0, lastPos: null, ended: false, deathPos: null, killer: null, lastDeath: 0 };
  const P = botState.pvp = { get enabled() { return mem.enabled && pcfg.enabled !== false && !S.ended; }, target: "", status: "Siaga", fights: 0 };
  botState.cmds = botState.cmds || {};
  const up = () => !S.ended && botState.connected && bot.entity && bot.health > 0;
  const ctl = (k, v) => { try { bot.setControlState(k, v); } catch (e) {} };
  const alive = (e) => e && e.position && bot.entities[e.id] && e.isValid !== false;
  const nameOf = (e) => (e && (e.username || e.displayName || e.name)) || "?";
  const dist = (e) => e.position.distanceTo(bot.entity.position);
  const friends = () => new Set([...(mem.friends || []), ...(pcfg.whitelist || []), ...(((config && config.safe && config.safe.whitelist) || []))].map(lc));
  bot.once("end", () => { S.ended = true; botState.fighting = false; });

  function rec(name, create) {
    const k = lc(name);
    if (!mem.players[k] && create) mem.players[k] = { name, hits: 0, kills: 0, defeated: 0, first: Date.now(), last: Date.now() };
    return mem.players[k];
  }
  const eligible = (e) => {
    if (!e || e.type !== "player" || e === bot.entity || !e.username || e.username === bot.username) return false;
    if (friends().has(lc(e.username))) return false;
    const pl = bot.players[e.username];
    if (pl && (pl.gamemode === 1 || pl.gamemode === 3)) return false; // kreatif kebal, spectator tidak bisa dipukul
    return true;
  };

  // ---------- perlengkapan ----------
  async function gear(force) {
    const now = Date.now();
    if (!force && now - S.lastGear < 5000) return;
    S.lastGear = now;
    try {
      const inv = bot.inventory.items();
      for (const [kind, r] of Object.entries(bestArmor(inv))) {
        const slot = SLOT[kind], cur = bot.inventory.slots[{ head: 5, torso: 6, legs: 7, feet: 8 }[slot]];
        const curRank = cur ? ARMOR_RANK[cur.name.split("_")[0]] || 0 : 0;
        if (r.r > curRank) await bot.equip(r.item, slot);
      }
      const totem = inv.find((i) => i.name === "totem_of_undying"), shield = inv.find((i) => i.name === "shield");
      const off = bot.inventory.slots[45];
      if (totem && (!off || off.name !== "totem_of_undying")) await bot.equip(totem, "off-hand");
      else if (!totem && pcfg.shield && shield && (!off || off.name !== "shield")) await bot.equip(shield, "off-hand");
      const w = bestWeapon(bot.inventory.items());
      S.cd = w ? w.cd : 250;
      const held = bot.heldItem;
      if (w && (!held || held.type !== w.item.type)) await bot.equip(w.item, "hand");
    } catch (e) {}
  }
  async function heal() {
    if (S.eating || bot.health > 11) return;
    const inv = bot.inventory.items();
    const ench = inv.find((i) => i.name === "enchanted_golden_apple"), gap = inv.find((i) => i.name === "golden_apple");
    const food = bot.health <= 7 && ench ? ench : gap || (bot.food < 18 ? inv.find((i) => registry.foodsByName && registry.foodsByName[i.name] && !/rotten|spider|poison|puffer|chorus/.test(i.name)) : null);
    if (!food) return;
    S.eating = true;
    try { releaseShield(); await bot.equip(food, "hand"); await bot.consume(); } catch (e) {}
    S.eating = false;
    S.lastGear = 0;
  }
  function raiseShield() {
    if (S.blocking) return;
    const off = bot.inventory.slots[45];
    if (!off || off.name !== "shield") return;
    try { bot.activateItem(true); S.blocking = true; } catch (e) {}
  }
  function releaseShield() { if (!S.blocking) return; S.blocking = false; try { bot.deactivateItem(); } catch (e) {} }

  // ---------- memulai / mengakhiri ----------
  function engage(target, why) {
    if (!P.enabled || !up() || !alive(target) || !eligible(target)) return false;
    if (S.target && alive(S.target) && S.target.id !== target.id && S.lastHitBy !== target.id) return true; // tetap pada lawan sekarang kecuali yang baru memukul
    if (!S.target || S.target.id !== target.id) {
      S.target = target; S.since = Date.now(); S.gone = 0; S.lastPos = target.position.clone(); P.fights++;
      botState.fighting = true; P.target = nameOf(target); P.status = "Bertarung";
      log(`[PvP] Melawan ${nameOf(target)} (${why})`);
      try {
        const m = human.applyMovements(new Movements(bot), registry, false, true);
        m.allowParkour = true;
        bot.pathfinder.setMovements(m);
      } catch (e) {}
      gear(true);
    }
    return true;
  }
  function stop(msg) {
    const t = S.target;
    S.target = null; botState.fighting = false; P.target = ""; P.status = "Siaga";
    releaseShield();
    ["forward", "back", "left", "right", "sprint", "jump"].forEach((k) => ctl(k, false));
    try { bot.pathfinder.setGoal(null); } catch (e) {}
    if (msg && t) log(`[PvP] ${nameOf(t)}: ${msg}`);
  }
  botState.pvpEngage = (e, why) => engage(e, why || "perintah");
  botState.fight = ((prev) => (query) => {
    // pemain -> PvP, mob -> modul tempur lama
    const q = lc(query);
    const p = Object.keys(bot.players).find((n) => lc(n) === q);
    if (p) {
      const e = bot.players[p].entity;
      if (!e) return `${p} tidak terlihat (harus dalam jarak render)`;
      if (friends().has(q)) return `${p} ada di daftar teman, tidak diserang`;
      rec(p, true).marked = true; touch();
      return engage(e, "perintah manual") ? `menyerang ${p}` : "tidak bisa menyerang (kreatif/spectator atau PvP mati)";
    }
    return prev ? prev(query) : `"${query}" tidak terlihat`;
  })(botState.fight);

  // ---------- deteksi serangan ----------
  bot.on("entitySwingArm", (e) => { if (e && e.id != null) S.swings.set(e.id, Date.now()); });
  function attackerNow() {
    const now = Date.now();
    let best = null, bd = 7;
    for (const e of Object.values(bot.entities)) {
      if (e === bot.entity || e.type !== "player" || !e.position) continue;
      const d = dist(e), sw = S.swings.get(e.id) || 0;
      if (d < bd && now - sw < 1000) { bd = d; best = e; }
    }
    return best;
  }
  function onHurt() {
    if (!up()) return;
    const a = attackerNow();
    if (!a) return;
    const name = nameOf(a);
    if (friends().has(lc(name))) return;
    const r = rec(name, true); r.hits++; r.last = Date.now(); touch();
    S.lastHitBy = a.id; S.lastHitAt = Date.now(); S.killer = name;
    if (!S.target || !alive(S.target) || dist(a) < dist(S.target) - 1) engage(a, `dipukul ${name} (${r.hits}x)`);
  }
  bot.on("entityHurt", (e) => { if (e === bot.entity) onHurt(); });
  bot.on("health", () => {
    const hp = bot.health;
    if (hp != null && S.lastHp != null && hp < S.lastHp - 0.1 && Date.now() - S.lastHitAt > 300) onHurt(); // server yang tidak mengirim entityHurt
    S.lastHp = hp;
  });

  // ---------- mati & dendam ----------
  function noteDeath(killerName) {
    if (!killerName || killerName === bot.username) return;
    const r = rec(killerName, true); r.kills++; r.last = Date.now(); touch();
    log(`[PvP] Dibunuh ${killerName}, dicatat sebagai musuh (${r.kills}x)`);
  }
  bot.on("death", () => {
    S.lastDeath = Date.now();
    if (bot.entity) S.deathPos = bot.entity.position.clone();
    const who = S.killer && Date.now() - S.lastHitAt < 20000 ? S.killer : null;
    S.deathNoted = false;
    if (who) { noteDeath(who); S.deathNoted = true; }
    stop();
  });
  bot.on("messagestr", (msg) => {
    try {
      const m = /^(\S+) (?:was slain by|was shot by|was killed by|was pummeled by|was fireballed by|was blown up by|was impaled by) (\S+)/.exec(String(msg));
      if (m && m[1] === bot.username && Date.now() - S.lastDeath < 5000 && !S.deathNoted && bot.players[m[2]]) { noteDeath(m[2]); S.deathNoted = true; }
    } catch (e) {}
  });
  bot.on("respawn", async () => {
    if (!pcfg["recover-items"] || !S.deathPos) return;
    const p = S.deathPos; S.deathPos = null;
    await sleep(4000);
    if (!up() || botState.fighting) return;
    try {
      const m = human.applyMovements(new Movements(bot), registry, false, true);
      bot.pathfinder.setMovements(m);
      log("[PvP] Kembali ke lokasi mati untuk mengambil barang");
      await Promise.race([bot.pathfinder.goto(new GoalNear(p.x, p.y, p.z, 2)), sleep(45000)]);
      bot.pathfinder.setGoal(null);
    } catch (e) {}
  });

  // ---------- dendam: kejar musuh yang terlihat ----------
  addInterval(() => {
    try {
      if (!up() || !P.enabled) return;
      // lupakan musuh lama
      const days = pcfg["forget-days"] * 86400000;
      if (Math.random() < 0.02) for (const [k, v] of Object.entries(mem.players)) if (!v.marked && Date.now() - v.last > days) { delete mem.players[k]; touch(); }
      if (S.target || !(mem.revenge && pcfg.revenge)) return;
      let pick = null, ps = 0;
      for (const e of Object.values(bot.entities)) {
        if (!eligible(e) || !alive(e)) continue;
        const r = rec(e.username);
        if (!isEnemy(r) || dist(e) > pcfg["revenge-radius"]) continue;
        const s = grudgeScore(r) - dist(e) * 0.1;
        if (!pick || s > ps) { pick = e; ps = s; }
      }
      if (pick) engage(pick, `dendam (${rec(pick.username).kills} bunuh, ${rec(pick.username).hits} pukul)`);
    } catch (e) {}
  }, 1500);

  // ---------- loop tempur 50 ms ----------
  addInterval(() => {
    try {
      const t = S.target;
      if (!t) return;
      if (!up() || !P.enabled) return stop();
      const now = Date.now();
      if (!alive(t)) {
        if (!S.gone) S.gone = now;
        // target hilang: bisa kalah (mati) atau keluar jarak render; cari ke posisi terakhir sebentar
        const pl = bot.players[nameOf(t)];
        if (pl && pl.entity && alive(pl.entity)) { S.target = pl.entity; S.gone = 0; return; }
        if (now - S.gone > 8000) { const r = rec(nameOf(t)); if (r && S.lastPos && dist({ position: S.lastPos }) < 8) { r.defeated++; touch(); } return stop("selesai (target hilang)"); }
        if (S.lastPos && now % 1000 < 60) { try { bot.pathfinder.setGoal(new GoalNear(S.lastPos.x, S.lastPos.y, S.lastPos.z, 2)); } catch (e) {} }
        return;
      }
      S.gone = 0; S.lastPos = t.position.clone();
      const d = dist(t);
      if (d > 48 || now - S.since > 10 * 60000) return stop(d > 48 ? "terlalu jauh" : "waktu habis");
      const fleeHp = Number(pcfg["flee-hp"]) || 0;
      if (fleeHp && bot.health <= fleeHp) return stop("darah tipis, mundur");

      if (now - S.lastGear > 5000 && !S.eating) gear();
      if (bot.health <= 11 && !S.eating) { heal(); }
      if (S.eating) return;

      const eye = t.position.offset(0, (t.height || 1.8) * 0.9, 0);
      if (d < 6) { try { bot.lookAt(eye, true); } catch (e) {} }

      if (d > 3.4) {
        // kejar: pathfinder untuk jarak jauh, lari lurus untuk jarak dekat
        releaseShield();
        if (d > 7) { try { bot.pathfinder.setGoal(new GoalFollow(t, 2), true); } catch (e) {} ctl("sprint", true); }
        else { try { bot.pathfinder.setGoal(null); } catch (e) {} ctl("forward", true); ctl("sprint", true); ctl("left", false); ctl("right", false); ctl("back", false); }
        if (bot.entity.onGround && d > 3.6 && d < 6 && Math.random() < 0.03) { ctl("jump", true); setTimeout(() => ctl("jump", false), 150); }
        return;
      }
      try { bot.pathfinder.setGoal(null); } catch (e) {}

      // jarak dekat: strafe + jaga jarak
      if (now > S.strafeUntil) { S.strafe = Math.random() < 0.5 ? -1 : 1; S.strafeUntil = now + rnd(500, 1300); }
      ctl("left", S.strafe < 0); ctl("right", S.strafe > 0);
      ctl("back", d < 1.7);
      ctl("forward", d > 2.6);

      const ready = now - S.last >= S.cd + rnd(0, 60);
      if (!ready && d < 4.2 && pcfg.shield && now - S.last < S.cd * 0.7) raiseShield();
      if (ready && d <= 3.05) {
        releaseShield();
        const falling = !bot.entity.onGround && bot.entity.velocity.y < -0.08;
        if (pcfg.crits && bot.entity.onGround && !S.critWait && !bot.entity.isInWater) {
          // critical hit: lompat dulu, pukul saat jatuh
          ctl("jump", true); setTimeout(() => ctl("jump", false), 120);
          S.critWait = now + 520;
          return;
        }
        if (falling || (S.critWait && now > S.critWait) || !pcfg.crits || bot.entity.isInWater) {
          S.critWait = 0; S.last = now;
          bot.attack(t);
          // sprint reset (W-tap) agar knockback penuh
          ctl("sprint", false); setTimeout(() => ctl("sprint", true), 90);
        }
      }
    } catch (e) {}
  }, 50);

  // ---------- perintah ----------
  botState.cmds["/grudge"] = (a) => {
    const sub = lc(a[0]);
    if (sub === "add" && a[1]) { const r = rec(a[1], true); r.marked = true; touch(); return `${a[1]} ditandai sebagai musuh`; }
    const list = Object.values(mem.players).sort((x, y) => grudgeScore(y) - grudgeScore(x)).slice(0, 15);
    return list.length ? "Daftar dendam:\n" + list.map((r) => `${r.name}: dibunuh ${r.kills}x, memukul ${r.hits}x, dikalahkan ${r.defeated || 0}x${r.marked ? " [musuh]" : ""}`).join("\n") : "belum ada catatan musuh";
  };
  botState.cmds["/forgive"] = (a) => {
    if (!a[0]) return "format: /forgive <pemain>";
    const k = lc(a[0]);
    if (!mem.players[k]) return "tidak ada catatan untuk " + a[0];
    delete mem.players[k]; touch();
    if (S.target && lc(nameOf(S.target)) === k) stop("dimaafkan");
    return `${a[0]} dimaafkan`;
  };
  botState.cmds["/pvp"] = (a) => {
    const sub = lc(a[0]);
    if (sub === "on" || sub === "off") { mem.enabled = sub === "on"; touch(); if (!mem.enabled) stop("PvP dimatikan"); return "PvP " + (mem.enabled ? "AKTIF" : "mati"); }
    if (sub === "revenge") { mem.revenge = /^(on|1|ya)$/i.test(a[1] || ""); touch(); return "mode dendam " + (mem.revenge ? "AKTIF (musuh dikejar saat terlihat)" : "mati (hanya membalas saat dipukul)"); }
    if (sub === "friend" && a[1] && a[2]) {
      const n = a[2];
      if (lc(a[1]) === "add") { if (!mem.friends.map(lc).includes(lc(n))) mem.friends.push(n); touch(); if (S.target && lc(nameOf(S.target)) === lc(n)) stop("teman"); return `${n} dijadikan teman (tidak diserang)`; }
      if (lc(a[1]) === "del") { mem.friends = mem.friends.filter((x) => lc(x) !== lc(n)); touch(); return `${n} dihapus dari teman`; }
    }
    if (sub === "friends") return "Teman: " + ([...friends()].join(", ") || "-");
    return `PvP ${mem.enabled ? "AKTIF" : "mati"}, dendam ${mem.revenge ? "AKTIF" : "mati"}, lawan sekarang: ${P.target || "-"}. Perintah: /pvp on|off, /pvp revenge on|off, /pvp friend add|del <nama>, /pvp friends, /grudge, /forgive <nama>, /attack <pemain>`;
  };
  botState.pvpStop = () => stop("dihentikan");
}

function routes(app, manager) {
  app.get("/api/pvp", (req, res) => {
    const players = Object.values(mem.players).sort((a, b) => grudgeScore(b) - grudgeScore(a)).slice(0, 50);
    res.json({ success: true, enabled: mem.enabled, revenge: mem.revenge, friends: mem.friends, players, bots: manager.list.map((b) => ({ id: b.id, online: !!b.botState.connected, target: b.botState.pvp ? b.botState.pvp.target : "", status: b.botState.pvp ? b.botState.pvp.status : "" })) });
  });
  app.post("/api/pvp/cmd", (req, res) => {
    const b = manager.list.find((x) => x.id === (req.body || {}).bot && x.botState.cmds) || manager.list.find((x) => x.botState.cmds);
    const parts = String((req.body || {}).cmd || "").trim().split(/\s+/), c = parts.shift();
    if (!["/pvp", "/grudge", "/forgive"].includes(c)) return res.json({ success: false, msg: "perintah tidak dikenal" });
    if (!b) { // bot offline: ubah data langsung
      if (c === "/forgive" && parts[0]) { delete mem.players[lc(parts[0])]; touch(); return res.json({ success: true, msg: "dimaafkan" }); }
      return res.json({ success: false, msg: "Tidak ada bot online" });
    }
    res.json({ success: true, msg: b.botState.cmds[c](parts) });
  });
}

module.exports = { attach, routes, _t: { weaponStats, bestWeapon, bestArmor, grudgeScore, isEnemy, mem: () => mem } };
