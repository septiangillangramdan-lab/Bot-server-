"use strict";
// Mode Manusia Penuh (autonomy): bot bertindak mandiri seperti pemain survival.
//  - berenang melewati air, menjauh dari lava/api, naik dengan menumpuk (pillar) atau menggali
//  - melawan monster (dan pemain: membalas serangan / perintah /kill), makan, pakai armor
//  - mencari bahan (kayu, batu, ore, hewan), crafting bertingkat otomatis, melebur di tungku
//  - membangun rumah kalau bahan ada (kalau belum ada, bahan dicari dulu)
// Semua dibungkus try/catch supaya kegagalan di sini tidak pernah menjatuhkan bot.
const { goals, Movements } = require("mineflayer-pathfinder");
const { GoalNear, GoalFollow, GoalXZ, GoalBlock } = goals;
const human = require("./human");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const abortErr = (m) => { const e = new Error(m); e.abort = true; return e; };

const HOSTILE = new Set(["zombie", "husk", "drowned", "skeleton", "stray", "bogged", "spider", "cave_spider", "witch", "pillager", "vindicator", "evoker", "ravager", "vex", "slime", "magma_cube", "zombie_villager", "phantom", "blaze", "guardian", "elder_guardian", "silverfish", "endermite", "hoglin", "zoglin", "piglin_brute", "creeper", "breeze"]);
const FLEE = new Set(["warden", "ghast"]); // terlalu berbahaya: kabur saja
const ANIMALS = ["cow", "pig", "sheep", "chicken", "rabbit"];
const HURT = /lava|^fire$|soul_fire|magma_block|cactus|sweet_berry|campfire|powder_snow|wither_rose/;
const REPLACEABLE = /^(short_grass|grass|tall_grass|fern|large_fern|dead_bush|snow|vine|seagrass|tall_seagrass)$|flower|tulip|dandelion|poppy|orchid|allium|bluet|cornflower|lily_of/;
const BUILD_BLOCK = /^(cobblestone|cobbled_deepslate|stone|stone_bricks|andesite|diorite|granite|dirt|netherrack|sandstone|deepslate|[a-z_]+_planks)$/;
const BAD_FOOD = /rotten_flesh|spider_eye|poisonous_potato|pufferfish|suspicious_stew|chorus_fruit/;
const TIER = { wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 };
const ARMOR_RANK = { leather: 0, golden: 1, chainmail: 2, iron: 3, diamond: 4, netherite: 5 };
const ARMOR = [["head", "_helmet"], ["torso", "_chestplate"], ["legs", "_leggings"], ["feet", "_boots"]];

// barang yang didapat dengan menambang / mengambil langsung dari alam
const NATURAL = /^(?:[a-z_]+_log|cobblestone|cobbled_deepslate|dirt|sand|gravel|coal|raw_iron|raw_gold|raw_copper|diamond|redstone|lapis_lazuli|clay_ball|flint|obsidian|netherrack|snowball|wheat_seeds)$/;
const SMELT = { iron_ingot: "raw_iron", gold_ingot: "raw_gold", copper_ingot: "raw_copper", glass: "sand", stone: "cobblestone", brick: "clay_ball", charcoal: "oak_log", cooked_beef: "beef", cooked_porkchop: "porkchop", cooked_chicken: "chicken", cooked_mutton: "mutton", cooked_rabbit: "rabbit" };
const MOB_DROPS = { beef: ["cow"], porkchop: ["pig"], chicken: ["chicken"], mutton: ["sheep"], rabbit: ["rabbit"], leather: ["cow"], feather: ["chicken"], string: ["spider"], bone: ["skeleton"], gunpowder: ["creeper"], rotten_flesh: ["zombie"], ender_pearl: ["enderman"], white_wool: ["sheep"] };
const ORE_Y = { iron_ore: 16, raw_iron: 16, raw_gold: -16, raw_copper: 40, diamond: -54, redstone: -54, lapis_lazuli: 0, coal: 40 };
const ALIAS = { kayu: "log", wood: "log", batu: "cobblestone", stone: "cobblestone", besi: "iron_ingot", iron: "iron_ingot", emas: "gold_ingot", gold: "gold_ingot", berlian: "diamond", arang: "coal", pasir: "sand", tanah: "dirt", papan: "planks", tongkat: "stick", meja: "crafting_table", tungku: "furnace", makanan: "food", daging: "beef" };

