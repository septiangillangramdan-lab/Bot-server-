"use strict";
// Printer otomatis (gabungan ide Litematica + Baritone Automated Builder) untuk bot Mineflayer:
//  - memuat blueprint .litematic / .schem lalu membangunnya lapis demi lapis, lengkap dengan arah blok (tangga, pintu, dll)
//  - bila bahan habis: ambil dari peti / barrel / shulker box (indeks isi peti diingat), atau kumpulkan sendiri
//  - "penjaga": membandingkan dunia dengan blueprint atau potret area, lalu menambal lubang (misalnya bekas ledakan creeper)
// Semua perintah lewat botState.cmds["/bp"], ["/supply"], ["/snapshot"], ["/repair"] dan API panel.
const fs = require("fs");
const path = require("path");
const { goals, Movements } = require("mineflayer-pathfinder");
const { GoalNear, GoalLookAtBlock, GoalPlaceBlock } = goals;
const human = require("./human");
const lm = require("./litematic");

const DATA = process.env.DATA_DIR || __dirname;
const BP_DIR = path.join(DATA, "blueprints");
const FILE = path.join(DATA, "printer.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AIR = /^(air|cave_air|void_air)$/;
const REPLACEABLE = /^(water|lava|short_grass|grass|tall_grass|fern|large_fern|seagrass|tall_seagrass|snow|vine|dead_bush|light|fire)$/;
const FACES = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
const DIR_YAW = { north: 0, west: Math.PI / 2, south: Math.PI, east: -Math.PI / 2 };
const OPP = { north: "south", south: "north", east: "west", west: "east" };
const DIR_VEC = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] };
// facing = arah pemain menghadap
const FACE_SAME = /_stairs$|_door$|_bed$|_fence_gate$|^bell$/;
// facing = menghadap ke pemain (berlawanan arah pemain menghadap)
const FACE_OPP = /^(chest|trapped_chest|ender_chest|furnace|blast_furnace|smoker|loom|stonecutter|grindstone|lectern|repeater|comparator|carved_pumpkin|jack_o_lantern|[a-z_]+_glazed_terracotta|[a-z_]+_trapdoor)$/;
// menempel ke dinding: facing = sisi yang menjauh dari dinding
const WALLMOUNT = /(^|_)wall_(torch|sign|banner|head|skull|hanging_sign)$|^ladder$|_button$|^lever$|^tripwire_hook$|^redstone_wall_torch$|^soul_wall_torch$/;
const ATTACHED = /torch|sign|banner|button|lever|ladder|vine|carpet|pressure_plate|rail|lantern|head|skull|^repeater|^comparator|redstone|door|bed|flower_pot|^(poppy|dandelion|[a-z_]+_tulip)$/;
const SCAFFOLD_PREF = ["cobblestone", "dirt", "netherrack", "cobbled_deepslate", "andesite", "diorite", "granite", "stone", "oak_planks", "spruce_planks", "birch_planks"];
// pengganti saat membetulkan medan (potret area): item yang tidak bisa didapat -> pilihan yang bisa
const TERRAIN_SUB = [
  [/^grass_block$|^podzol$|^mycelium$|^dirt_path$|^farmland$|^rooted_dirt$|^coarse_dirt$/, ["dirt"]],
  [/^(stone|deepslate|tuff|calcite|andesite|diorite|granite)$|_ore$/, ["cobblestone", "stone", "dirt"]],
  [/^(sand|red_sand|gravel|sandstone|red_sandstone)$/, ["sand", "dirt", "cobblestone"]],
  [/_leaves$/, ["oak_leaves", "dirt"]],
];
const CHEAP = ["cobblestone", "dirt", "netherrack", "cobbled_deepslate"];

