"use strict";
// Mode manusia v2: perilaku natural saat bot diam atau mengobrol.
//  1. kepala menoleh halus (bukan patah-patah), melirik pemain di dekatnya atau yang baru bicara
//  2. ritme tidak monoton: jeda acak, jongkok sebentar, mengayun tangan, ganti slot hotbar, lompat kecil
//  3. chat seperti orang mengetik: jeda berpikir + waktu mengetik, tidak mengulang kalimat yang sama
//  5. aktivitas kecil: makan saat lapar, jalan-jalan dekat titik awal
const { goals, Movements } = require("mineflayer-pathfinder");
const { GoalNear } = goals;
const human = require("./human");

const rnd = (a, b) => a + Math.random() * (b - a);
const BAD_FOOD = /rotten_flesh|spider_eye|poisonous_potato|pufferfish|chorus_fruit|suspicious_stew|raw_chicken/;
const CHAT_CMD = /^\/(msg|w|tell|t|r|reply)\s/i;
const HURT = /lava|fire|magma|cactus|sweet_berry|campfire|powder_snow|wither_rose/;

// pilih salah satu variasi dari "halo | hai {player} | yo", hindari yang sama dengan sebelumnya
const lastPick = new Map();
function pickVariant(text, key) {
  const opts = String(text).split("|").map((s) => s.trim()).filter(Boolean);
  if (opts.length <= 1) return opts[0] || "";
  const prev = lastPick.get(key);
  const pool = opts.filter((o) => o !== prev);
  const out = pool[Math.floor(Math.random() * pool.length)] || opts[0];
  lastPick.set(key, out);
  return out;
}

const isOn = (config) => {
  const h = config.movement && config.movement.human;
  return !h || (h.enabled !== false && h.natural !== false);
};

