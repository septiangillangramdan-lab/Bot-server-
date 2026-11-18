"use strict";
// Agen AI: AI memutuskan SATU aksi tiap giliran dari daftar aksi aman, bot menjalankannya,
// hasilnya dicatat. "Belajar" = catatan pelajaran permanen (agent.json) yang dibaca lagi di keputusan berikutnya
// dan diringkas berkala lewat refleksi. Model AI-nya sendiri tidak berubah.
const fs = require("fs");
const path = require("path");
const { goals, Movements } = require("mineflayer-pathfinder");
const { GoalNear, GoalLookAtBlock } = goals;
const human = require("./human");
const builder = require("./builder");

const FILE = path.join(process.env.DATA_DIR || __dirname, "agent.json");
const DEF = { enabled: false, botId: "", objective: "", notes: [], places: {}, history: [], deaths: [], day: "", calls: 0, decisions: 0, thought: "", action: "" };
let mem = { ...DEF };
try { mem = { ...DEF, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch (e) {}
let ctxManager = null;
let dirty = false;
const save = () => { dirty = false; fs.writeFile(FILE, JSON.stringify(mem), () => {}); };
const flushT = setInterval(() => { if (dirty) save(); }, 10000);
if (flushT.unref) flushT.unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAXCALLS = () => Number(process.env.AGENT_MAX_CALLS) || 500;
const INTERVAL = () => Math.max(8000, Number(process.env.AGENT_INTERVAL) || 20000);
const TIER = { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 };
const ARMOR_RANK = { leather: 1, golden: 2, chainmail: 3, iron: 4, diamond: 5, netherite: 6 };
const ARMOR_SLOT = { helmet: ["head", 5], chestplate: ["torso", 6], leggings: ["legs", 7], boots: ["feet", 8] };
const BAD_FOOD = /rotten_flesh|spider_eye|poisonous_potato|pufferfish|chorus_fruit|suspicious_stew|raw_chicken/;
const AIR = /^(air|cave_air|void_air)$/;
const HAZARD = /lava|water|fire|magma|cactus|powder_snow/;
const FALLING = /^(sand|red_sand|gravel)$/;
const FACES = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
const GATHER = {
  wood: { log: true }, stone: { blocks: ["stone", "cobblestone"], item: "cobblestone", need: 0 }, dirt: { blocks: ["dirt", "grass_block"], item: "dirt" },
  sand: { blocks: ["sand"], item: "sand" },
  coal: { blocks: ["coal_ore", "deepslate_coal_ore"], item: "coal", need: 1 },
  iron: { blocks: ["iron_ore", "deepslate_iron_ore"], item: "raw_iron", alt: "iron_ore", need: 2 },
  copper: { blocks: ["copper_ore", "deepslate_copper_ore"], item: "raw_copper", alt: "copper_ore", need: 2 },
  gold: { blocks: ["gold_ore", "deepslate_gold_ore"], item: "raw_gold", alt: "gold_ore", need: 3 },
  diamond: { blocks: ["diamond_ore", "deepslate_diamond_ore"], item: "diamond", need: 3 },
};
const ORES = ["coal", "iron", "copper", "gold", "diamond"];
const SMELT = { raw_iron: "iron_ingot", raw_gold: "gold_ingot", raw_copper: "copper_ingot", iron_ore: "iron_ingot", gold_ore: "gold_ingot", sand: "glass", cobblestone: "stone", raw_beef: "cooked_beef", raw_porkchop: "cooked_porkchop", raw_chicken: "cooked_chicken", raw_mutton: "cooked_mutton", raw_cod: "cooked_cod", raw_salmon: "cooked_salmon", potato: "baked_potato" };
const DIRS = { N: [0, -1], NE: [1, -1], E: [1, 0], SE: [1, 1], S: [0, 1], SW: [-1, 1], W: [-1, 0], NW: [-1, -1] };

// ---------- fungsi murni ----------
function extractJson(text) {
  let t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("jawaban AI bukan JSON");
  return JSON.parse(t.slice(a, b + 1));
}
const clampInt = (v, lo, hi, d) => { v = Math.floor(Number(v)); if (!Number.isFinite(v)) v = d; return Math.max(lo, Math.min(hi, v)); };
const word = (v) => String(v || "").toLowerCase().replace(/[^a-z_]/g, "").slice(0, 40);

// validasi + batasi argumen; aksi di luar daftar ditolak
function normalizeAction(a, registry) {
  if (!a || typeof a.name !== "string") throw new Error("aksi tidak ada");
  const g = a.args && typeof a.args === "object" ? a.args : {}, name = a.name;
  switch (name) {
    case "gather": { const what = word(g.what); if (!GATHER[what]) throw new Error("gather: sumber tidak dikenal: " + what); return { name, args: { what, n: clampInt(g.n, 1, 64, 8) } }; }
    case "craft": { const item = word(g.item); if (!registry.itemsByName[item]) throw new Error("craft: item tidak dikenal: " + item); return { name, args: { item, n: clampInt(g.n, 1, 64, 1) } }; }
    case "smelt": { const item = word(g.item); if (!SMELT[item]) throw new Error("smelt: tidak bisa dibakar: " + item); return { name, args: { item, n: clampInt(g.n, 1, 64, 8) } }; }
    case "build": { const goal = String(g.goal || "").trim().slice(0, 300); if (!goal) throw new Error("build: goal kosong"); return { name, args: { goal } }; }
    case "mine_underground": return { name, args: { target_y: clampInt(g.target_y, -20, 60, 11), length: clampInt(g.length, 6, 40, 16) } };
    case "explore": { const d = String(g.direction || "").toUpperCase(); if (!DIRS[d]) throw new Error("explore: arah harus N,NE,E,SE,S,SW,W,NW"); return { name, args: { direction: d, distance: clampInt(g.distance, 10, 60, 30) } }; }
    case "hunt": { const animal = word(g.animal); if (!/^(cow|pig|sheep|chicken|rabbit)$/.test(animal)) throw new Error("hunt: hewan harus cow,pig,sheep,chicken,rabbit"); return { name, args: { animal } }; }
    case "goto_place": return { name, args: { name: word(g.name) } };
    case "wait": return { name, args: { seconds: clampInt(g.seconds, 5, 120, 20) } };
    case "say": { const text = String(g.text || "").replace(/^\/+/, "").trim().slice(0, 100); if (!text) throw new Error("say: teks kosong"); return { name, args: { text } }; }
    case "eat": case "equip_armor": return { name, args: {} };
    default: throw new Error("aksi tidak dikenal: " + name);
  }
}

const SYSTEM = `You are the decision-making brain of a Minecraft Java 1.20 survival bot. Each turn you get the bot's state, its saved lessons and recent history, and you choose exactly ONE action.
Reply with ONE JSON object only (no prose, no markdown): {"thought":"short reasoning in Indonesian","action":{"name":"...","args":{...}},"lesson":"optional short lesson in Indonesian, or null"}
Actions (args):
- gather {what: wood|stone|dirt|sand|coal|iron|copper|gold|diamond, n:1-64}  mine natural blocks that are visible/exposed nearby. Ores need the right pickaxe (coal: wooden, iron/copper: stone, gold/diamond: iron).
- craft {item, n}  craft any item from inventory materials (it places/uses a crafting table automatically). Fails with a list of missing ingredients.
- smelt {item, n}  smelt in a furnace (raw_iron, raw_gold, raw_copper, sand, cobblestone, raw_beef, raw_porkchop, raw_chicken, raw_mutton, potato...). Needs fuel (coal or wood) and a furnace (craft one from 8 cobblestone).
- build {goal}  design and build a small static structure (house, shelter, tower) with materials gathered automatically; goal is a short description.
- mine_underground {target_y:-20..60, length:6-40}  dig a safe staircase down, tunnel and mine ore veins, then return. Needs a stone pickaxe, food>=10, health>=10. Good depths: coal ~45, iron ~16, diamond ~ -10.
- explore {direction: N|NE|E|SE|S|SW|W|NW, distance:10-60}  walk to find resources; reports what was found.
- hunt {animal: cow|pig|sheep|chicken|rabbit}  kill a passive animal for food.
- eat {}  eat the best food if hungry.
- equip_armor {}  wear the best armor in inventory.
- goto_place {name}  walk to a saved place (home, trees, water, coal, iron, diamond, gold).
- wait {seconds:5-120}  do nothing for a while (e.g. to recover).
- say {text}  chat a short message (rarely).
Typical progression: wood -> craft planks/sticks/crafting_table -> wooden_pickaxe -> stone -> stone pickaxe/sword/axe -> coal -> furnace -> iron -> smelt -> iron pickaxe, sword, armor -> build a house -> diamonds. Eat when food < 14. Build a shelter before night (timeOfDay 13000-23000 is night).
Rules: never attack players; never dig straight down; avoid lava and water; do not repeat an action that just failed the same way, change approach and write a lesson; prefer actions whose requirements are met; if health < 8 eat or wait. Use lessons and place memory. Keep thought short.`;

// ---------- per bot ----------
function attach(bot, mcData, botState, config, log, addInterval) {
  const registry = bot.registry || mcData;
  const Vec3 = bot.entity.position.constructor;
  const A = { on: false, status: "Mati", busy: "", abort: false, loop: false };
  botState.agent = A;
  const sk = () => botState.skills || {};
  const up = () => botState.connected && bot.entity && A.on;
  const items = () => bot.inventory.items();
  const inv = () => { const c = {}; items().forEach((i) => (c[i.name] = (c[i.name] || 0) + i.count)); return c; };
  const count = (n) => inv()[n] || 0;
  const solid = (b) => b && b.boundingBox === "block";
  const bump = () => { dirty = true; };
  const note = (text) => { text = String(text || "").trim().slice(0, 160); if (!text) return; if (!mem.notes.includes(text)) mem.notes.push(text); if (mem.notes.length > 30) mem.notes.shift(); bump(); };
  const hist = (action, result) => { mem.history.push({ t: Date.now(), a: action, r: String(result).slice(0, 220) }); if (mem.history.length > 60) mem.history.shift(); bump(); };
  const say = (m) => { A.status = m; log("[Agen] " + m); };
  const pickTier = (kind) => Math.max(0, ...items().filter((i) => new RegExp(`_${kind}$`).test(i.name)).map((i) => TIER[i.name.split("_")[0]] || 0));
  const ids = (names) => names.map((n) => registry.blocksByName[n] && registry.blocksByName[n].id).filter((x) => x != null);
  const logNames = () => registry.blocksArray.filter((b) => /_log$/.test(b.name)).map((b) => b.name);
  const find = (names, r, c) => { const i = ids(names); return i.length ? bot.findBlocks({ matching: i, maxDistance: r, count: c || 30 }) : []; };

  // ----- pengamatan -----
  function scan() {
    const out = {}, defs = { trees: [logNames(), 32], stone: [["stone"], 24], coal: [GATHER.coal.blocks, 32], iron: [GATHER.iron.blocks, 32], gold: [GATHER.gold.blocks, 32], diamond: [GATHER.diamond.blocks, 32], water: [["water"], 24], lava: [["lava"], 24] };
    for (const [k, [names, r]] of Object.entries(defs)) {
      const list = find(names, r, 40);
      out[k] = list.length;
      if (list.length && ["trees", "coal", "iron", "gold", "diamond", "water", "lava"].includes(k)) { const p = list[0]; mem.places[k] = { x: p.x, y: p.y, z: p.z }; bump(); }
    }
    return out;
  }
  function observe() {
    const p = bot.entity.position.floored(), tod = bot.time && bot.time.timeOfDay != null ? bot.time.timeOfDay : 0;
    const sc = scan();
    const ents = Object.values(bot.entities).filter((e) => e !== bot.entity && e.position && e.position.distanceTo(bot.entity.position) < 24);
    const hostile = ents.filter((e) => e.type === "hostile").map((e) => e.name), animals = ents.filter((e) => e.type === "animal" || e.type === "passive").map((e) => e.name);
    const equip = [5, 6, 7, 8].map((s) => bot.inventory.slots[s] && bot.inventory.slots[s].name).filter(Boolean);
    const tools = items().filter((i) => /_(pickaxe|axe|sword|shovel)$/.test(i.name)).map((i) => i.name);
    const lines = [
      `Objective: ${mem.objective || "Survive and thrive: gather wood, make tools, build a house, mine ores, craft iron gear and armor."}`,
      `Position: ${p.x} ${p.y} ${p.z}. Time of day: ${tod} (${tod >= 13000 && tod < 23000 ? "NIGHT" : "day"}). Health ${Math.round(bot.health || 0)}/20, food ${bot.food == null ? "?" : bot.food}/20. ${bot.isRaining ? "Raining." : ""}`,
      `Inventory: ${Object.entries(inv()).map(([k, v]) => `${k} x${v}`).join(", ") || "(empty)"}`,
      `Tools: ${tools.join(", ") || "none"}. Pickaxe tier ${pickTier("pickaxe")} (1 wood,2 stone,3 iron,4 diamond). Wearing: ${equip.join(", ") || "nothing"}.`,
      `Nearby (counts): ${Object.entries(sc).map(([k, v]) => `${k} ${v}`).join(", ")}. Hostile mobs: ${hostile.join(", ") || "none"}. Animals: ${[...new Set(animals)].join(", ") || "none"}.`,
      `Saved places: ${Object.entries(mem.places).map(([k, v]) => `${k}@${v.x},${v.y},${v.z}`).join("; ") || "none"}.`,
      `Lessons learned:\n${mem.notes.slice(-15).map((n, i) => `${i + 1}. ${n}`).join("\n") || "(none yet)"}`,
      `Recent actions:\n${mem.history.slice(-10).map((h) => `- ${h.a} => ${h.r}`).join("\n") || "(none yet)"}`,
    ];
    return lines.join("\n");
  }

  // ----- keterampilan -----
  async function craftSmart(name, n) {
    const it = registry.itemsByName[name], s = sk();
    let table = null, r = bot.recipesFor(it.id, null, 1, null)[0];
    if (!r) { table = await s.ensureTable(); if (table) r = bot.recipesFor(it.id, null, 1, table)[0]; }
    if (!r) {
      const all = (bot.recipesAll ? bot.recipesAll(it.id, null, table || true) : [])[0];
      const need = all && all.delta ? all.delta.filter((d) => d.count < 0).map((d) => `${(registry.items[d.id] || {}).name || d.id} x${-d.count * n}`) : [];
      return `gagal: bahan kurang atau butuh crafting table${need.length ? " (resep butuh: " + need.join(", ") + ")" : ""}`;
    }
    const before = count(name);
    try { await bot.craft(r, n, table || undefined); } catch (e) { return "gagal craft: " + e.message; }
    return `berhasil: ${name} sekarang ${count(name)} (+${count(name) - before})`;
  }
  async function placeNear(itemName) {
    const feet = bot.entity.position.floored();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ref = bot.blockAt(feet.offset(dx, -1, dz)), above = bot.blockAt(feet.offset(dx, 0, dz));
      if (solid(ref) && above && AIR.test(above.name)) { try { await bot.equip(items().find((i) => i.name === itemName), "hand"); await bot.placeBlock(ref, new Vec3(0, 1, 0)); return true; } catch (e) {} }
    }
    return false;
  }
  async function gatherAct({ what, n }) {
    const g = GATHER[what], s = sk(), deadline = Date.now() + 8 * 60000;
    if (g.log) {
      const p = find(logNames(), 48, 1)[0];
      if (!p) return "gagal: tidak ada pohon dalam 48 blok (coba explore)";
      const nm = bot.blockAt(p).name, ok = await s.mineKind(logNames(), n, nm, deadline);
      return `${ok ? "berhasil" : "sebagian"}: ${nm} sekarang ${count(nm)}`;
    }
    const item = registry.itemsByName[g.item] ? g.item : g.alt;
    if (g.need && pickTier("pickaxe") < g.need) return `gagal: butuh pickaxe tier ${g.need} (1 kayu,2 batu,3 besi) — craft dulu`;
    if (what === "stone" && pickTier("pickaxe") < 1) { if (!(await s.ensureTool("pickaxe"))) return "gagal: tidak bisa membuat pickaxe kayu (butuh kayu)"; }
    const ok = await s.mineKind(g.blocks, n, item, deadline);
    return `${ok ? "berhasil" : "sebagian/gagal (tidak ada yang terlihat dan terjangkau?)"}: ${item} sekarang ${count(item)}`;
  }
  async function smeltAct({ item, n }) {
    const s = sk(), out = SMELT[item], have = count(item);
    if (!have) return `gagal: tidak punya ${item}`;
    n = Math.min(n, have);
    const fuelItem = items().find((i) => i.name === "coal") || items().find((i) => i.name === "charcoal") || items().find((i) => /_planks$/.test(i.name)) || items().find((i) => /_log$/.test(i.name));
    if (!fuelItem) return "gagal: butuh bahan bakar (coal atau kayu)";
    let fb = bot.findBlock({ matching: registry.blocksByName.furnace.id, maxDistance: 32 });
    if (!fb) {
      if (!count("furnace")) { const r = await craftSmart("furnace", 1); if (!count("furnace")) return "gagal: tidak ada furnace dan " + r; }
      if (!(await placeNear("furnace"))) return "gagal: tidak ada tempat untuk menaruh furnace";
      fb = bot.findBlock({ matching: registry.blocksByName.furnace.id, maxDistance: 8 });
    }
    if (!fb) return "gagal: furnace tidak ditemukan";
    await s.go(new GoalNear(fb.position.x, fb.position.y, fb.position.z, 2.5));
    const furnace = await bot.openFurnace(bot.blockAt(fb.position));
    try {
      const perFuel = fuelItem.name === "coal" || fuelItem.name === "charcoal" ? 8 : 1.5;
      await furnace.putFuel(fuelItem.type, null, Math.min(fuelItem.count, Math.ceil(n / perFuel)));
      await furnace.putInput(registry.itemsByName[item].id, null, n);
      const end = Date.now() + n * 11000 + 8000;
      let taken = 0;
      while (taken < n && Date.now() < end && up()) {
        await sleep(2500);
        const o = furnace.outputItem();
        if (o) { await furnace.takeOutput(); taken += o.count; }
      }
      return `${taken >= n ? "berhasil" : "sebagian"}: ${out} sekarang ${count(out)}`;
    } finally { try { furnace.close(); } catch (e) {} }
  }
  async function buildAct({ goal }) {
    const r = botState.buildStart ? botState.buildStart(goal) : "builder tidak aktif";
    if (r !== "dimulai") return "gagal: " + r;
    const t0 = Date.now(), S = botState.build;
    while (S.running && up() && Date.now() - t0 < 30 * 60000) await sleep(2000);
    if (S.running) { botState.buildStop(); await sleep(1500); return "dihentikan"; }
    if (S.origin && /Selesai/.test(S.phase)) { mem.places.home = { x: S.origin.x, y: S.origin.y, z: S.origin.z }; bump(); }
    return `${S.phase}: ${S.msg}${S.error ? " — " + S.error : ""}`;
  }
  async function eatAct() {
    if ((bot.food || 20) >= 20) return "tidak lapar";
    const f = items().filter((i) => registry.foods && registry.foods[i.type] && !BAD_FOOD.test(i.name)).sort((a, b) => registry.foods[b.type].foodPoints - registry.foods[a.type].foodPoints)[0];
    if (!f) return "gagal: tidak punya makanan (coba hunt)";
    try { await bot.equip(f, "hand"); await bot.consume(); } catch (e) { return "gagal makan: " + e.message; }
    return `makan ${f.name}, lapar sekarang ${bot.food}`;
  }
  async function huntAct({ animal }) {
    const s = sk();
    if (!botState.fight) return "gagal: modul tempur tidak aktif";
    const r = botState.fight(animal);
    if (!/^menyerang/.test(r)) return "gagal: " + r + " (coba explore)";
    const t0 = Date.now();
    while (botState.fighting && up() && Date.now() - t0 < 90000) await sleep(1000);
    if (botState.fighting) botState.stopFight();
    await sleep(500); await s.pickup();
    return `selesai berburu ${animal}; daging: ${["beef", "porkchop", "mutton", "chicken", "rabbit"].map((m) => `raw_${m} x${count("raw_" + m)}`).filter((x) => !/x0$/.test(x)).join(", ") || "tidak ada"}`;
  }
  async function armorAct() {
    let did = [];
    for (const [piece, [slot, idx]] of Object.entries(ARMOR_SLOT)) {
      const rank = (n) => (n ? ARMOR_RANK[n.split("_")[0]] || 0 : 0);
      const cur = bot.inventory.slots[idx], best = items().filter((i) => i.name.endsWith("_" + piece)).sort((a, b) => rank(b.name) - rank(a.name))[0];
      if (best && rank(best.name) > rank(cur && cur.name)) { try { await bot.equip(best, slot); did.push(best.name); } catch (e) {} }
    }
    return did.length ? "memakai " + did.join(", ") : "tidak ada armor yang lebih baik";
  }
  async function exploreAct({ direction, distance }) {
    const s = sk(), [dx, dz] = DIRS[direction], len = Math.hypot(dx, dz), p = bot.entity.position;
    const x = Math.floor(p.x + (dx / len) * distance), z = Math.floor(p.z + (dz / len) * distance);
    let y = null;
    for (let yy = Math.floor(p.y) + 20; yy >= Math.floor(p.y) - 25; yy--) { const b = bot.blockAt(new Vec3(x, yy, z)); if (!b) break; if (solid(b) && !HAZARD.test(b.name)) { const u = bot.blockAt(new Vec3(x, yy + 1, z)); if (u && AIR.test(u.name)) { y = yy + 1; break; } } }
    const ok = await s.go(y == null ? new GoalNear(x, p.y, z, 4) : new GoalNear(x, y, z, 2), 2);
    const sc = scan(), q = bot.entity.position.floored();
    return `${ok ? "tiba" : "tidak sampai"} di ${q.x} ${q.y} ${q.z}; terlihat: ${Object.entries(sc).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(", ") || "tidak ada sumber daya"}`;
  }
  async function gotoPlaceAct({ name }) {
    const p = mem.places[name];
    if (!p) return `gagal: tempat "${name}" belum tersimpan (ada: ${Object.keys(mem.places).join(", ") || "tidak ada"})`;
    const ok = await sk().go(new GoalNear(p.x, p.y, p.z, 3), 2);
    return ok ? `tiba di ${name}` : `tidak sampai di ${name}`;
  }

  // tambang tangga aman: turun diagonal, terowongan 1x2, ambil urat bijih yang menempel, lalu kembali
  async function mineUnderground({ target_y, length }) {
    const s = sk(), human_ = human;
    if (pickTier("pickaxe") < 2) return "gagal: butuh stone pickaxe";
    if ((bot.food || 0) < 10) return "gagal: terlalu lapar (makan dulu)";
    if ((bot.health || 0) < 10) return "gagal: darah rendah";
    const entrance = bot.entity.position.floored(), startY = entrance.y;
    if (target_y >= startY - 2) return "sudah cukup dalam, gunakan explore atau gather";
    const oreNames = ORES.flatMap((k) => GATHER[k].blocks), oreIds = ids(oreNames);
    const before = {}; ORES.forEach((k) => { const it = registry.itemsByName[GATHER[k].item] ? GATHER[k].item : GATHER[k].alt; before[k] = count(it); });
    const hazardAt = (v) => { const b = bot.blockAt(v); if (!b) return true; if (HAZARD.test(b.name)) return true; return FACES.some((f) => { const n = bot.blockAt(v.offset(...f)); return n && /lava|water/.test(n.name); }); };
    const dig = async (v) => {
      const b = bot.blockAt(v);
      if (!b || AIR.test(b.name)) return true;
      if (HAZARD.test(b.name) || !human_.breakable(bot, b)) return false;
      try { const tool = bot.pathfinder.bestHarvestTool ? bot.pathfinder.bestHarvestTool(b) : null; if (tool) await bot.equip(tool, "hand"); await bot.lookAt(v.offset(0.5, 0.5, 0.5)); await bot.dig(b, true); return true; } catch (e) { return false; }
    };
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let dir = dirs.find(([dx, dz]) => { const b = bot.blockAt(entrance.offset(dx, 0, dz)); return solid(b) && !HAZARD.test(b.name); }) || dirs[0];
    const [dx, dz] = dir;
    const stop = (why) => `terhenti: ${why}`;
    let pos = entrance, steps = 0, reason = "";
    // turun
    while (up() && pos.y > target_y && steps < 90) {
      await s.stopCheck();
      const A_ = pos.offset(dx, 0, dz), B_ = pos.offset(dx, -1, dz), C_ = pos.offset(dx, -2, dz);
      if (hazardAt(A_) || hazardAt(B_)) { reason = "ada air/lava di dekat jalur"; break; }
      const c = bot.blockAt(C_);
      if (!solid(c) || HAZARD.test(c.name)) { reason = "di bawah jalur ada rongga/cairan (gua)"; break; }
      if (!(await dig(A_)) || !(await dig(B_))) { reason = "blok tidak bisa digali"; break; }
      if (!(await s.go(new GoalNear(B_.x + 0.5, B_.y, B_.z + 0.5, 0.6), 2))) { reason = "tidak bisa melangkah"; break; }
      pos = bot.entity.position.floored(); steps++;
    }
    // terowongan + ambil bijih
    let carved = 0;
    if (!reason) {
      for (let i = 0; i < length && up(); i++) {
        await s.stopCheck();
        const T1 = pos.offset(dx, 0, dz), T2 = pos.offset(dx, 1, dz), top = bot.blockAt(pos.offset(dx, 2, dz));
        if (hazardAt(T1) || hazardAt(T2)) { reason = "ada air/lava di terowongan"; break; }
        if (top && FALLING.test(top.name)) { reason = "ada pasir/kerikil di atas"; break; }
        if (!(await dig(T1)) || !(await dig(T2))) { reason = "blok tidak bisa digali"; break; }
        if (!(await s.go(new GoalNear(T1.x + 0.5, T1.y, T1.z + 0.5, 0.6), 2))) { reason = "tidak bisa melangkah"; break; }
        pos = bot.entity.position.floored(); carved++;
        // urat bijih yang menempel pada ruang terbuka
        const queue = bot.findBlocks({ matching: oreIds, maxDistance: 5, count: 8 }).filter((p) => FACES.some((f) => { const n = bot.blockAt(p.offset(...f)); return n && AIR.test(n.name); }));
        let veins = 0;
        while (queue.length && veins < 24 && up()) {
          const p = queue.shift(); veins++;
          const b = bot.blockAt(p);
          if (!b || !oreNames.includes(b.name) || hazardAt(p)) continue;
          if (await s.go(new GoalLookAtBlock(p, bot.world, { reach: 4 }), 1)) {
            if (await dig(p)) { await sleep(250); await s.pickup(); FACES.forEach((f) => { const q = p.offset(...f), nb = bot.blockAt(q); if (nb && oreNames.includes(nb.name)) queue.push(q); }); }
          }
        }
      }
    }
    // kembali ke pintu masuk
    const back = await s.go(new GoalNear(entrance.x + 0.5, entrance.y, entrance.z + 0.5, 3), 3);
    const got = ORES.map((k) => { const it = registry.itemsByName[GATHER[k].item] ? GATHER[k].item : GATHER[k].alt, d = count(it) - before[k]; return d > 0 ? `${it} +${d}` : null; }).filter(Boolean);
    return `${reason ? stop(reason) + "; " : ""}turun ${steps} langkah, terowongan ${carved} blok, hasil: ${got.join(", ") || "tidak ada bijih"}; ${back ? "sudah kembali ke permukaan" : "GAGAL kembali ke permukaan"}`;
  }

  const ACTIONS = {
    gather: gatherAct, craft: ({ item, n }) => craftSmart(item, n), smelt: smeltAct, build: buildAct, mine_underground: mineUnderground,
    explore: exploreAct, hunt: huntAct, goto_place: gotoPlaceAct, equip_armor: armorAct, eat: eatAct,
    wait: async ({ seconds }) => { const end = Date.now() + seconds * 1000; while (Date.now() < end && up()) await sleep(1000); return "selesai menunggu"; },
    say: async ({ text }) => { if (Date.now() - (A.lastSay || 0) < 10 * 60000) return "terlalu sering chat, dilewati"; A.lastSay = Date.now(); botState.say ? botState.say(text, { dedupe: true }) : bot.chat(text); return "terkirim"; },
  };

  async function execute(act) {
    const B = botState.build || {};
    B.abort = false; botState.task = true; A.busy = act.name;
    try {
      let timer;
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => { B.abort = true; rej(new Error("waktu aksi habis")); }, 12 * 60000); });
      try { return String(await Promise.race([ACTIONS[act.name](act.args), timeout]) || "ok"); } finally { clearTimeout(timer); }
    } catch (e) { return "gagal: " + e.message; }
    finally {
      botState.task = false; A.busy = "";
      try { bot.pathfinder.setGoal(null); } catch (e) {}
      ["forward", "back", "left", "right", "jump", "sprint"].forEach((k) => { try { bot.setControlState(k, false); } catch (e) {} });
    }
  }

  // ----- refleksi: merangkum pelajaran agar catatan tetap ringkas dan benar -----
  async function reflect() {
    const user = `Current lessons:\n${mem.notes.map((n, i) => `${i + 1}. ${n}`).join("\n") || "(none)"}\n\nRecent actions:\n${mem.history.slice(-20).map((h) => `- ${h.a} => ${h.r}`).join("\n")}\n\nRewrite the lessons: merge duplicates, drop wrong or obsolete ones, add new insights from the recent actions. Max 15 short lessons in Indonesian, each a concrete useful rule. Reply JSON only: {"lessons":["..."]}`;
    const j = extractJson(await builder.withRetry(() => builder.ask("You curate a Minecraft bot's memory. Reply with JSON only.", user), null, [5000, 15000]));
    if (Array.isArray(j.lessons) && j.lessons.length) { mem.notes = j.lessons.map((x) => String(x).slice(0, 160)).slice(0, 15); bump(); }
  }

  // ----- loop utama -----
  async function loop() {
    if (A.loop) return;
    A.loop = true;
    say("Agen AI aktif");
    try {
      while (up()) {
        try {
          while ((botState.fighting || botState.task) && up()) await sleep(1500);
          const day = new Date().toISOString().slice(0, 10);
          if (mem.day !== day) { mem.day = day; mem.calls = 0; bump(); }
          if (mem.calls >= MAXCALLS()) { say(`Batas harian ${MAXCALLS()} keputusan tercapai, lanjut besok`); await sleep(60000); continue; }
          say("Berpikir…");
          const raw = await builder.withRetry(() => builder.ask(SYSTEM, observe()), (n, e, d) => { if (!up()) throw new Error("dihentikan"); say(`Server AI sibuk (${e.status || "jaringan"}), coba lagi ${Math.round(d / 1000)} dtk`); }, [4000, 10000, 20000, 40000]);
          mem.calls++; mem.decisions++; bump();
          let dec, act;
          try { dec = extractJson(raw); act = normalizeAction(dec.action, registry); } catch (e) { hist("(keputusan tidak valid)", e.message); say("Keputusan AI tidak valid: " + e.message); await sleep(INTERVAL()); continue; }
          mem.thought = String(dec.thought || "").slice(0, 300); mem.action = `${act.name} ${JSON.stringify(act.args)}`; bump();
          if (dec.lesson) note(dec.lesson);
          say(`Menjalankan: ${mem.action}`);
          const result = await execute(act);
          hist(mem.action, result);
          say(`Hasil: ${result.slice(0, 120)}`);
          if (mem.decisions % 12 === 0) { try { await reflect(); say("Refleksi: catatan pelajaran diperbarui"); } catch (e) { log("[Agen] refleksi gagal: " + e.message); } }
        } catch (e) {
          if (!up()) break;
          say("Kesalahan: " + e.message.slice(0, 120)); log("[Agen] " + e.message);
          await sleep(30000);
        }
        await sleep(INTERVAL());
      }
    } finally { A.loop = false; botState.task = false; if (!A.on) A.status = "Mati"; }
  }

  bot.on("death", () => {
    try {
      mem.deaths.push(Date.now()); mem.deaths = mem.deaths.filter((t) => Date.now() - t < 15 * 60000);
      const last = mem.history[mem.history.length - 1];
      if (A.on) {
        note(`Mati saat/setelah: ${(A.busy || (last && last.a) || "?").slice(0, 70)} — hindari mengulang tanpa persiapan (makan, armor, senjata)`);
        hist("(mati)", "bot mati");
        if (mem.deaths.length >= 3) { A.on = false; mem.enabled = false; bump(); say("Dihentikan: mati 3 kali dalam 15 menit"); }
      }
    } catch (e) {}
  });
  botState.agentStart = () => { if (A.on) return "sudah berjalan"; A.on = true; mem.enabled = true; bump(); setTimeout(() => { if (A.on) loop(); }, 500); return "dimulai"; };
  botState.agentStop = () => { A.on = false; mem.enabled = false; bump(); try { botState.buildStop && botState.buildStop(); botState.stopFight && botState.stopFight(); } catch (e) {} const B = botState.build; if (B) B.abort = true; say("Dihentikan"); return "dihentikan"; };
  bot.once("end", () => { const was = A.on; A.on = false; A.abort = true; if (was) mem.enabled = true; });
  // lanjut otomatis setelah bot masuk ulang
  if (mem.enabled) setTimeout(() => { try { const e = ctxManager && ctxManager.list.find((b) => b.bot === bot); if (e && (!mem.botId || e.id === mem.botId) && !A.on) { A.on = true; loop(); } } catch (er) {} }, 20000);
}