const DEF_STORE = { active: null, supply: [], snap: null, guard: false };
let store = { ...DEF_STORE };
try { store = { ...DEF_STORE, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch (e) {}
let dirty = false;
const saveNow = () => { dirty = false; try { fs.writeFile(FILE, JSON.stringify(store), () => {}); } catch (e) {} };
const flushT = setInterval(() => { if (dirty) saveNow(); }, 8000);
if (flushT.unref) flushT.unref();
const touch = () => { dirty = true; };

const safeName = (n) => String(n || "").replace(/\.(litematic|schem|schematic|nbt)$/i, "").replace(/[^A-Za-z0-9_\-]/g, "_").slice(0, 60);
function listFiles() {
  try { return fs.readdirSync(BP_DIR).filter((f) => /\.(litematic|schem|schematic|nbt)$/i.test(f)).sort(); } catch (e) { return []; }
}
function saveUpload(name, buf) {
  const ext = (/\.(litematic|schem|schematic|nbt)$/i.exec(name) || [".litematic"])[0].toLowerCase();
  const bp = lm.parse(buf, name); // validasi dulu: file rusak ditolak sebelum disimpan
  fs.mkdirSync(BP_DIR, { recursive: true });
  const file = safeName(name) + ext;
  fs.writeFileSync(path.join(BP_DIR, file), buf);
  return { file, blocks: bp.blocks.length, size: bp.size };
}
const loadFile = (file) => lm.parse(fs.readFileSync(path.join(BP_DIR, path.basename(file))), file);

// ---------- fungsi murni (mudah diuji) ----------
const facingYaw = (t) => {
  const f = t.props && t.props.facing;
  if (!f || !DIR_YAW.hasOwnProperty(f)) return null;
  if (FACE_SAME.test(t.name)) return DIR_YAW[f];
  if (FACE_OPP.test(t.name)) return DIR_YAW[OPP[f]];
  return null;
};
const ORIENT = (name) => /_stairs$/.test(name) ? ["facing", "half"] : /_slab$/.test(name) ? ["type"] : /_log$|_wood$|^hay_block$|^bone_block$|_pillar$|^basalt$|^chain$/.test(name) ? ["axis"] : (FACE_SAME.test(name) || FACE_OPP.test(name)) && !/^(chest|trapped_chest)$/.test(name) ? ["facing"] : [];
function propsMatch(actual, t) {
  const keys = ORIENT(t.name), want = t.props || {};
  for (const k of keys) if (k in want && k in actual && String(actual[k]) !== String(want[k])) return false;
  return true;
}
// target dari blueprint: koordinat absolut
function targetsFrom(bp, origin) {
  return bp.blocks.filter((b) => !lm.isSecondary(b)).map((b) => ({ x: origin.x + b.x, y: origin.y + b.y, z: origin.z + b.z, name: b.name, props: b.props || {}, item: lm.itemFor(b.name) }));
}
function sortTargets(list) {
  const attached = (t) => (ATTACHED.test(t.name) ? 1 : 0);
  return list.slice().sort((a, b) => attached(a) - attached(b) || a.y - b.y || a.z - b.z || (a.z % 2 ? b.x - a.x : a.x - b.x));
}
const tally = (list) => { const c = {}; for (const t of list) c[t.item] = (c[t.item] || 0) + (t.props && t.props.type === "double" && /_slab$/.test(t.name) ? 2 : 1); return c; };

// ---------- per bot ----------
function attach(bot, mcData, botState, config, log, addInterval) {
  const registry = bot.registry || mcData;
  const Vec3 = bot.entity.position.constructor;
  const cfg = Object.assign({ radius: 40, guard: false, "max-wait": 90, "scaffold-clean": true }, (config && config.printer) || {});
  const P = { running: false, abort: false, phase: "Menganggur", msg: "", mode: "", done: 0, total: 0, bp: null, file: "", origin: null, rot: 0, need: [], missing: {}, orient: 0, lines: [], error: "", guard: !!store.guard, supplyN: store.supply.length, snapN: store.snap ? store.snap.blocks.length : 0 };
  botState.printer = P;
  botState.cmds = botState.cmds || {};
  let BP = null, targets = [], index = {}, scaf = [], recheck = 0, ended = false;
  const fixTried = new Map();

  const say = (m) => { P.msg = m; P.lines.push(new Date().toLocaleTimeString("id-ID") + " " + m); if (P.lines.length > 40) P.lines.shift(); log("[Printer] " + m); };
  const up = () => !ended && botState.connected && bot.entity && !P.abort;
  const items = () => bot.inventory.items();
  const count = (n) => items().filter((i) => i.name === n).reduce((s, i) => s + i.count, 0);
  const sk = () => botState.skills || {};
  const solid = (b) => b && b.boundingBox === "block";
  const stopCheck = async () => { while (botState.fighting && up()) await sleep(500); if (!up()) throw new Error("dihentikan"); };
  const moveCfg = () => { const m = human.applyMovements(new Movements(bot), registry, false, false); m.allowParkour = false; return m; };
  async function go(goal, tries) {
    for (let i = 0; i < (tries || 2); i++) {
      await stopCheck();
      try { bot.pathfinder.setMovements(moveCfg()); await bot.pathfinder.goto(goal); return true; } catch (e) { if (P.abort) throw new Error("dihentikan"); await sleep(300); }
    }
    return false;
  }
  const near = (p, r) => bot.entity.position.distanceTo(new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5)) <= r;
  const vec = (t) => new Vec3(t.x, t.y, t.z);
  bot.once("end", () => { ended = true; P.abort = true; });

  // ---------- pencocokan dunia dengan target ----------
  function state(t) { // ok | empty | wrong | orient | unknown
    const cur = bot.blockAt(vec(t));
    if (!cur) return "unknown";
    if (cur.name === t.name) {
      let ap = {};
      try { ap = cur.getProperties ? cur.getProperties() : {}; } catch (e) {}
      if (t.props && t.props.type === "double" && /_slab$/.test(t.name) && ap.type && ap.type !== "double") return "orient";
      return propsMatch(ap, t) ? "ok" : "orient";
    }
    if (AIR.test(cur.name) || REPLACEABLE.test(cur.name)) return "empty";
    return "wrong";
  }

  // ---------- bahan ----------
  function itemOk(name) { return !!registry.itemsByName[name]; }
  function scaffoldItem() { for (const n of SCAFFOLD_PREF) if (count(n) > 0) return items().find((i) => i.name === n); return null; }
  function substitute(t) { // untuk potret medan: pilih item yang ada di tas
    if (count(t.item) > 0) return t.item;
    for (const [re, subs] of TERRAIN_SUB) if (re.test(t.name)) for (const s of subs) if (count(s) > 0) return s;
    for (const s of CHEAP) if (count(s) > 0) return s;
    return t.item;
  }

  async function openAt(pos) {
    const b = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
    if (!b || !/chest|barrel|shulker_box/.test(b.name)) return null;
    if (!(await go(new GoalLookAtBlock(b.position, bot.world, { reach: 4 }), 2)) && !near(b.position, 4.5)) return null;
    try { return await bot.openContainer(b); } catch (e) { return null; }
  }
  function record(pos, c) {
    const inv = {}, shul = [];
    for (const it of c.containerItems()) { inv[it.name] = (inv[it.name] || 0) + it.count; if (/shulker_box$/.test(it.name)) shul.push(it.name); }
    index[`${pos.x},${pos.y},${pos.z}`] = { t: Date.now(), items: inv, shulkers: shul.length };
  }
  async function takeFrom(c, name, want) {
    let got = 0;
    for (const it of c.containerItems().filter((i) => i.name === name)) {
      if (got >= want) break;
      if (!bot.inventory.emptySlotCount() && !items().some((i) => i.name === name && i.count < i.stackSize)) break;
      const n = Math.min(it.count, want - got);
      try { await c.withdraw(it.type, it.metadata, n); got += n; } catch (e) { break; }
    }
    return got;
  }
  // kandidat peti: yang disimpan + yang terlihat di sekitar bot / blueprint (di luar area bangunan)
  function containers() {
    const out = new Map();
    store.supply.forEach((p) => out.set(`${p.x},${p.y},${p.z}`, p));
    const ids = ["chest", "trapped_chest", "barrel"].map((n) => registry.blocksByName[n] && registry.blocksByName[n].id).filter((x) => x != null);
    const around = (o, r) => { try { bot.findBlocks({ point: o, matching: ids, maxDistance: r, count: 64 }).forEach((p) => { if (!inBox(p)) out.set(`${p.x},${p.y},${p.z}`, { x: p.x, y: p.y, z: p.z }); }); } catch (e) {} };
    around(bot.entity.position, cfg.radius);
    if (P.origin) around(new Vec3(P.origin.x, P.origin.y, P.origin.z), cfg.radius);
    return [...out.values()];
  }
  function inBox(p) {
    if (!P.origin || !BP) return false;
    return p.x >= P.origin.x && p.x < P.origin.x + BP.size.x && p.y >= P.origin.y && p.y < P.origin.y + BP.size.y && p.z >= P.origin.z && p.z < P.origin.z + BP.size.z;
  }

  // ambil dari shulker box di tas: pasang, buka, ambil, bongkar lagi
  async function viaShulkers(name, want) {
    let got = 0;
    for (const sh of items().filter((i) => /shulker_box$/.test(i.name))) {
      if (got >= want || !up()) break;
      const feet = bot.entity.position.floored();
      let spot = null;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
        const ref = bot.blockAt(feet.offset(dx, -1, dz)), a = bot.blockAt(feet.offset(dx, 0, dz)), a2 = bot.blockAt(feet.offset(dx, 1, dz));
        if (solid(ref) && a && AIR.test(a.name) && a2 && AIR.test(a2.name)) { spot = { ref, pos: feet.offset(dx, 0, dz) }; break; }
      }
      if (!spot) break;
      try {
        await bot.equip(sh, "hand");
        await bot.placeBlock(spot.ref, new Vec3(0, 1, 0));
        await sleep(300);
        const blk = bot.blockAt(spot.pos);
        if (!blk || !/shulker_box$/.test(blk.name)) continue;
        const c = await bot.openContainer(blk);
        got += await takeFrom(c, name, want - got);
        c.close();
        await sleep(200);
        const tool = bot.pathfinder && bot.pathfinder.bestHarvestTool ? bot.pathfinder.bestHarvestTool(bot.blockAt(spot.pos)) : null;
        if (tool) await bot.equip(tool, "hand");
        await bot.dig(bot.blockAt(spot.pos), true);
        await sleep(400);
        const drop = Object.values(bot.entities).find((e) => e.position && e.position.distanceTo(spot.pos) < 3 && (e.name === "item" || e.objectType === "Item"));
        if (drop) await go(new GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.7), 1);
      } catch (e) { log("[Printer] shulker gagal: " + e.message); }
    }
    return got;
  }

  // isi ulang `name` sebanyak `want`; mengembalikan jumlah yang berhasil didapat
  async function resupply(name, want) {
    P.phase = "Isi ulang bahan"; say(`Butuh ${name} x${want}, mencari di peti...`);
    let got = 0;
    if (items().some((i) => /shulker_box$/.test(i.name))) got += await viaShulkers(name, want - got);
    if (got >= want) return got;
    const list = containers();
    const rank = (p) => { const e = index[`${p.x},${p.y},${p.z}`]; return e ? (e.items[name] ? 0 : e.shulkers ? 2 : 3) : 1; }; // 0 pasti ada, 1 belum dicek, 2 mungkin di shulker, 3 tidak ada
    list.sort((a, b) => rank(a) - rank(b) || bot.entity.position.distanceTo(new Vec3(a.x, a.y, a.z)) - bot.entity.position.distanceTo(new Vec3(b.x, b.y, b.z)));
    for (const pos of list) {
      if (got >= want || !up()) break;
      const r = rank(pos);
      if (r === 3) continue;
      const c = await openAt(pos);
      if (!c) continue;
      try {
        record(pos, c);
        got += await takeFrom(c, name, want - got);
        // peti berisi shulker box: ambil satu per satu lalu cari di dalamnya
        if (got < want) {
          for (const sh of c.containerItems().filter((i) => /shulker_box$/.test(i.name)).slice(0, 4)) {
            try { await c.withdraw(sh.type, sh.metadata, 1); } catch (e) { break; }
          }
        }
      } finally { try { c.close(); } catch (e) {} }
      await sleep(150);
      if (got < want && items().some((i) => /shulker_box$/.test(i.name))) got += await viaShulkers(name, want - got);
    }
    // cadangan: kumpulkan sendiri bahan sederhana
    if (got < want && up()) {
      const S = sk(), before = count(name);
      try {
        if (/_planks$/.test(name) && S.planksFor) await S.planksFor(before + (want - got));
        else if (/^(cobblestone|dirt)$/.test(name) && S.mineKind) await S.mineKind(name === "dirt" ? ["dirt", "grass_block"] : ["stone", "cobblestone"], want - got, name, Date.now() + 6 * 60000);
        else if (/_log$/.test(name) && S.mineKind) await S.mineKind(registry.blocksArray.filter((b) => /_log$/.test(b.name)).map((b) => b.name), want - got, name, Date.now() + 6 * 60000);
      } catch (e) {}
      got += Math.max(0, count(name) - before);
    }
    P.supplyN = store.supply.length;
    say(got ? `Dapat ${name} x${got}` : `${name} tidak ketemu di peti manapun`);
    return got;
  }

  // ---------- perancah (pilar) ----------
  async function pillarTo(y) {
    for (let i = 0; i < 40 && up() && Math.floor(bot.entity.position.y) < y; i++) {
      const it = scaffoldItem();
      if (!it) { if (!(await resupply("cobblestone", 32))) return false; continue; }
      const feet = bot.entity.position.floored();
      const ground = bot.blockAt(feet.offset(0, -1, 0));
      if (!solid(ground)) { await sleep(150); continue; }
      try {
        await bot.equip(it, "hand");
        await bot.look(bot.entity.yaw, -Math.PI / 2, true);
        bot.setControlState("jump", true);
        for (let k = 0; k < 14 && bot.entity.position.y < ground.position.y + 1.25; k++) await sleep(50);
        await bot.placeBlock(ground, new Vec3(0, 1, 0));
        scaf.push({ x: ground.position.x, y: ground.position.y + 1, z: ground.position.z, name: it.name });
      } catch (e) {} finally { bot.setControlState("jump", false); }
      await sleep(250);
    }
    return Math.floor(bot.entity.position.y) >= y;
  }
  async function cleanScaffold() {
    if (!cfg["scaffold-clean"] || !scaf.length) { scaf = []; return; }
    let left = 0;
    for (const s of scaf.sort((a, b) => b.y - a.y)) {
      if (!up()) break;
      const key = targets.find((t) => t.x === s.x && t.y === s.y && t.z === s.z);
      const cur = bot.blockAt(new Vec3(s.x, s.y, s.z));
      if (key || !cur || cur.name !== s.name) continue;
      try {
        if (!(await go(new GoalLookAtBlock(cur.position, bot.world, { reach: 4 }), 1))) { left++; continue; }
        const tool = bot.pathfinder && bot.pathfinder.bestHarvestTool ? bot.pathfinder.bestHarvestTool(cur) : null;
        if (tool) await bot.equip(tool, "hand");
        await bot.dig(cur, true);
      } catch (e) { left++; }
    }
    if (left) say(`${left} blok perancah tidak terjangkau, dibiarkan`);
    scaf = [];
  }

  // ---------- menaruh satu blok ----------
  function pickSupport(t) {
    const p = vec(t), pr = t.props || {};
    const at = (f) => bot.blockAt(p.offset(f[0], f[1], f[2]));
    const cand = [];
    const add = (f) => { const b = at(f); if (solid(b)) cand.push({ ref: b, face: new Vec3(-f[0], -f[1], -f[2]) }); };
    if (WALLMOUNT.test(t.name) && pr.facing && DIR_VEC[pr.facing] && pr.face !== "floor" && pr.face !== "ceiling") add([-DIR_VEC[pr.facing][0], 0, -DIR_VEC[pr.facing][2]]); // belakang = dinding
    else if (pr.face === "ceiling" || pr.half === "top") { add([0, 1, 0]); }
    if (!cand.length || !WALLMOUNT.test(t.name)) for (const f of FACES) add(f);
    return cand;
  }
  async function placeOne(t) {
    const p = vec(t);
    let cur = bot.blockAt(p);
    if (!cur) { await go(new GoalNear(t.x, t.y, t.z, 6), 1); cur = bot.blockAt(p); if (!cur) return "unloaded"; }
    const st = state(t);
    if (st === "ok") return "ok";
    const double2 = st === "orient" && t.props && t.props.type === "double" && /_slab$/.test(t.name);
    if (st === "orient" && !double2) {
      const k = `${t.x},${t.y},${t.z}`;
      if ((fixTried.get(k) || 0) >= 1) { P.orient++; return "ok"; } // arah sulit diatur: terima apa adanya
      fixTried.set(k, 1);
    }
    if ((st === "wrong" || (st === "orient" && !double2))) {
      if (!human.breakable(bot, cur)) { if (st === "orient") { P.orient++; return "ok"; } return "blocked"; }
      if (!near(p, 4.4) && !(await go(new GoalLookAtBlock(p, bot.world, { reach: 4 }), 1))) return "unreachable";
      try { const tool = bot.pathfinder && bot.pathfinder.bestHarvestTool ? bot.pathfinder.bestHarvestTool(cur) : null; if (tool) await bot.equip(tool, "hand"); await bot.dig(bot.blockAt(p), true); } catch (e) { return "blocked"; }
      await sleep(150);
    }
    const itemName = t.sub || t.item;
    const item = items().find((i) => i.name === itemName);
    if (!item) return "noitem:" + itemName;
    const slabTop = double2;
    let sup = slabTop ? [{ ref: bot.blockAt(p), face: new Vec3(0, 1, 0) }] : pickSupport(t);
    if (!sup.length) return "floating";
    // berdiri di tempat yang bisa menjangkau; bila terlalu tinggi, buat pilar
    if (!near(p, 4.3)) {
      let ok = await go(new GoalPlaceBlock(p, bot.world, { range: 4.2 }), 1);
      if (!ok && t.y > bot.entity.position.y + 2) {
        await go(new GoalNear(t.x + 1, t.y - 1, t.z + 1, 2), 1);
        await pillarTo(Math.floor(t.y - 1));
        ok = near(p, 5);
      }
      if (!ok) return "unreachable";
    }
    const feet = bot.entity.position.floored();
    if (feet.equals(p) || feet.offset(0, 1, 0).equals(p)) { await go(new GoalNear(t.x + 2, t.y, t.z + 2, 1), 1); return "inway"; }
    sup = slabTop ? sup : pickSupport(t);
    if (!sup.length) return "floating";
    const s = sup[0], yaw = facingYaw(t), pr = t.props || {};
    try {
      await bot.equip(item, "hand");
      if (yaw != null) { await bot.look(yaw, 0, true); }
      else await bot.lookAt(p.offset(0.5, 0.5, 0.5), true);
      const opt = { forceLook: yaw != null ? "ignore" : true };
      if (pr.half === "top" || pr.type === "top") opt.half = "top"; else if (pr.half === "bottom" || pr.type === "bottom") opt.half = "bottom";
      await bot.placeBlock(s.ref, s.face, opt);
      await sleep(90);
      const after = state(t);
      if (after === "ok") return "ok";
      if (after === "orient") { P.orient++; return "ok"; }
      return after === "empty" ? "error" : "ok";
    } catch (e) { return "error"; }
  }

  // ---------- loop utama ----------
  async function runTargets(list, mode, opts) {
    opts = opts || {};
    P.running = true; P.abort = false; P.mode = mode; P.error = ""; P.missing = {}; P.orient = 0; P.done = 0; fixTried.clear();
    botState.task = true;
    try {
      let pending = sortTargets(list.filter((t) => { const s = state(t); return s !== "ok" && !(opts.fillOnly && (s === "wrong" || s === "orient")); }));
      if (opts.fallback) pending.forEach((t) => { if (!count(t.item)) t.sub = substitute(t); });
      P.total = pending.length;
      if (!pending.length) { P.phase = "Selesai"; say("Tidak ada yang perlu dikerjakan, semua sudah sesuai"); return; }
      P.phase = mode === "repair" ? "Menambal" : "Membangun";
      say(`${mode === "repair" ? "Menambal" : "Membangun"} ${pending.length} blok`);
      const stats = {};
      for (let pass = 1; pass <= 8 && pending.length && up(); pass++) {
        const next = [], noSupply = new Set();
        let progress = 0;
        for (let i = 0; i < pending.length; i++) {
          const t = pending[i];
          await stopCheck();
          if (noSupply.has(t.sub || t.item)) { next.push(t); continue; }
          let r = await placeOne(t);
          if (r.startsWith("noitem:")) {
            const nm = r.slice(7);
            const want = pending.slice(i).filter((q) => (q.sub || q.item) === nm).length;
            const got = await resupply(nm, Math.min(want, 2304));
            if (got > 0 || count(nm) > 0) r = await placeOne(t); else { noSupply.add(nm); P.missing[nm] = want; r = "nosupply"; }
          }
          if (r === "ok") { progress++; P.done++; P.msg = `${P.phase} ${P.done}/${P.total}`; }
          else { stats[r] = (stats[r] || 0) + 1; next.push(t); }
        }
        pending = next;
        if (!progress) break;
        if (pending.length) say(`Putaran ${pass}: sisa ${pending.length} blok`);
      }
      await cleanScaffold();
      const left = pending.length;
      P.need = Object.entries(P.missing).map(([name, n]) => ({ name, need: n, have: count(name) }));
      P.phase = left ? "Selesai sebagian" : "Selesai";
      say(left ? `Selesai sebagian: ${P.done}/${P.total}. Sisa ${left} (${Object.entries(stats).map(([k, v]) => k + ":" + v).join(", ")})${Object.keys(P.missing).length ? ". Kurang bahan: " + Object.entries(P.missing).map(([k, v]) => `${k} x${v}`).join(", ") : ""}` : `Selesai! ${P.done} blok terpasang${P.orient ? ` (${P.orient} blok arahnya mungkin beda)` : ""}`);
    } catch (e) {
      P.error = e.message; P.phase = e.message === "dihentikan" ? "Dihentikan" : "Gagal"; say(`${P.phase}: ${e.message}`);
    } finally {
      P.running = false; botState.task = !!botState.agentActive;
      try { bot.pathfinder.setGoal(null); } catch (e) {}
    }
  }

  // ---------- blueprint ----------
  function refresh() {
    if (!BP || !P.origin) { targets = []; P.total = 0; return; }
    const rotated = lm.rotate(BP.raw, P.rot);
    BP.size = rotated.size; BP.blocks = rotated.blocks;
    targets = targetsFrom(BP, P.origin);
    P.bp = { name: BP.name, size: BP.size, blocks: BP.blocks.length, materials: lm.materials(BP.blocks) };
    store.active = { file: P.file, origin: P.origin, rot: P.rot }; touch();
  }
  function load(file, origin, rot) {
    const raw = loadFile(file);
    BP = { raw, name: raw.name, size: raw.size, blocks: raw.blocks };
    P.file = path.basename(file); P.rot = ((rot || 0) % 4 + 4) % 4;
    const e = bot.entity.position.floored();
    P.origin = origin || { x: e.x, y: e.y, z: e.z };
    refresh();
  }
  try { if (store.active && store.active.file) load(store.active.file, store.active.origin, store.active.rot); } catch (e) { store.active = null; }

  const missingList = (list) => list.filter((t) => { const s = state(t); return s === "empty"; });
  async function buildAll() { if (!targets.length) return "belum ada blueprint (/bp load <nama>)"; if (P.running) return "printer sedang bekerja"; runTargets(targets, "build", { fillOnly: false }); return `membangun ${targets.length} blok`; }
  async function repair() {
    if (P.running) return "printer sedang bekerja";
    const list = targets.length ? targets : (store.snap ? store.snap.blocks.map(([x, y, z, name, props]) => ({ x, y, z, name, props: props || {}, item: lm.itemFor(name) })) : []);
    if (!list.length) return "tidak ada blueprint atau potret area untuk dibandingkan";
    const miss = missingList(list);
    if (!miss.length) return "tidak ada yang rusak/hilang";
    runTargets(miss, "repair", { fillOnly: true, fallback: !targets.length });
    return `menambal ${miss.length} blok`;
  }

  // potret area (untuk menambal medan setelah ledakan)
  function snapshot(r) {
    r = Math.max(2, Math.min(14, Math.floor(r) || 8));
    const c = bot.entity.position.floored(), blocks = [];
    for (let x = c.x - r; x <= c.x + r; x++) for (let z = c.z - r; z <= c.z + r; z++) for (let y = c.y - 4; y <= c.y + 8; y++) {
      const b = bot.blockAt(new Vec3(x, y, z));
      if (!b || b.boundingBox !== "block" || /leaves|chest|barrel|furnace|bed|sign|door|torch/.test(b.name)) continue;
      blocks.push([x, y, z, b.name, {}]);
    }
    if (!blocks.length) return "tidak ada blok untuk dipotret";
    if (blocks.length > 20000) blocks.length = 20000;
    store.snap = { at: Date.now(), center: { x: c.x, y: c.y, z: c.z }, r, blocks }; touch(); P.snapN = blocks.length;
    return `potret area ${blocks.length} blok disimpan (radius ${r}). Aktifkan /bp guard on agar lubang ditambal otomatis`;
  }

  // ---------- penjaga: tambal otomatis ----------
  const guardTick = { t: 0, next(now) { if (now - this.t < 10000) return false; this.t = now; return true; } };
  try { bot._client.on("explosion", () => { recheck = Date.now() + 2500; }); } catch (e) {}
  addInterval(async () => {
    try {
      if (!P.guard || P.running || !up() || botState.fighting) return;
      const now = Date.now(), due = recheck && now > recheck;
      if (!due && !guardTick.next(now)) return; // ledakan: cek 2,5 detik kemudian; selain itu tiap 10 detik
      recheck = 0;
      const list = targets.length ? targets : (store.snap ? store.snap.blocks.map(([x, y, z, name]) => ({ x, y, z, name, props: {}, item: lm.itemFor(name) })) : []);
      if (!list.length) return;
      const c = bot.entity.position;
      const inRange = list.filter((t) => Math.abs(t.x - c.x) < 90 && Math.abs(t.z - c.z) < 90);
      const miss = missingList(inRange.length > 4000 ? inRange.slice(0, 4000) : inRange);
      if (!miss.length) return;
      say(`Penjaga: ${miss.length} blok hilang (mungkin ledakan), menambal`);
      runTargets(miss, "repair", { fillOnly: true, fallback: !targets.length });
    } catch (e) {}
  }, 1000);

  // ---------- perintah ----------
  const num = (s) => Number(s);
  botState.cmds["/bp"] = (a) => {
    const sub = (a[0] || "").toLowerCase();
    if (sub === "list") { const f = listFiles(); return f.length ? "Blueprint: " + f.join(", ") : "belum ada blueprint (unggah lewat panel, tab Blueprint)"; }
    if (sub === "load") {
      const name = a[1]; if (!name) return "format: /bp load <nama> [x y z] [rot 0-3]";
      const f = listFiles().find((x) => x === name || safeName(x) === safeName(name));
      if (!f) return "file tidak ditemukan: " + name;
      const xyz = a.slice(2, 5).map(num);
      const origin = xyz.length === 3 && xyz.every(Number.isFinite) ? { x: xyz[0], y: xyz[1], z: xyz[2] } : null;
      try { load(f, origin, num(a[5]) || 0); } catch (e) { return "gagal memuat: " + e.message; }
      return `dimuat ${BP.name} ${BP.size.x}x${BP.size.y}x${BP.size.z} (${BP.blocks.length} blok) di ${P.origin.x} ${P.origin.y} ${P.origin.z}`;
    }
    if (!BP && !["guard", "stop", "help", ""].includes(sub)) return "belum ada blueprint dimuat";
    if (sub === "origin") { const v = a.slice(1, 4).map(num); if (v.length < 3 || v.some((n) => !Number.isFinite(n))) return "format: /bp origin x y z"; P.origin = { x: v[0], y: v[1], z: v[2] }; refresh(); return "titik asal diubah"; }
    if (sub === "here") { const e = bot.entity.position.floored(); P.origin = { x: e.x, y: e.y, z: e.z }; refresh(); return `titik asal = posisi bot (${e.x} ${e.y} ${e.z})`; }
    if (sub === "rot") { P.rot = (((num(a[1]) || 0) % 4) + 4) % 4; refresh(); return `rotasi ${P.rot * 90} derajat`; }
    if (sub === "info") { const m = lm.materials(BP.blocks), tot = Object.values(m).reduce((s, n) => s + n, 0); const lack = Object.entries(m).filter(([n, c]) => count(n) < c).slice(0, 12).map(([n, c]) => `${n} ${count(n)}/${c}`); return `${BP.name} ${BP.size.x}x${BP.size.y}x${BP.size.z}, ${tot} blok, ${Object.keys(m).length} jenis. Kurang di tas: ${lack.join(", ") || "tidak ada"}`; }
    if (sub === "build" || sub === "start") { buildAll().then((r) => say(r)); return "perintah diterima"; }
    if (sub === "verify") { const s = { ok: 0, empty: 0, wrong: 0, orient: 0, unknown: 0 }; targets.forEach((t) => s[state(t)]++); return `sesuai ${s.ok}, kosong ${s.empty}, beda blok ${s.wrong}, beda arah ${s.orient}, belum dimuat ${s.unknown}`; }
    if (sub === "unload") { BP = null; targets = []; store.active = null; P.bp = null; P.file = ""; P.origin = null; touch(); return "blueprint dilepas"; }
    if (sub === "stop") { P.abort = true; return "menghentikan"; }
    if (sub === "guard") { P.guard = a[1] ? /^(on|1|ya|true)$/i.test(a[1]) : !P.guard; store.guard = P.guard; touch(); return "penjaga tambal otomatis " + (P.guard ? "AKTIF" : "mati"); }
    return "perintah /bp: list, load <nama> [x y z] [rot], here, origin x y z, rot n, info, verify, build, repair(/repair), stop, guard on|off, unload";
  };
  botState.cmds["/supply"] = (a) => {
    const sub = (a[0] || "").toLowerCase();
    if (sub === "add") { const v = a.slice(1, 4).map(num); if (v.length < 3 || v.some((n) => !Number.isFinite(n))) return "format: /supply add x y z"; store.supply.push({ x: v[0], y: v[1], z: v[2] }); touch(); P.supplyN = store.supply.length; return "peti suplai ditambah"; }
    if (sub === "clear") { store.supply = []; index = {}; touch(); P.supplyN = 0; return "daftar peti suplai dihapus"; }
    if (sub === "scan") {
      if (P.running) return "printer sedang bekerja";
      (async () => { P.running = true; P.abort = false; P.phase = "Memindai peti"; try { for (const pos of containers().slice(0, 40)) { await stopCheck(); const c = await openAt(pos); if (c) { record(pos, c); c.close(); } } say(`Pemindaian selesai: ${Object.keys(index).length} peti terindeks`); } catch (e) { say("Pemindaian berhenti: " + e.message); } finally { P.running = false; P.phase = "Menganggur"; } })();
      return "memindai peti di sekitar";
    }
    if (sub === "list" || !sub) { const rows = Object.entries(index).map(([k, v]) => `${k}: ${Object.entries(v.items).slice(0, 6).map(([n, c]) => n + " " + c).join(", ") || "kosong"}`); return `Peti suplai tersimpan: ${store.supply.length}. Terindeks: ${rows.length}\n` + rows.slice(0, 12).join("\n"); }
    return "perintah /supply: add x y z, scan, list, clear";
  };
  botState.cmds["/snapshot"] = (a) => snapshot(num(a[0]) || 8);
  botState.cmds["/repair"] = () => { repair().then((r) => say(r)); return "memeriksa kerusakan..."; };
  botState.printerStop = () => { P.abort = true; };
  botState.printerApi = { load: (f, o, r) => { load(f, o, r); return P.bp; }, build: buildAll, repair, snapshot, cmd: (c, a) => botState.cmds[c](a) };
}