function attach(bot, mcData, botState, config, log, addInterval) {
  const registry = bot.registry || mcData;
  const st = { queue: [], typing: false, sent: [], next: Date.now() + rnd(3000, 6000), looking: false, eating: false, lastEat: 0, moving: false, movingSince: 0, nextWander: Date.now() + rnd(60000, 180000), ended: false };
  if (!botState.home && bot.entity) botState.home = bot.entity.position.clone();
  const up = () => !st.ended && bot && botState.connected && bot.entity;
  bot.once("end", () => { st.ended = true; });

  // ---------- 3. chat ala manusia ----------
  function pump() {
    if (st.typing || !st.queue.length) return;
    st.typing = true;
    const text = st.queue.shift();
    st.cur = text;
    const wait = Math.min(7000, rnd(600, 1700) + text.length * rnd(55, 125));
    setTimeout(() => {
      st.typing = false; st.cur = null;
      if (!up()) { st.queue.length = 0; return; }
      try { bot.chat(text); botState.lastActivity = Date.now(); } catch (e) {}
      st.sent.push({ s: text, t: Date.now() });
      if (st.sent.length > 20) st.sent.shift();
      setTimeout(pump, rnd(1500, 3500));
    }, wait);
  }
  botState.say = (text, o) => {
    text = String(text == null ? "" : text);
    if (!text) return false;
    if (!isOn(config) || (text[0] === "/" && !CHAT_CMD.test(text))) { try { bot.chat(text); } catch (e) {} return true; } // perintah biasa: langsung
    const now = Date.now();
    if (o && o.dedupe && st.sent.some((x) => x.s === text && now - x.t < 15 * 60 * 1000)) return false; // jangan ulang kalimat yang sama
    if (o && o.dedupe && (st.cur === text || st.queue.includes(text))) return false; // sudah antre / sedang diketik
    if (st.queue.length >= 3) return false;
    st.queue.push(text);
    pump();
    return true;
  };

  if (!isOn(config)) return;

  // ---------- 1. kepala menoleh halus ----------
  const toward = (pt) => {
    const eye = bot.entity.position.offset(0, 1.62, 0);
    const dx = pt.x - eye.x, dy = pt.y - eye.y, dz = pt.z - eye.z;
    return { yaw: Math.atan2(-dx, -dz), pitch: Math.max(-1.2, Math.min(1.2, Math.atan2(dy, Math.hypot(dx, dz)))) };
  };
  const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  function smoothLook(yaw, pitch, ms, done) {
    if (st.looking || !up()) return done && done();
    st.looking = true;
    const y0 = bot.entity.yaw, p0 = bot.entity.pitch, dy = wrap(yaw - y0), dp = pitch - p0;
    const steps = Math.max(4, Math.round(ms / 50));
    let i = 0;
    const step = () => {
      if (!up()) { st.looking = false; return; }
      i++;
      const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // ease in-out
      try { bot.look(y0 + dy * e + (Math.random() - 0.5) * 0.01, p0 + dp * e, true); } catch (er) {}
      if (i < steps) setTimeout(step, 50);
      else { st.looking = false; if (done) done(); }
    };
    step();
  }
  const nearestPlayer = (max) => {
    let best = null, bd = max;
    for (const e of Object.values(bot.entities)) {
      if (e === bot.entity || e.type !== "player" || !e.position) continue;
      const d = e.position.distanceTo(bot.entity.position);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  };
  const glanceAt = (e) => {
    if (!e || !e.position) return;
    const t = toward(e.position.offset(0, 1.62, 0));
    smoothLook(t.yaw, t.pitch, rnd(350, 800));
  };
  bot.on("chat", (u) => {
    if (u === bot.username || busy()) return;
    const e = bot.players[u] && bot.players[u].entity;
    if (e && e.position.distanceTo(bot.entity.position) < 16 && Math.random() < 0.7) setTimeout(() => { if (up() && !busy()) glanceAt(e); }, rnd(300, 1200));
  });

  // ---------- 2 & 5. ritme idle + aktivitas kecil ----------
  const moving = () => !!(bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving());
  const busy = () => botState.patrolActive || botState.fighting || botState.task || botState.walking || st.eating || st.moving || moving() || !!bot.targetDigBlock;
  const ctl = (k, v) => { try { bot.setControlState(k, v); } catch (e) {} };

  const actions = [
    [45, () => {
      const p = nearestPlayer(10);
      if (p && Math.random() < 0.7) return glanceAt(p);
      const y = bot.entity.yaw + rnd(-1.4, 1.4), pi = rnd(-0.35, 0.3);
      smoothLook(y, pi, rnd(400, 1100), () => { if (Math.random() < 0.5) setTimeout(() => { if (up() && !busy()) smoothLook(y + rnd(-0.6, 0.6), rnd(-0.1, 0.1), rnd(500, 1000)); }, rnd(400, 1500)); });
    }],
    [14, () => { try { bot.setQuickBarSlot(Math.floor(Math.random() * 9)); } catch (e) {} }],
    [12, () => { ctl("sneak", true); setTimeout(() => ctl("sneak", false), rnd(300, 900)); }],
    [10, () => { try { bot.swingArm("right"); } catch (e) {} }],
    [8, () => { if (bot.entity.onGround) { ctl("jump", true); setTimeout(() => ctl("jump", false), 250); } }],
    [11, () => {}], // diam saja sejenak
  ];
  const total = actions.reduce((s, a) => s + a[0], 0);
  const pickAction = () => { let r = Math.random() * total; for (const a of actions) { if ((r -= a[0]) <= 0) return a[1]; } return actions[0][1]; };

  // jatuh / masuk ke air: mengapung lalu berenang ke tepi terdekat
  function rescueWater() {
    if (!bot.entity.isInWater) { if (st.swimming) { st.swimming = false; ctl("jump", false); } return false; }
    if (botState.patrolActive || botState.fighting || botState.task) return false;
    st.swimming = true; ctl("jump", true); // mengapung
    if (moving() || st.moving) return true;
    try {
      const Vec3 = bot.entity.position.constructor;
      const shore = bot.findBlock({
        maxDistance: 14,
        matching: (b) => {
          if (!b || b.boundingBox !== "block" || HURT.test(b.name)) return false;
          const u1 = bot.blockAt(b.position.offset(0, 1, 0)), u2 = bot.blockAt(b.position.offset(0, 2, 0));
          return u1 && u2 && u1.boundingBox === "empty" && u2.boundingBox === "empty" && !/water|lava/.test(u1.name);
        },
      });
      if (shore) {
        const m = human.applyMovements(new Movements(bot), registry, false, false);
        bot.pathfinder.setMovements(m);
        bot.pathfinder.setGoal(new GoalNear(shore.position.x + 0.5, shore.position.y + 1, shore.position.z + 0.5, 1));
        st.moving = true; st.movingSince = Date.now();
        log("[Manusia] Di dalam air, berenang ke tepi");
      }
    } catch (e) {}
    return true;
  }

  async function eatIfHungry() {
    if (config.modules && config.modules.survival) return; // survival sudah mengurus makan
    if (st.eating || bot.food == null || bot.food > 14 || Date.now() - st.lastEat < 20000 || busy()) return;
    const foods = registry && registry.foods;
    if (!foods) return;
    const items = bot.inventory.items().filter((i) => foods[i.type] && !BAD_FOOD.test(i.name)).sort((a, b) => foods[b.type].foodPoints - foods[a.type].foodPoints);
    if (!items.length) return;
    st.eating = true; st.lastEat = Date.now();
    try {
      await bot.equip(items[0], "hand");
      await Promise.race([bot.consume(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000))]);
      log(`[Manusia] Makan ${items[0].name}`);
    } catch (e) {}
    st.eating = false;
  }

  function groundNear(cx, cy, cz) {
    const Vec3 = bot.entity.position.constructor;
    for (let y = cy + 3; y >= cy - 4; y--) {
      const f = bot.blockAt(new Vec3(cx, y, cz)), u1 = bot.blockAt(new Vec3(cx, y + 1, cz)), u2 = bot.blockAt(new Vec3(cx, y + 2, cz));
      if (!f || !u1 || !u2) return null;
      if (f.boundingBox === "block" && !HURT.test(f.name) && u1.boundingBox === "empty" && u2.boundingBox === "empty" && !/water|lava/.test(u1.name)) return y + 1;
    }
    return null;
  }
  function wander() {
    const home = botState.home;
    if (!home || !bot.pathfinder) return;
    const circle = config.movement && config.movement["circle-walk"] && config.movement["circle-walk"].enabled;
    if (circle || busy()) return;
    for (let tries = 0; tries < 6; tries++) {
      const ang = Math.random() * Math.PI * 2, r = rnd(2, 10);
      const x = Math.floor(home.x + Math.cos(ang) * r), z = Math.floor(home.z + Math.sin(ang) * r);
      const y = groundNear(x, Math.floor(home.y), z);
      if (y == null) continue;
      try {
        const m = human.applyMovements(new Movements(bot), registry, false, false);
        m.allowParkour = false; m.maxDropDown = 2;
        bot.pathfinder.setMovements(m);
        bot.pathfinder.setGoal(new GoalNear(x + 0.5, y, z + 0.5, 1.5));
        st.moving = true; st.movingSince = Date.now();
        log("[Manusia] Jalan-jalan kecil di sekitar titik awal");
      } catch (e) {}
      return;
    }
  }

  addInterval(() => {
    try {
      if (!up()) return;
      const now = Date.now();
      if (rescueWater()) return; // di air: mengapung & berenang ke tepi
      if (st.moving) {
        if (!moving() && now - st.movingSince > 2500) { st.moving = false; try { bot.pathfinder.setGoal(null); } catch (e) {} }
        else if (now - st.movingSince > 25000) { st.moving = false; try { bot.pathfinder.setGoal(null); } catch (e) {} }
        return;
      }
      eatIfHungry();
      if (busy()) return;
      if (now >= st.nextWander) { st.nextWander = now + rnd(90000, 300000); if (Math.random() < 0.6) { wander(); return; } }
      if (now < st.next || st.looking) return;
      st.next = now + rnd(2500, 9000);
      pickAction()();
      botState.lastActivity = now;
    } catch (e) {}
  }, 500);
}

module.exports = { attach, pickVariant, isOn };
