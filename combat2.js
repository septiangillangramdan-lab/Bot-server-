"use strict";
// Tempur ala pemain:
//  - membalas pemain yang baru memukul bot (bila "balas serangan" menyala)
//  - perintah manual /attack <pemain atau jenis mob>
//  - memilih senjata terbaik, menyerang sesuai cooldown, mengejar target, kabur saat darah tipis
// Pemain dilawan lewat pvp.js (gaya HeroBot) bila aktif; file ini mengurus mob dan cadangan tanpa pvp.js.
const { goals, Movements } = require("mineflayer-pathfinder");
const { GoalFollow, GoalInvert } = goals;
const human = require("./human");

const TIERS = ["wooden", "golden", "stone", "iron", "diamond", "netherite"];
const rnd = (a, b) => a + Math.random() * (b - a);

function attach(bot, mcData, botState, config, log, addInterval) {
  const registry = bot.registry || mcData;
  const st = { target: null, since: 0, maxMs: 0, last: 0, cd: 600, lastHp: bot.health, swings: new Map(), fleeUntil: 0, fleeing: false, gear: 0, ended: false };
  const up = () => !st.ended && botState.connected && bot.entity;
  bot.once("end", () => { st.ended = true; botState.fighting = false; });

  const nameOf = (e) => e.username || e.displayName || e.name || "?";
  const alive = (e) => e && e.position && bot.entities[e.id] && e.isValid !== false;
  const dist = (e) => e.position.distanceTo(bot.entity.position);
  const fightBackOn = () => !(config.combat && config.combat["fight-back"] === false);
  const ctl = (k, v) => { try { bot.setControlState(k, v); } catch (e) {} };

  async function equipWeapon() {
    try {
      const items = bot.inventory.items();
      const rank = (i) => TIERS.indexOf(i.name.split("_")[0]);
      const sword = items.filter((i) => /_sword$/.test(i.name)).sort((a, b) => rank(b) - rank(a))[0];
      const axe = items.filter((i) => /_axe$/.test(i.name)).sort((a, b) => rank(b) - rank(a))[0];
      const w = sword || axe;
      st.cd = sword ? 650 : axe ? 1250 : 520;
      const held = bot.heldItem;
      if (w && (!held || held.type !== w.type)) await bot.equip(w, "hand");
    } catch (e) {}
  }

  function stop(msg) {
    if (!st.target && !botState.fighting) return;
    const t = st.target;
    st.target = null; st.fleeing = false; botState.fighting = false;
    try { bot.pathfinder.setGoal(null); } catch (e) {}
    ctl("sprint", false); ctl("forward", false);
    if (msg) log(`[Tempur] ${t ? nameOf(t) + ": " : ""}${msg}`);
  }

  function start(target, why, ms) {
    if (!up() || !alive(target)) return false;
    st.target = target; st.since = Date.now(); st.maxMs = ms; st.fleeing = false; st.fleeUntil = 0; st.last = 0;
    botState.fighting = true;
    log(`[Tempur] Melawan ${nameOf(target)} (${why})`);
    try {
      const m = human.applyMovements(new Movements(bot), registry, false, false);
      m.allowParkour = false;
      bot.pathfinder.setMovements(m);
      bot.pathfinder.setGoal(new GoalFollow(target, 2), true);
    } catch (e) {}
    equipWeapon();
    return true;
  }

  // ---------- membalas pemain yang memukul ----------
  bot.on("entitySwingArm", (e) => { if (e && e.id != null) st.swings.set(e.id, Date.now()); });
  bot.on("health", () => {
    try {
      const hp = bot.health;
      if (hp != null && st.lastHp != null && hp < st.lastHp - 0.1 && fightBackOn() && !st.target && up()) {
        const now = Date.now();
        let best = null, bd = 6.5;
        for (const e of Object.values(bot.entities)) {
          if (e === bot.entity || e.type !== "player" || !e.position) continue;
          const d = dist(e), sw = st.swings.get(e.id) || 0;
          if (d < bd && now - sw < 900) { bd = d; best = e; }
        }
        if (best) { if (botState.pvp && botState.pvp.enabled && botState.pvpEngage) botState.pvpEngage(best, "membalas serangan"); else start(best, "membalas serangan", 45000); }
      }
      st.lastHp = hp;
    } catch (e) {}
  });

  // ---------- perintah manual ----------
  botState.fight = (query) => {
    if (!up()) return "belum terhubung";
    const q = String(query || "").trim().toLowerCase();
    if (!q) return "format: /attack <nama pemain atau jenis mob>";
    let t = null;
    const p = Object.keys(bot.players).find((n) => n.toLowerCase() === q);
    if (p && bot.players[p].entity) t = bot.players[p].entity;
    if (!t) {
      let bd = 40;
      for (const e of Object.values(bot.entities)) {
        if (e === bot.entity || !e.position || e.type === "player") continue;
        if (String(e.name || "").toLowerCase() === q && dist(e) < bd) { bd = dist(e); t = e; }
      }
    }
    if (!t) return `"${query}" tidak terlihat (harus berada dalam jangkauan bot)`;
    if (t.type === "player" && botState.pvp && botState.pvp.enabled && botState.pvpEngage) return botState.pvpEngage(t, "perintah manual") ? `menyerang ${nameOf(t)}` : "gagal memulai";
    return start(t, "perintah manual", 120000) ? `menyerang ${nameOf(t)}` : "gagal memulai";
  };
  botState.stopFight = () => { stop("dihentikan"); };

  // ---------- loop tempur ----------
  addInterval(() => {
    try {
      if (!st.target) return;
      if (!up()) return stop();
      const now = Date.now(), t = st.target;
      if (!alive(t)) return stop("selesai (target hilang atau kalah)");
      if (now - st.since > st.maxMs) return stop("waktu habis");
      const d = dist(t);
      if (d > 28) return stop("target terlalu jauh");

      // darah tipis: kabur sebentar lalu berhenti
      if (!st.fleeing && bot.health != null && bot.health <= 6) {
        st.fleeing = true; st.fleeUntil = now + 6000;
        log("[Tempur] Darah tipis, kabur");
        try { bot.pathfinder.setGoal(new GoalInvert(new GoalFollow(t, 12)), true); } catch (e) {}
        ctl("sprint", true);
        return;
      }
      if (st.fleeing) { if (now > st.fleeUntil) stop("berhenti melawan"); return; }

      if (now - st.gear > 6000) { st.gear = now; equipWeapon(); }
      ctl("sprint", d > 3.5);
      if (d <= 4.5) { try { bot.lookAt(t.position.offset(0, (t.height || 1.8) * 0.85, 0), true); } catch (e) {} }
      if (d <= 3.2 && now - st.last >= st.cd + rnd(0, 80)) {
        st.last = now;
        bot.attack(t);
        if (bot.entity.onGround && Math.random() < 0.15) { ctl("jump", true); setTimeout(() => ctl("jump", false), 200); }
      }
    } catch (e) {}
  }, 100);
}

module.exports = { attach };