function attach(bot, mcData, botState, config, log, addInterval) {
  const C = (config && config.autonomy) || {};
  const CC = C.combat || {}, CB = C.build || {}, CP = C.progress || {};
  const owners = (C.owners || []).map((s) => String(s).toLowerCase());
  const Vec3 = bot.entity.position.constructor;
  const v = (x, y, z) => new Vec3(x, y, z);
  const st = {
    auto: C.auto !== false, alert: null, task: null, running: null, abort: false, queue: [], backoff: {},
    forced: null, enemies: new Map(), ignore: new Map(), lastHit: 0, engage: null, followId: null, backoffUntil: 0, fleeSince: 0,
    eating: false, swim: false, ended: false, house: null, badItems: new Set(), lastCombat: 0, lastPillar: 0, heading: null, tablePos: null,
  };
  const alive = () => !st.ended && bot && botState.connected && bot.entity;
  bot.once("end", () => { st.ended = true; });
  botState.autonomy = api();
  botState.autoOn = true;

  // ---------- pergerakan: boleh berenang, menggali, menaruh blok; menghindari lava ----------
  const move = (() => {
    const m = new Movements(bot, mcData);
    human.applyMovements(m, bot.registry || mcData, true);
    m.canDig = true; m.allowSprinting = true; m.allowParkour = true; m.allow1by1towers = true;
    m.liquidCost = 2; m.digCost = 3; m.maxDropDown = 4; m.dontCreateFlow = true; m.dontMineUnderFallingBlock = true;
    try {
      for (const n of ["lava", "fire", "soul_fire", "magma_block", "cactus", "sweet_berry_bush", "campfire", "soul_campfire", "powder_snow", "wither_rose", "cobweb"]) {
        const b = mcData.blocksByName[n];
        if (b && m.blocksToAvoid && m.blocksToAvoid.add) m.blocksToAvoid.add(b.id);
      }
      m.exclusionAreasStep = (m.exclusionAreasStep || []).concat([(b) => (b && HURT.test(b.name) ? 1000 : 0)]);
    } catch (e) {}
    const ids = mcData.itemsArray.filter((i) => /^(cobblestone|dirt|netherrack|stone|cobbled_deepslate|[a-z_]+_planks)$/.test(i.name)).map((i) => i.id);
    m.scafoldingBlocks = ids; m.scaffoldingBlocks = ids; // nama properti berbeda antar versi pathfinder
    return m;
  })();
  try { bot.pathfinder.thinkTimeout = 6000; } catch (e) {}

  // ---------- helper umum ----------
  const items = () => bot.inventory.items();
  const matchName = (name) => (name === "log" ? /_log$/ : name === "planks" ? /_planks$/ : new RegExp("^" + name + "$"));
  const count = (name) => { const re = matchName(name); return items().filter((i) => re.test(i.name)).reduce((n, i) => n + i.count, 0); };
  const dist = (e) => bot.entity.position.distanceTo(e.position);
  const solid = (b) => !!b && b.boundingBox === "block";
  const liquid = (b) => !!b && /^(water|lava)$/.test(b.name);
  const isAir = (b) => !b || /^(air|cave_air|void_air)$/.test(b.name);
  const night = () => { const t = bot.time && bot.time.timeOfDay; return t >= 12700 && t <= 23000; };
  const dusk = () => { const t = bot.time && bot.time.timeOfDay; return t >= 11500 && t <= 23000; };
  const nearestEntity = (pred, range) => Object.values(bot.entities).filter((e) => e !== bot.entity && e.position && dist(e) < range && pred(e)).sort((a, b) => dist(a) - dist(b))[0];
  const isItem = (e) => e.name === "item" || e.displayName === "Item" || e.objectType === "Item";
  const nameOf = (x) => (mcData.items[x] ? mcData.items[x].name : String(x));
  const alias = (n) => ALIAS[String(n).toLowerCase()] || String(n).toLowerCase();

  function stopMotion() {
    try { bot.pathfinder.setGoal(null); } catch (e) {}
    st.followId = null;
    for (const k of ["forward", "back", "left", "right", "sprint", "jump"]) { try { bot.setControlState(k, false); } catch (e) {} }
    st.swim = false;
  }

  async function checkpoint() {
    if (!alive()) throw abortErr("terputus");
    if (st.abort) throw abortErr("dibatalkan");
    let w = 0;
    while (st.alert && alive() && !st.abort && w < 1200) { await wait(250); w++; } // tunggu reflex selesai menangani bahaya
    if (st.abort) throw abortErr("dibatalkan");
  }

  async function goto(goal, timeout) {
    for (let i = 0; i < 3; i++) {
      await checkpoint();
      try { bot.pathfinder.setMovements(move); } catch (e) {}
      let to;
      try {
        const gp = bot.pathfinder.goto(goal);
        gp.catch(() => {});
        const timer = new Promise((_, rej) => { to = setTimeout(() => { try { bot.pathfinder.setGoal(null); } catch (e) {} rej(new Error("timeout jalan")); }, timeout || 40000); });
        await Promise.race([gp, timer]);
        return true;
      } catch (e) {
        if (st.abort) throw abortErr("dibatalkan");
        if (st.alert || /goal was changed|stopped|interrupted/i.test(e.message)) continue;
        throw e;
      } finally { clearTimeout(to); }
    }
    throw new Error("jalan terganggu berulang kali");
  }
  const gotoNear = (p, r, t) => goto(new GoalNear(p.x, p.y, p.z, r), t);

  async function runTask(name, fn, user) {
    if (st.running) {
      if (!user) return;
      st.abort = true;
      await st.running.catch(() => {});
    }
    st.abort = false; st.task = name;
    log(`[Auto] Mulai: ${name}`);
    const p = (async () => {
      try { await fn(); log(`[Auto] Selesai: ${name}`); }
      catch (e) {
        if (e && e.abort) log(`[Auto] Dibatalkan: ${name}`);
        else { log(`[Auto] Gagal ${name}: ${e && e.message}`); st.backoff[name] = Date.now() + 180000; }
      } finally { st.task = null; st.running = null; if (alive()) stopMotion(); }
    })();
    st.running = p;
    return p;
  }

  // ---------- inventaris: makan, senjata, armor ----------
  const foodList = () => {
    const foods = mcData.foods || {};
    return items().filter((i) => foods[i.type] && !BAD_FOOD.test(i.name)).sort((a, b) => foods[b.type].foodPoints - foods[a.type].foodPoints);
  };
  async function eat(item) {
    if (st.eating || !item) return;
    st.eating = true;
    try {
      await bot.equip(item, "hand");
      await Promise.race([bot.consume(), wait(8000)]);
    } catch (e) {}
    st.eating = false;
  }
  const weaponRank = (i) => (TIER[i.name.split("_")[0]] || 0) + (/sword$/.test(i.name) ? 0.5 : 0);
  const bestWeapon = () => items().filter((i) => /_(sword|axe)$/.test(i.name)).sort((a, b) => weaponRank(b) - weaponRank(a))[0];
  async function equipWeapon() {
    const w = bestWeapon();
    if (w && (!bot.heldItem || bot.heldItem.name !== w.name)) await bot.equip(w, "hand");
    return w;
  }
  const cooldown = (w) => (!w ? 500 : /sword/.test(w.name) ? 640 : /axe/.test(w.name) ? 1100 : 700);
  async function equipArmor() {
    for (const [dest, suffix] of ARMOR) {
      try {
        const slot = bot.getEquipmentDestSlot(dest);
        const cur = bot.inventory.slots[slot];
        const rank = (i) => ARMOR_RANK[i.name.replace(suffix, "")] != null ? ARMOR_RANK[i.name.replace(suffix, "")] : -1;
        const best = items().filter((i) => i.name.endsWith(suffix) && i.slot !== slot).sort((a, b) => rank(b) - rank(a))[0];
        if (best && (!cur || rank(best) > rank(cur))) await bot.equip(best, dest);
      } catch (e) {}
    }
    try {
      const sh = items().find((i) => i.name === "shield" && i.slot !== 45);
      if (sh && !bot.inventory.slots[45]) await bot.equip(sh, "off-hand");
    } catch (e) {}
  }
  function hasTool(kind, minRank) {
    return items().some((i) => i.name.endsWith("_" + kind) && (TIER[i.name.split("_")[0]] || 0) >= minRank);
  }

  // ---------- menaruh blok ----------
  const DIRS = [[0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0]];
  async function placeAt(pos, itemName) {
    let cur = bot.blockAt(pos);
    if (cur && solid(cur)) return true;
    const it = items().find((i) => i.name === itemName);
    if (!it) throw new Error("tidak punya " + itemName);
    const me = bot.entity.position.floored();
    if ((me.x === pos.x && me.z === pos.z && (me.y === pos.y || me.y + 1 === pos.y))) await stepAway(pos);
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const d of DIRS) {
        const ref = bot.blockAt(pos.offset(d[0], d[1], d[2]));
        if (!ref || !solid(ref)) continue;
        try {
          await bot.equip(it, "hand");
          const face = v(-d[0], -d[1], -d[2]);
          await bot.lookAt(ref.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5), true);
          await bot.placeBlock(ref, face);
          await wait(120);
          cur = bot.blockAt(pos);
          if (cur && !isAir(cur)) return true;
        } catch (e) { /* coba sisi lain */ }
      }
      await wait(200);
    }
    return false;
  }
  async function stepAway(pos) {
    const me = bot.entity.position;
    let dx = me.x - (pos.x + 0.5), dz = me.z - (pos.z + 0.5);
    const len = Math.hypot(dx, dz) || 1;
    if (len < 0.01) { dx = 1; dz = 0; }
    await goto(new GoalNear(Math.floor(me.x + (dx / len) * 2.5), Math.floor(me.y), Math.floor(me.z + (dz / len) * 2.5), 1), 8000).catch(() => {});
  }
  async function placeNearby(itemName) {
    const p = bot.entity.position.floored();
    const offs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [-2, 0], [0, 2], [0, -2]];
    for (const [dx, dz] of offs) {
      const cell = p.offset(dx, 0, dz);
      if (!isAir(bot.blockAt(cell)) || !solid(bot.blockAt(cell.offset(0, -1, 0))) || !isAir(bot.blockAt(cell.offset(0, 1, 0)))) continue;
      if (await placeAt(cell, itemName)) return bot.blockAt(cell);
    }
    throw new Error("tidak ada tempat untuk menaruh " + itemName);
  }

  // naik dengan menumpuk blok di bawah kaki (pillar)
  async function pillarUp(n) {
    const stock = () => items().filter((i) => BUILD_BLOCK.test(i.name)).sort((a, b) => b.count - a.count)[0];
    for (let i = 0; i < n; i++) {
      const it = stock();
      if (!it) throw new Error("tidak ada blok untuk pillar");
      const base = bot.entity.position.floored();
      const ref = bot.blockAt(base.offset(0, -1, 0));
      if (!solid(ref)) throw new Error("tidak ada pijakan");
      await bot.equip(it, "hand");
      await bot.lookAt(base.offset(0.5, -0.5, 0.5), true);
      bot.setControlState("jump", true);
      let w = 0;
      while (bot.entity.position.y < base.y + 1.05 && w++ < 25) await wait(40);
      try { await bot.placeBlock(ref, v(0, 1, 0)); } catch (e) {}
      bot.setControlState("jump", false);
      await wait(200);
    }
  }

  // ---------- menggali ----------
  const lavaAround = (p) => {
    for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0], [0, -2, 0]]) {
      const b = bot.blockAt(p.offset(dx, dy, dz));
      if (b && HURT.test(b.name)) return true;
    }
    return false;
  };
  function safeToMine(b) {
    if (!b || !solid(b) || b.diggable === false || human.PROTECTED.test(b.name)) return false;
    for (const [dx, dy, dz] of DIRS) {
      const n = bot.blockAt(b.position.offset(dx, dy, dz));
      if (n && (liquid(n) || HURT.test(n.name))) return false;
    }
    return true;
  }
  async function digSafe(b) {
    try { const tool = bot.pathfinder.bestHarvestTool(b); if (tool) await bot.equip(tool, "hand"); } catch (e) {}
    try { await bot.lookAt(b.position.offset(0.5, 0.5, 0.5), true); } catch (e) {}
    let to;
    try {
      await Promise.race([bot.dig(b, true), new Promise((_, rej) => { to = setTimeout(() => { try { bot.stopDigging(); } catch (e) {} rej(new Error("timeout menggali")); }, 15000); })]);
    } finally { clearTimeout(to); }
  }
  async function ensureToolFor(b) {
    if (!b.harvestTools) return;
    const ids = Object.keys(b.harvestTools).map(Number);
    if (items().some((i) => ids.includes(i.type))) return;
    const names = ids.map(nameOf).filter((n) => !/golden/.test(n)).sort((a, c) => (TIER[a.split("_")[0]] || 0) - (TIER[c.split("_")[0]] || 0));
    if (names[0]) await obtain(names[0], 1, 2);
  }
  async function pickupItems(center, radius) {
    for (let k = 0; k < 8; k++) {
      await checkpoint();
      const it = Object.values(bot.entities).filter((e) => isItem(e) && e.position && e.position.distanceTo(center) < (radius || 8) && !st.badItems.has(e.id)).sort((a, b) => dist(a) - dist(b))[0];
      if (!it) break;
      try { await gotoNear(it.position, 0.8, 12000); await wait(150); }
      catch (e) { if (e.abort) throw e; st.badItems.add(it.id); }
    }
    if (st.badItems.size > 200) st.badItems.clear();
  }

  // tangga turun / terowongan mendatar yang aman (tidak membuka lava/air)
  async function staircase(dir, steps, down) {
    const [dx, dz] = dir;
    for (let i = 0; i < steps; i++) {
      await checkpoint();
      const p = bot.entity.position.floored();
      const cells = down ? [p.offset(dx, 0, dz), p.offset(dx, 1, dz), p.offset(dx, -1, dz)] : [p.offset(dx, 0, dz), p.offset(dx, 1, dz)];
      for (const c of cells) {
        const b = bot.blockAt(c);
        if (!b) throw new Error("chunk belum dimuat");
        if (liquid(b) || HURT.test(b.name)) throw new Error("bahaya di depan: " + b.name);
        if (solid(b)) { if (!safeToMine(b)) throw new Error("blok tidak aman digali: " + b.name); await digSafe(b); }
      }
      const dest = down ? p.offset(dx, -1, dz) : p.offset(dx, 0, dz);
      if (lavaAround(dest)) throw new Error("lava dekat tujuan");
      const floor = bot.blockAt(dest.offset(0, -1, 0));
      if (!solid(floor)) {
        if (!floor || liquid(floor) || HURT.test(floor.name)) throw new Error("lubang/lava di bawah");
        // lubang kecil: tutup dengan blok kalau ada
        const mat = items().find((x) => BUILD_BLOCK.test(x.name));
        if (mat) await placeAt(dest.offset(0, -1, 0), mat.name);
      }
      await goto(new GoalBlock(dest.x, dest.y, dest.z), 10000);
    }
  }

  // ---------- sumber bahan ----------
  const dropIds = (b) => (b.drops || []).map((d) => (typeof d === "object" ? (d.drop && d.drop.id != null ? d.drop.id : d.drop) : d));
  function sourcesFor(name) {
    if (name === "log") return { blocks: mcData.blocksArray.filter((b) => /_log$/.test(b.name) && !/^stripped_/.test(b.name)).map((b) => b.id), mobs: [] };
    if (MOB_DROPS[name]) return { blocks: [], mobs: MOB_DROPS[name] };
    const item = mcData.itemsByName[name];
    if (!item) return null;
    const blocks = mcData.blocksArray.filter((b) => dropIds(b).includes(item.id) && !/^(stripped_|potted_|infested_|spawner|budding)/.test(b.name));
    return blocks.length ? { blocks: blocks.map((b) => b.id), mobs: [] } : null;
  }

  async function mineOne(b, bad) {
    const key = b.position.toString();
    try {
      await ensureToolFor(b);
      await gotoNear(b.position, 3);
      b = bot.blockAt(b.position);
      if (!b || isAir(b)) return true;
      await digSafe(b);
      await wait(250);
      await pickupItems(b.position.offset(0.5, 0.5, 0.5), 6);
      return true;
    } catch (e) { if (e.abort) throw e; bad.add(key); return false; }
  }

  async function explore(name, k) {
    const y = Math.floor(bot.entity.position.y);
    const oreY = ORE_Y[name];
    if (oreY != null || k > 5) {
      const targetY = oreY != null ? oreY : 40;
      if (!st.heading) st.heading = [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(Math.random() * 4)];
      try {
        if (y > targetY + 1) await staircase(st.heading, Math.min(8, y - targetY), true);
        else await staircase(st.heading, 10, false);
      } catch (e) { if (e.abort) throw e; st.heading = null; log("[Auto] Gali: " + e.message); await wait(500); }
      return;
    }
    const a = rnd(0, Math.PI * 2), r = rnd(25, 45), p = bot.entity.position;
    try { await goto(new GoalXZ(Math.floor(p.x + Math.cos(a) * r), Math.floor(p.z + Math.sin(a) * r)), 30000); }
    catch (e) { if (e.abort) throw e; }
  }

  async function hunt(pred, n) {
    let killed = 0, tries = 0;
    while (killed < n && tries < 14) {
      await checkpoint(); tries++;
      const e = nearestEntity(pred, 64);
      if (!e) { await explore("", 0); continue; }
      st.forced = e;
      const t0 = Date.now();
      while (bot.entities[e.id] && st.forced === e && Date.now() - t0 < 45000) { await checkpoint(); await wait(300); }
      const gone = !bot.entities[e.id];
      const at = e.position.clone();
      st.forced = null;
      if (gone) { killed++; await wait(900); await pickupItems(at, 8); }
    }
    return killed;
  }

  async function collect(name, n) {
    const src = sourcesFor(name);
    if (!src) throw new Error("tidak tahu sumber " + name);
    const bad = new Set();
    let fails = 0, explored = 0;
    while (count(name) < n) {
      await checkpoint();
      if (fails > 8 || explored > 30) throw new Error("gagal mengumpulkan " + name);
      if (!src.blocks.length) {
        const got = await hunt((e) => src.mobs.includes(e.name), 1);
        if (!got) fails++;
        continue;
      }
      const pts = bot.findBlocks({ matching: src.blocks, maxDistance: 48, count: 24 });
      let target = null;
      for (const p of pts) {
        if (bad.has(p.toString())) continue;
        const b = bot.blockAt(p);
        if (b && safeToMine(b)) { target = b; break; }
      }
      if (!target) { explored++; await explore(name, explored); continue; }
      if (await mineOne(target, bad)) fails = 0; else fails++;
    }
    return true;
  }

  // ---------- crafting bertingkat ----------
  async function obtainPlanks(n) {
    const total = () => count("planks");
    while (total() < n) {
      await checkpoint();
      const need = Math.ceil((n - total()) / 4);
      const logs = items().filter((i) => /_log$/.test(i.name)).sort((a, b) => b.count - a.count);
      if (!logs.length) { await collect("log", need); continue; }
      const log0 = logs[0], pn = log0.name.replace("_log", "_planks");
      const it = mcData.itemsByName[pn];
      const r = it && bot.recipesFor(it.id, null, 1, null)[0];
      if (!r) throw new Error("resep tidak ada: " + pn);
      await bot.craft(r, Math.min(need, log0.count), undefined);
    }
    return true;
  }
  async function ensureTable() {
    let t = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 48 });
    if (!t) {
      if (!count("crafting_table")) await obtain("crafting_table", 1, 3);
      t = await placeNearby("crafting_table");
    }
    await gotoNear(t.position, 2.5);
    return t;
  }
  function bestRecipe(item, need) {
    const recs = bot.recipesAll(item.id, null, true);
    let best = null;
    for (const r of recs) {
      const out = r.delta.find((d) => d.id === item.id && d.count > 0);
      if (!out) continue;
      const times = Math.ceil(need / out.count);
      const ing = r.delta.filter((d) => d.count < 0).map((d) => ({ name: nameOf(d.id), need: -d.count * times }));
      let score = 0;
      for (const g of ing) score += Math.max(0, g.need - count(g.name)) * (/_block$|_nugget$/.test(g.name) ? 100 : 1);
      if (!best || score < best.score) best = { r, times, ing, score };
    }
    return best;
  }

  async function obtain(name, n, depth) {
    depth = depth || 0;
    await checkpoint();
    name = alias(name);
    if (depth > 7) throw new Error("rantai bahan terlalu dalam: " + name);
    if (name === "planks") return obtainPlanks(n);
    if (name === "log") return collect("log", n);
    if (name === "food") { if (foodList().length < n) await getFood(); return true; }
    if (count(name) >= n) return true;
    const item = mcData.itemsByName[name];
    if (!item) throw new Error("item tidak dikenal: " + name);
    if (SMELT[name]) return smelt(name, n - count(name), depth);
    if ((NATURAL.test(name) || MOB_DROPS[name]) && sourcesFor(name)) return collect(name, n);
    let plan = bestRecipe(item, n - count(name));
    if (plan) {
      if (plan.r.requiresTable) await ensureTable(); // pasang meja dulu supaya papan tidak terpakai belakangan
      const pl = plan.ing.filter((g) => /_planks$/.test(g.name));
      const stick = plan.ing.find((g) => g.name === "stick");
      const planksNeeded = pl.reduce((s2, g) => s2 + g.need, 0) + (stick ? 2 * Math.ceil(stick.need / 4) : 0);
      if (planksNeeded && count("planks") < planksNeeded) {
        await obtainPlanks(planksNeeded);
        plan = bestRecipe(item, n - count(name)); // pilih varian papan yang sesuai stok
      }
      const ordered = plan.ing.slice().sort((a, b) => (/_planks$/.test(a.name) ? 1 : 0) - (/_planks$/.test(b.name) ? 1 : 0));
      for (let pass = 0; pass < 2; pass++) for (const g of ordered) await obtain(g.name, g.need, depth + 1);
      const table = plan.r.requiresTable ? await ensureTable() : null;
      await bot.craft(plan.r, plan.times, table || undefined);
      if (count(name) < n) throw new Error("crafting gagal: " + name);
      log(`[Auto] Crafting ${name} (punya ${count(name)})`);
      return true;
    }
    if (sourcesFor(name)) return collect(name, n);
    throw new Error("tidak tahu cara mendapat " + name);
  }

  async function smelt(out, n, depth) {
    const input = SMELT[out];
    await obtain(input, Math.max(1, n), (depth || 0) + 1);
    const inputCount = Math.min(count(input), Math.max(1, n));
    // bahan bakar: batu bara/arang dulu, lalu papan/kayu
    const fuelItem = items().find((i) => /^(coal|charcoal)$/.test(i.name)) || items().find((i) => /_planks$/.test(i.name) && i.count >= 2) || items().find((i) => /_log$/.test(i.name));
    if (!fuelItem) { await collect("log", 2); }
    const fuel = fuelItem || items().find((i) => /_log$/.test(i.name));
    let fb = bot.findBlock({ matching: mcData.blocksByName.furnace.id, maxDistance: 24 });
    if (!fb) {
      if (!count("furnace")) await obtain("furnace", 1, (depth || 0) + 1);
      fb = await placeNearby("furnace");
    }
    await gotoNear(fb.position, 2.5);
    const f = await bot.openFurnace(fb);
    try {
      const fuelCount = /coal|charcoal/.test(fuel.name) ? Math.min(fuel.count, Math.ceil(inputCount / 8) + 1) : Math.min(fuel.count, Math.ceil(inputCount / 1.5) + 1);
      await f.putFuel(fuel.type, null, fuelCount);
      await f.putInput(mcData.itemsByName[input].id, null, inputCount);
      const t0 = Date.now();
      let got = 0;
      while (got < inputCount && Date.now() - t0 < inputCount * 11000 + 12000) {
        await checkpoint();
        await wait(1000);
        if (f.outputItem()) { const o = await f.takeOutput(); got += o ? o.count : 0; }
      }
    } finally { try { f.close(); } catch (e) {} }
    if (count(out) < 1) throw new Error("hasil lebur tidak ada: " + out);
    return true;
  }

  async function getFood() {
    if (foodList().length >= 3) return;
    await hunt((e) => ANIMALS.includes(e.name), 3);
    // masak kalau mudah (sudah punya bahan tungku)
    try {
      for (const [out, raw] of [["cooked_beef", "beef"], ["cooked_porkchop", "porkchop"], ["cooked_mutton", "mutton"], ["cooked_chicken", "chicken"]]) {
        const k = count(raw);
        if (k > 0 && (count("cobblestone") >= 8 || bot.findBlock({ matching: mcData.blocksByName.furnace.id, maxDistance: 24 }))) await smelt(out, k, 2);
      }
    } catch (e) { if (e.abort) throw e; }
  }

  // ---------- membangun rumah ----------
  const buildStock = () => items().filter((i) => BUILD_BLOCK.test(i.name)).sort((a, b) => b.count - a.count);
  const buildTotal = () => buildStock().reduce((s, i) => s + i.count, 0);

  function layout(x0, y0, z0, S, H) {
    const cells = [];
    const dx = x0 + Math.floor(S / 2), dz = z0 + S - 1;
    for (let h = 0; h < H; h++) {
      for (let x = x0; x < x0 + S; x++) for (let z = z0; z < z0 + S; z++) {
        if (x !== x0 && x !== x0 + S - 1 && z !== z0 && z !== z0 + S - 1) continue;
        if (x === dx && z === dz && h < 2) continue; // pintu 1x2
        cells.push(v(x, y0 + h, z));
      }
    }
    for (let r = 0; r <= Math.floor(S / 2); r++) {
      const a = x0 + r, b2 = x0 + S - 1 - r, c = z0 + r, d = z0 + S - 1 - r;
      for (let x = a; x <= b2; x++) for (let z = c; z <= d; z++) if (x === a || x === b2 || z === c || z === d) cells.push(v(x, y0 + H, z));
    }
    return { cells, door: v(dx, y0, dz), inside: v(x0 + Math.floor(S / 2), y0, z0 + Math.floor(S / 2)) };
  }
  function siteOk(x0, y0, z0, S, H) {
    for (let x = x0; x < x0 + S; x++) for (let z = z0; z < z0 + S; z++) {
      const g = bot.blockAt(v(x, y0 - 1, z));
      if (!solid(g) || /leaves|ice|_log$|lava|cactus/.test(g.name)) return false;
      for (let h = 0; h <= H; h++) { const b = bot.blockAt(v(x, y0 + h, z)); if (!b || (!isAir(b) && !REPLACEABLE.test(b.name))) return false; }
    }
    return true;
  }
  function findSite(S, H) {
    const bp = bot.entity.position.floored(), R = 14;
    for (let r = 0; r <= R; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      for (const dy of [0, 1, -1]) if (siteOk(bp.x + dx, bp.y + dy, bp.z + dz, S, H)) return { x0: bp.x + dx, y0: bp.y + dy, z0: bp.z + dz };
    }
    return null;
  }

  async function ensureBuildBlocks(need) {
    if (buildTotal() >= need) return;
    const mat = (CB.material || "auto").toLowerCase();
    const short = need - buildTotal();
    if (mat === "planks") return void (await obtainPlanks(count("planks") + short));
    if (mat === "auto" || mat === "cobblestone") {
      if (!hasTool("pickaxe", 0)) await obtain("wooden_pickaxe", 1);
      return void (await obtain("cobblestone", count("cobblestone") + short));
    }
    await obtain(mat, count(mat) + short);
  }

  async function buildHouse(size) {
    const S = Math.max(4, Math.min(9, size || CB.size || 5)), H = 3;
    const need = (4 * S - 4) * H - 2 + S * S;
    await ensureBuildBlocks(need);
    let site = null;
    for (let t = 0; t < 4 && !site; t++) {
      site = findSite(S, H);
      if (!site) { log("[Auto] Mencari lahan rata untuk rumah..."); await explore("", 0); }
    }
    if (!site) throw new Error("tidak ada lahan yang cocok");
    const L = layout(site.x0, site.y0, site.z0, S, H);
    log(`[Auto] Membangun rumah ${S}x${S} di ${site.x0},${site.y0},${site.z0} (${L.cells.length} blok)`);
    await gotoNear(L.inside, 2);
    let fails = 0;
    for (const c of L.cells) {
      await checkpoint();
      if (solid(bot.blockAt(c))) continue;
      const stock = buildStock()[0];
      if (!stock) { await ensureBuildBlocks(L.cells.length); continue; }
      const eye = bot.entity.position.offset(0, 1.6, 0);
      if (eye.distanceTo(c.offset(0.5, 0.5, 0.5)) > 4.2) await gotoNear(c, 3);
      const b = bot.blockAt(c);
      if (b && !isAir(b) && REPLACEABLE.test(b.name)) { try { await digSafe(b); } catch (e) {} }
      let ok = false;
      try { ok = await placeAt(c, stock.name); } catch (e) { if (e.abort) throw e; }
      if (!ok) { fails++; if (fails > 10) throw new Error("terlalu banyak blok gagal ditaruh"); }
    }
    // pintu kayu kalau bisa dibuat; kalau tidak, dibiarkan terbuka
    try {
      if (CB.door !== false) {
        let door = items().find((i) => /_door$/.test(i.name) && !/iron/.test(i.name));
        if (!door) {
          const wood = (items().find((i) => /_planks$/.test(i.name)) || {}).name;
          await obtain((wood ? wood.replace("_planks", "") : "oak") + "_door", 1, 3);
          door = items().find((i) => /_door$/.test(i.name));
        }
        if (door) {
          await gotoNear(L.door, 2);
          await bot.equip(door, "hand");
          await bot.placeBlock(bot.blockAt(L.door.offset(0, -1, 0)), v(0, 1, 0));
        }
      }
    } catch (e) { if (e.abort) throw e; }
    try { const bed = items().find((i) => /_bed$/.test(i.name)); if (bed) await placeAt(L.inside.offset(1, 0, 0), bed.name); } catch (e) {}
    st.house = { inside: L.inside, door: L.door };
    botState.home = L.inside.clone();
    log("[Auto] Rumah selesai");
  }

  // tempat berlindung darurat kalau malam tapi belum punya rumah: kurung diri dengan blok
  async function miniShelter() {
    if (buildTotal() < 10) throw new Error("blok kurang untuk shelter");
    const p = bot.entity.position.floored();
    const order = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) order.push(p.offset(dx, 0, dz));
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) order.push(p.offset(dx, 1, dz));
    order.push(p.offset(1, 2, 0), p.offset(0, 2, 0));
    for (const c of order) { await checkpoint(); const s = buildStock()[0]; if (s) await placeAt(c, s.name); }
    log("[Auto] Berlindung di shelter kecil sampai pagi");
  }

  async function shelterNight() {
    if (st.house) {
      await gotoNear(st.house.inside, 1.5);
      const bed = bot.findBlock({ matching: (b) => /_bed$/.test(b.name), maxDistance: 24 });
      if (bed && night()) { try { await gotoNear(bed.position, 2); await bot.sleep(bed); } catch (e) { if (e.abort) throw e; } }
    }
    let w = 0;
    while (dusk() && w++ < 400) { await checkpoint(); await wait(3000); }
  }

  // ---------- refleks: bahaya, air, makan, pertarungan ----------
  const enemyNames = () => { const now = Date.now(); for (const [k, t] of st.enemies) if (t < now) st.enemies.delete(k); return st.enemies; };
  bot.on("entityHurt", (e) => {
    try {
      if (e !== bot.entity || CC.players === "never") return;
      if (nearestEntity((x) => HOSTILE.has(x.name) && dist(x) < 4, 6)) return;
      const p = nearestEntity((x) => x.type === "player" && x.username && !owners.includes(String(x.username).toLowerCase()), 5);
      if (p) { enemyNames().set(p.username, Date.now() + 30000); log(`[Auto] Diserang ${p.username}, membalas`); }
    } catch (err) {}
  });
  bot.on("death", () => { st.queue = []; st.abort = !!st.running; st.forced = null; st.alert = null; st.enemies.clear(); });

  function pickTarget() {
    const now = Date.now();
    for (const [id, t] of st.ignore) if (t < now) st.ignore.delete(id);
    if (st.forced && bot.entities[st.forced.id] && !st.ignore.has(st.forced.id)) return st.forced;
    if (CC.mobs === false) return null;
    const day = !night();
    const en = enemyNames();
    return nearestEntity((e) => {
      if (st.ignore.has(e.id)) return false;
      if (e.type === "player") {
        if (!e.username || owners.includes(e.username.toLowerCase())) return false;
        return en.has(e.username) || (CC.players === "all" && dist(e) < 16);
      }
      if (FLEE.has(e.name)) return dist(e) < 20;
      if (!HOSTILE.has(e.name)) return false;
      if (day && /spider/.test(e.name) && dist(e) > 4) return false;
      return dist(e) < 14;
    }, 24);
  }

  function escapeDir(from) {
    const me = bot.entity.position;
    let dx = me.x - from.x, dz = me.z - from.z;
    const len = Math.hypot(dx, dz) || 1;
    return new GoalXZ(Math.floor(me.x + (dx / len) * 22), Math.floor(me.z + (dz / len) * 22));
  }

  async function fight(t) {
    const now = Date.now();
    st.alert = "combat"; st.lastCombat = now;
    if (!st.engage || st.engage.id !== t.id) st.engage = { id: t.id, since: now };
    const d = dist(t);
    // kabur: monster berbahaya, atau nyawa tipis
    const lowHp = bot.health != null && bot.health <= (CC["flee-health"] || 6);
    if (FLEE.has(t.name) || (lowHp && d < 10 && !st.forced) || now < st.backoffUntil) {
      if (lowHp) {
        const gap = items().find((i) => /golden_apple/.test(i.name));
        if (gap && d > 4 && !st.eating) eat(gap);
        else if (!st.eating && d > 6 && foodList()[0]) eat(foodList()[0]);
        else if (buildTotal() >= 4 && now - st.lastPillar > 30000 && d < 5) { st.lastPillar = now; try { await pillarUp(3); } catch (e) {} }
      }
      if (!st.fleeSince) st.fleeSince = now;
      if (now - st.fleeSince < 15000 || FLEE.has(t.name)) {
        if (st.followId !== "flee" || now - (st.fleeGoalAt || 0) > 2000) { bot.pathfinder.setMovements(move); bot.pathfinder.setGoal(escapeDir(t.position)); st.followId = "flee"; st.fleeGoalAt = now; }
        try { bot.setControlState("sprint", true); } catch (e) {}
        return;
      }
    } else if (!lowHp) st.fleeSince = 0;
    // macet: tidak bisa memukul target > 18 detik -> abaikan sebentar
    if (now - st.engage.since > 18000 && now - st.lastHit > 12000) {
      st.ignore.set(t.id, now + 60000); if (st.forced && st.forced.id === t.id) st.forced = null; st.engage = null; st.followId = null; try { bot.pathfinder.setGoal(null); } catch (e) {}
      return;
    }
    if (st.followId !== t.id) { bot.pathfinder.setMovements(move); bot.pathfinder.setGoal(new GoalFollow(t, 1.5), true); st.followId = t.id; }
    try { bot.setControlState("sprint", d > 4); } catch (e) {}
    if (d < 3.2) {
      const w = await equipWeapon();
      if (now - st.lastHit >= cooldown(w)) {
        st.lastHit = now;
        try { await bot.lookAt(t.position.offset(0, (t.height || 1.6) * 0.85, 0), true); bot.attack(t); } catch (e) {}
        if (t.name === "creeper") st.backoffUntil = Date.now() + 900; // pukul lalu mundur
        else if (Math.random() < 0.25) { const k = Math.random() < 0.5 ? "left" : "right"; try { bot.setControlState(k, true); setTimeout(() => { try { bot.setControlState(k, false); } catch (e) {} }, 250); } catch (e) {} }
      }
    }
  }

  let reflexBusy = false;
  async function reflex() {
    if (reflexBusy || !alive() || bot.isSleeping) return;
    reflexBusy = true;
    try {
      botState.autoBusy = !!(st.task || st.alert);
      const pos = bot.entity.position;
      const feet = bot.blockAt(pos.floored()), head = bot.blockAt(pos.offset(0, 1.6, 0).floored());
      // 1. lava / api
      if (feet && /lava|^fire$|soul_fire/.test(feet.name)) {
        st.alert = "hazard";
        const bucket = items().find((i) => i.name === "water_bucket");
        if (bucket && /lava/.test(feet.name) && !st.eating) { try { await bot.equip(bucket, "hand"); await bot.lookAt(pos.offset(0, -0.5, 0), true); bot.activateItem(); } catch (e) {} }
        let best = null, bs = -1e9;
        for (let a = 0; a < 16; a++) {
          const ang = (a / 16) * Math.PI * 2;
          for (const r of [2, 3, 4]) {
            const x = Math.floor(pos.x + Math.cos(ang) * r), z = Math.floor(pos.z + Math.sin(ang) * r);
            for (const dy of [0, 1, -1]) {
              const y = Math.floor(pos.y) + dy, f = bot.blockAt(v(x, y - 1, z)), b = bot.blockAt(v(x, y, z)), h2 = bot.blockAt(v(x, y + 1, z));
              if (!solid(f) || HURT.test(f.name) || !isAir(b) || !isAir(h2)) continue;
              const sc = -(lavaAround(v(x, y, z)) ? 50 : 0) - r;
              if (sc > bs) { bs = sc; best = v(x, y, z); }
            }
          }
        }
        if (best) { bot.pathfinder.setMovements(move); bot.pathfinder.setGoal(new GoalNear(best.x, best.y, best.z, 1)); st.followId = null; }
        try { bot.setControlState("jump", true); bot.setControlState("forward", true); } catch (e) {}
        return;
      } else if (st.alert === "hazard") { st.alert = null; stopMotion(); }

      // 2. air: berenang ke permukaan, cari daratan kalau oksigen menipis
      const inWater = feet && feet.name === "water", headWater = head && head.name === "water";
      if (inWater) {
        const lowO2 = bot.oxygenLevel != null && bot.oxygenLevel < 14;
        if (headWater || lowO2) { try { bot.setControlState("jump", true); } catch (e) {} st.swim = true; }
        else if (st.swim) { try { bot.setControlState("jump", false); } catch (e) {} st.swim = false; }
        if (bot.oxygenLevel != null && bot.oxygenLevel < 8 && !st.shoring) {
          st.shoring = true; setTimeout(() => (st.shoring = false), 4000);
          const shore = bot.findBlock({ matching: (b) => solid(b) && !liquid(b) && isAir(bot.blockAt(b.position.offset(0, 1, 0))), maxDistance: 16 });
          if (shore) { bot.pathfinder.setMovements(move); bot.pathfinder.setGoal(new GoalNear(shore.position.x, shore.position.y + 1, shore.position.z, 1)); }
        }
      } else if (st.swim) { try { bot.setControlState("jump", false); } catch (e) {} st.swim = false; }

      // 3. makan
      if (!st.eating && bot.food != null) {
        const gap = bot.health <= 10 ? items().find((i) => /golden_apple/.test(i.name)) : null;
        const f = foodList()[0];
        const threat = nearestEntity((e) => HOSTILE.has(e.name), 6);
        if (gap && !threat) eat(gap);
        else if (f && !threat && (bot.food <= 14 || (bot.food < 20 && bot.health < 18 && bot.food <= 17))) eat(f);
      }

      // 4. pertarungan
      if (botState.patrolActive) return;
      const t = st.eating ? null : pickTarget();
      if (t) { await fight(t); return; }
      if (st.alert === "combat") {
        st.alert = null; st.engage = null; st.fleeSince = 0; stopMotion();
        equipArmor().catch(() => {});
      }
    } catch (e) { /* refleks tidak boleh crash */ }
    finally { reflexBusy = false; }
  }

  // ---------- otak: memilih pekerjaan berikutnya ----------
  const STAGES = [
    ["wooden_pickaxe", () => hasTool("pickaxe", 0)], ["wooden_sword", () => hasTool("sword", 0)],
    ["stone_pickaxe", () => hasTool("pickaxe", 1)], ["stone_sword", () => hasTool("sword", 1)], ["stone_axe", () => hasTool("axe", 1)],
    ["iron_pickaxe", () => hasTool("pickaxe", 2)], ["iron_sword", () => hasTool("sword", 2)],
    ["iron_chestplate", () => items().some((i) => /(iron|diamond|netherite)_chestplate/.test(i.name))],
    ["iron_leggings", () => items().some((i) => /(iron|diamond|netherite)_leggings/.test(i.name))],
    ["iron_helmet", () => items().some((i) => /(iron|diamond|netherite)_helmet/.test(i.name))],
    ["iron_boots", () => items().some((i) => /(iron|diamond|netherite)_boots/.test(i.name))],
  ];
  if ((CP["max-tier"] || "iron") === "diamond") STAGES.push(["diamond_pickaxe", () => hasTool("pickaxe", 3)], ["diamond_sword", () => hasTool("sword", 3)]);
  if ((CP["max-tier"] || "iron") === "stone") STAGES.length = 5;

  const ready = (k) => !(st.backoff[k] > Date.now());
  let brainBusy = false;
  async function brain() {
    if (brainBusy || !alive() || botState.patrolActive || st.running || st.alert || bot.isSleeping) return;
    brainBusy = true;
    try {
      if (st.queue.length) { const q = st.queue.shift(); return void runTask(q.name, q.fn, false); }
      if (!st.auto) return;
      await equipArmor();
      // ambil barang yang jatuh di sekitar (setelah pertarungan)
      if (Date.now() - st.lastCombat > 2500) {
        const it = nearestEntity((e) => isItem(e) && !st.badItems.has(e.id), 10);
        if (it) return void runTask("ambil barang", () => pickupItems(it.position, 10), false);
      }
      if (bot.food <= 12 && !foodList().length && ready("cari makanan")) return void runTask("cari makanan", getFood, false);
      if (CB.auto !== false && dusk()) {
        if (st.house && ready("berlindung")) return void runTask("berlindung", shelterNight, false);
        if (!st.house && ready("rumah") && (buildTotal() >= 40 || hasTool("pickaxe", 0))) return void runTask("rumah", () => buildHouse(), false);
        if (!st.house && ready("shelter") && buildTotal() >= 10) return void runTask("shelter", async () => { await miniShelter(); await shelterNight(); }, false);
      }
      if (CP.enabled !== false) {
        for (const [name, has] of STAGES) {
          if (has() || !ready("buat " + name)) continue;
          return void runTask("buat " + name, async () => { await obtain(name, 1); await equipArmor(); }, false);
        }
      }
      if (CB.auto !== false && !st.house && ready("rumah") && buildTotal() >= 71) return void runTask("rumah", () => buildHouse(), false);
    } catch (e) {} finally { brainBusy = false; }
  }

  // ---------- perintah ----------
  function targetByName(n) {
    n = String(n || "").toLowerCase();
    const pl = Object.values(bot.players).find((p) => p.username.toLowerCase() === n);
    if (pl) return { player: pl.username, entity: pl.entity };
    return { mob: n };
  }
  function exec(text, who) {
    const [c0, ...a] = String(text).trim().replace(/^[!/]/, "").split(/\s+/);
    const c = (c0 || "").toLowerCase();
    switch (c) {
      case "auto": st.auto = a[0] !== "off"; return `mode otomatis ${st.auto ? "AKTIF" : "MATI"}`;
      case "build": case "bangun": runTask("bangun rumah", () => buildHouse(Number(a[0]) || 0), true); return "mulai membangun rumah";
      case "collect": case "ambil": {
        const n = Number(a[1]) || 16, item = alias(a[0] || "");
        if (!item) return "format: collect <item> [jumlah]";
        runTask(`kumpulkan ${item}`, () => obtain(item, n), true); return `mengumpulkan ${item} x${n}`;
      }
      case "craft": case "buat": {
        const n = Number(a[1]) || 1, item = alias(a[0] || "");
        if (!item) return "format: craft <item> [jumlah]";
        runTask(`buat ${item}`, () => obtain(item, n), true); return `membuat ${item} x${n} (bahan dicari otomatis)`;
      }
      case "kill": case "bunuh": {
        if (!a[0]) return "format: kill <pemain|mob>";
        const t = targetByName(a[0]);
        runTask(`bunuh ${a[0]}`, async () => {
          if (t.player) {
            let e = t.entity, w = 0;
            while (w++ < 400) {
              await checkpoint();
              const pl = bot.players[t.player];
              e = pl && pl.entity;
              if (!e) { await wait(1500); continue; }
              st.forced = e;
              await wait(300);
            }
          } else await hunt((e) => e.name === t.mob, 1);
        }, true);
        return `memburu ${a[0]}`;
      }
      case "pillar": runTask("pillar", () => pillarUp(Number(a[0]) || 3), true); return "menumpuk blok ke atas";
      case "cancel": case "batal": case "stop": cancel(); return "tugas dibatalkan";
      case "autostatus": case "status": return status();
      default: return null;
    }
  }
  function cancel() {
    st.queue = []; st.forced = null; st.abort = !!st.running;
    try { stopMotion(); } catch (e) {}
  }
  function status() {
    const p = bot.entity.position;
    const inv = {};
    for (const i of items()) inv[i.name] = (inv[i.name] || 0) + i.count;
    const top = Object.entries(inv).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => `${k}x${n}`).join(", ");
    return `tugas=${st.task || "-"} siaga=${st.alert || "-"} auto=${st.auto ? "on" : "off"} rumah=${st.house ? "ada" : "belum"} HP=${Math.round(bot.health)} lapar=${bot.food} pos=${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)} inv: ${top || "kosong"}`;
  }
  function api() { return { exec, cancel, status, state: st }; }

  // perintah lewat chat in-game, hanya dari pemain di daftar owners
  bot.on("chat", (user, msg) => {
    try {
      if (user === bot.username || !owners.includes(String(user).toLowerCase()) || !/^!/.test(msg)) return;
      let r = exec(msg, user);
      if (r === null && /^!come\b/i.test(msg)) {
        const e = bot.players[user] && bot.players[user].entity;
        if (e) { runTask("datang ke " + user, () => gotoNear(e.position, 2), true); r = "datang"; }
      }
      if (r) bot.chat(String(r).slice(0, 200));
    } catch (e) {}
  });

  addInterval(reflex, 250);
  addInterval(brain, 2000);
  setTimeout(() => { equipArmor().catch(() => {}); }, 3000);
  log("[Auto] Mode manusia penuh aktif (survival, bangun, crafting, combat)");
}

// perintah dari konsol panel: /auto /build /collect /craft /kill /pillar /cancel /autostatus
function command(cmd, targets) {
  const [c0] = cmd.trim().split(/\s+/);
  const mine = ["/auto", "/build", "/bangun", "/collect", "/ambil", "/craft", "/buat", "/kill", "/bunuh", "/pillar", "/cancel", "/batal", "/autostatus"];
  const takeover = ["/stop", "/goto", "/follow", "/come"]; // perintah gerak lama: hentikan tugas otomatis dulu
  const lc = c0.toLowerCase();
  if (!mine.includes(lc) && !takeover.includes(lc)) return null;
  const out = targets.map((b) => {
    const api = b.botState && b.botState.autonomy;
    if (!api || !b.bot || !b.botState.connected) return mine.includes(lc) ? `[${b.name}] mode otomatis belum aktif / belum terhubung` : null;
    if (takeover.includes(lc)) { api.cancel(); return null; }
    try { return `[${b.name}] ${api.exec(cmd)}`; } catch (e) { return `[${b.name}] error: ${e.message}`; }
  }).filter(Boolean);
  return mine.includes(lc) ? out : null;
}

module.exports = { attach, command };