// ---------- API panel ----------
function routes(app, manager, config, addLog) {
  const pick = (id) => manager.list.find((b) => b.id === id && b.botState.connected) || manager.list.find((b) => b.botState.connected);
  const express = require("express");
  app.get("/api/printer", (req, res) => {
    const bots = manager.list.map((b) => ({ id: b.id, online: !!b.botState.connected, status: b.botState.printer || null }));
    res.json({ success: true, files: listFiles(), bots });
  });
  app.get("/api/printer/layer", (req, res) => {
    try {
      const f = String(req.query.file || ""), y = Number(req.query.y) || 0, rot = Number(req.query.rot) || 0;
      const bp = lm.rotate(loadFile(f), rot);
      res.json({ success: true, size: bp.size, ...lm.layer(bp, Math.max(0, Math.min(bp.size.y - 1, y))) });
    } catch (e) { res.json({ success: false, msg: e.message }); }
  });
  // unggah: body mentah (octet-stream) dengan ?name=rumah.litematic, maksimal 12 MB
  app.post("/api/printer/upload", express.raw({ type: "*/*", limit: "12mb" }), (req, res) => {
    try {
      const name = String(req.query.name || "").trim();
      if (!/\.(litematic|schem|schematic|nbt)$/i.test(name)) return res.json({ success: false, msg: "nama file harus berakhiran .litematic, .schem atau .nbt" });
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.json({ success: false, msg: "file kosong" });
      const r = saveUpload(name, req.body);
      addLog(`[Printer] Blueprint diunggah: ${r.file} (${r.blocks} blok)`);
      res.json({ success: true, ...r });
    } catch (e) { res.json({ success: false, msg: e.message }); }
  });
  app.post("/api/printer/delete", (req, res) => {
    try { fs.unlinkSync(path.join(BP_DIR, path.basename(String((req.body || {}).file || "")))); res.json({ success: true }); } catch (e) { res.json({ success: false, msg: "tidak bisa menghapus" }); }
  });
  app.post("/api/printer/cmd", (req, res) => {
    const b = pick((req.body || {}).bot);
    if (!b || !b.botState.cmds) return res.json({ success: false, msg: "Tidak ada bot online" });
    const parts = String((req.body || {}).cmd || "").trim().split(/\s+/), c = parts.shift();
    const fn = b.botState.cmds[c];
    if (!fn) return res.json({ success: false, msg: "perintah tidak dikenal" });
    const r = fn(parts);
    addLog(`[Printer] ${c} ${parts.join(" ")} -> ${r}`);
    res.json({ success: true, msg: r });
  });
}

module.exports = { attach, routes, _t: { targetsFrom, sortTargets, tally, facingYaw, propsMatch, saveUpload, listFiles, BP_DIR } };