// ---------- API untuk panel ----------
function routes(app, manager, config, addLog) {
  const entry = (id) => manager.list.find((b) => b.id === id && b.botState.connected) || manager.list.find((b) => b.botState.connected);
  ctxManager = manager;
  app.get("/api/agent", (req, res) => {
    const running = manager.list.find((b) => b.botState.agent && b.botState.agent.on);
    const A = running && running.botState.agent;
    const p = manager.list.map((b) => ({ id: b.id, online: !!b.botState.connected }));
    res.json({ success: true, running: !!A, bot: running ? running.id : mem.botId, status: A ? A.status : (mem.enabled ? "Menunggu bot online" : "Mati"), busy: A ? A.busy : "", thought: mem.thought, action: mem.action, calls: mem.calls, limit: MAXCALLS(), decisions: mem.decisions, objective: mem.objective, notes: mem.notes, places: mem.places, history: mem.history.slice(-15).reverse(), bots: p, hasKey: builder._t.hasKey() });
  });
  app.post("/api/agent/start", (req, res) => {
    const b = entry((req.body || {}).bot);
    if (!b || !b.botState.agentStart) return res.json({ success: false, msg: "Tidak ada bot online" });
    if (!builder._t.hasKey()) return res.json({ success: false, msg: "Kunci API AI belum diisi di Railway (Variables)" });
    mem.botId = b.id; mem.objective = String((req.body || {}).objective || "").trim().slice(0, 300); dirty = true;
    manager.list.forEach((x) => { if (x !== b && x.botState.agentStop) x.botState.agentStop(); });
    const r = b.botState.agentStart();
    addLog(`[Agen] Dijalankan pada ${b.id}${mem.objective ? ` (tujuan: ${mem.objective.slice(0, 60)})` : ""}`);
    res.json({ success: true, msg: r, bot: b.id });
  });
  app.post("/api/agent/stop", (req, res) => { manager.list.forEach((b) => b.botState.agentStop && b.botState.agentStop()); mem.enabled = false; dirty = true; res.json({ success: true }); });
  app.post("/api/agent/forget", (req, res) => { mem.notes = []; mem.places = {}; mem.history = []; mem.thought = ""; mem.action = ""; mem.decisions = 0; save(); res.json({ success: true }); });
}

module.exports = { attach, routes, _t: { normalizeAction, extractJson, SYSTEM, mem: () => mem, resetMem: () => { mem = { ...DEF }; }, GATHER, SMELT } };
