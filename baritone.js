"use strict";
// Perintah ala Baritone untuk bot Mineflayer:
//  /mine <blok> [jumlah]     tambang blok (bijih, kayu, batu, dll) dengan alat terbaik, lalu ambil drop-nya
//  /bridge <arah> [panjang]  buat jembatan melintasi jurang / air (menaruh blok di depan sambil jalan)
//  /pillar [tinggi]          menara 1x1 ke atas (naik dengan menaruh blok di bawah kaki)
//  /tunnel <arah> [panjang]  gali terowongan 1x2 lurus, berhenti sebelum lava / air
//  /fill x1 y1 z1 x2 y2 z2 <blok>  isi kotak dengan satu jenis blok (menutup lubang, membuat lantai)
// Berjalan biasa (/goto, /follow) sudah memakai pathfinder yang otomatis membuat jembatan dan menggali (lihat human.js).
const { goals, Movements } = require("mineflayer-pathfinder");
const { GoalNear, GoalLookAtBlock, GoalPlaceBlock } = goals;
const human = require("./human");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AIR = /^(air|cave_air|void_air)$/;
const FLUID = /^(water|lava)$/;
const DIRS = { n: [0, -1], north: [0, -1], s: [0, 1], south: [0, 1], e: [1, 0], east: [1, 0], w: [-1, 0], west: [-1, 0], utara: [0, -1], selatan: [0, 1], timur: [1, 0], barat: [-1, 0] };
const PLACEABLE_PREF = ["cobblestone", "dirt", "netherrack", "cobbled_deepslate", "stone", "andesite", "diorite", "granite", "oak_planks", "spruce_planks", "birch_planks", "sandstone"];
const FACES = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];

// "diamond" -> diamond_ore + deepslate_diamond_ore, "kayu"/"log" -> semua log, "oak_log" -> persis
function resolveBlocks(q, registry) {
  q = String(q || "").toLowerCase().replace(/^minecraft:/, "").replace(/\s+/g, "_");
  const names = registry.blocksArray.map((b) => b.name), has = (n) => names.includes(n);
  const alias = { kayu: "log", wood: "log", pohon: "log", batu: "stone", tanah: "dirt", pasir: "sand", besi: "iron", emas: "gold", berlian: "diamond", batubara: "coal", tembaga: "copper" };
  q = alias[q] || q;
  if (q === "log") return names.filter((n) => /_log$/.test(n) && !/stripped/.test(n));
  if (q === "stone") return ["stone", "cobblestone"].filter(has);
  if (has(q) && !/_ore$/.test(q) && !has(q + "_ore")) return [q];
  const ore = [q + "_ore", "deepslate_" + q + "_ore"].filter(has);
  if (q === "redstone") ore.push(...["redstone_ore", "deepslate_redstone_ore"].filter((n) => has(n) && !ore.includes(n)));
  if (ore.length) return ore;
  if (has(q)) return [q];
  return names.filter((n) => n.includes(q) && !/(_block|_stairs|_slab|_wall|_door|_planks|^raw_)/.test(n));
}

function attach(bot, mcData, botState, config, log, addInterval) {
  const registry = bot.registry || mcData;
  const Vec3 = bot.entity.position.constructor;
  const B = { running: false, abort: false, task: "", msg: "", done: 0, lines: [] };
  let ended = false;
  botState.baritone = B;
  botState.cmds = botState.cmds || {};
  const say = (m) => { B.msg = m; B.lines.push(new Date().toLocaleTimeString("id-ID") + " " + m); if (B.lines.length > 25) B.lines.shift(); log("[Baritone] " + m); };
  const up = () => !ended && botState.connected && bot.entity && !B.abort;
  const items = () => bot.inventory.items();
  const solid = (b) => b && b.boundingBox === "block";
  const stopCheck = async () => { while (botState.fighting && up()) await sleep(500); if (!up()) throw new Error("dihentikan"); };
  const ctl = (k, v) => { try { bot.setControlState(k, v); } catch (e) {} };
  bot.once("end", () => { ended = true; B.abort = true; });

  const mv = (dig) => { const m = human.applyMovements(new Movements(bot), registry, dig, true); m.allowParkour = false; return m; };
  async function go(goal, dig, tries) {
    for (let i = 0; i < (tries || 2); i++) {
      await stopCheck();
      try { bot.pathfinder.setMovements(mv(dig)); await bot.pathfinder.goto(goal); return true; } catch (e) { if (B.abort) throw new Error("dihentikan"); await sleep(300); }
    }
    return false;
  }
  function bestTool(block) {
    let best = null, bt = Infinity;
    for (const it of [null, ...items()]) {
      let t;
      try { t = block.digTime(it ? it.type : null, false, false, false); } catch (e) { continue; }
      if (t < bt - 1) { bt = t; best = it; }
    }
    return best;
  }
  async function digBlock(block) {
    const tool = bestTool(block);
    if (tool) await bot.equip(tool, "hand"); else if (bot.heldItem) await bot.unequip("hand").catch(() => {});
    await bot.dig(bot.blockAt(block.position), true);
  }
  async function collectDrops(near) {
    await sleep(200);
    for (let k = 0; k < 4; k++) {
      const d = Object.values(bot.entities).filter((e) => e.position && (e.name === "item" || e.objectType === "Item") && e.position.distanceTo(near) < 6).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
      if (!d) break;
      await go(new GoalNear(d.position.x, d.position.y, d.position.z, 0.7), false, 1);
    }
  }
  const dangerNear = (p) => FACES.some((f) => { const b = bot.blockAt(p.offset(f[0], f[1], f[2])); return b && /lava/.test(b.name); });
  const placeable = () => { for (const n of PLACEABLE_PREF) { const it = items().find((i) => i.name === n); if (it) return it; } return items().find((i) => registry.blocksByName[i.name] && registry.blocksByName[i.name].boundingBox === "block" && !/shulker|chest|barrel|furnace|table|bed|tnt|sand|gravel|powder/.test(i.name)) || null; };

  function run(task, fn) {
    if (B.running) return "Baritone masih mengerjakan: " + B.task;
    if (!botState.connected) return "bot belum terhubung";
    B.running = true; B.abort = false; B.task = task; B.done = 0; botState.task = true;
    (async () => {
      try { const r = await fn(); say(r || "selesai"); }
      catch (e) { say(e.message === "dihentikan" ? "dihentikan" : "gagal: " + e.message); }
      finally { B.running = false; B.task = ""; botState.task = !!botState.agentActive; ctl("forward", false); ctl("sneak", false); ctl("jump", false); try { bot.pathfinder.setGoal(null); } catch (e) {} }
    })();
    return "dimulai: " + task;
  }

  // ---------- /mine ----------
  async function mine(names, want) {
    const ids = names.map((n) => registry.blocksByName[n] && registry.blocksByName[n].id).filter((x) => x != null);
    if (!ids.length) throw new Error("blok tidak dikenal");
    const bad = new Set();
    let fails = 0;
    while (up() && B.done < want && fails < 12) {
      await stopCheck();
      const list = bot.findBlocks({ matching: ids, maxDistance: 64, count: 40 }).map((p) => bot.blockAt(p)).filter((b) => b && !bad.has(b.position.toString()) && human.breakable(bot, b) && !dangerNear(b.position));
      if (!list.length) {
        fails++;
        const a = Math.random() * Math.PI * 2;
        say(`Tidak ada ${names[0]} terlihat, menjelajah (${fails}/12)`);
        await go(new GoalNear(bot.entity.position.x + Math.cos(a) * 24, bot.entity.position.y, bot.entity.position.z + Math.sin(a) * 24, 3), true, 1);
        continue;
      }
      list.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
      const t = list[0];
      if (!(await go(new GoalLookAtBlock(t.position, bot.world, { reach: 4 }), true, 1))) { bad.add(t.position.toString()); fails++; continue; }
      try {
        await digBlock(t);
        B.done++; fails = 0; B.msg = `Menambang ${names[0]} ${B.done}/${want}`;
        await collectDrops(t.position);
      } catch (e) { bad.add(t.position.toString()); fails++; }
    }
    return `selesai menambang ${B.done}/${want} ${names[0]}`;
  }

  // ---------- /bridge ----------
  async function bridge(dir, len) {
    const [dx, dz] = dir;
    ctl("sneak", true);
    for (let i = 0; i < len && up(); i++) {
      await stopCheck();
      const feet = bot.entity.position.floored();
      const next = feet.offset(dx, 0, dz), nextFloor = next.offset(0, -1, 0);
      const head1 = bot.blockAt(next), head2 = bot.blockAt(next.offset(0, 1, 0));
      if ((head1 && solid(head1)) || (head2 && solid(head2))) throw new Error(`terhalang blok di depan setelah ${B.done} blok`);
      const floorB = bot.blockAt(nextFloor);
      if (!solid(floorB)) {
        const it = placeable();
        if (!it) throw new Error("tidak punya blok untuk jembatan");
        const ref = bot.blockAt(feet.offset(0, -1, 0));
        if (!solid(ref)) throw new Error("tidak ada pijakan di bawah kaki");
        await bot.equip(it, "hand");
        await bot.lookAt(ref.position.offset(0.5 + dx * 0.5, 0.5, 0.5 + dz * 0.5), true);
        try { await bot.placeBlock(ref, new Vec3(dx, 0, dz)); } catch (e) { throw new Error("gagal menaruh blok: " + e.message); }
        await sleep(80);
      }
      const cx = next.x + 0.5, cz = next.z + 0.5;
      await bot.lookAt(new Vec3(cx, bot.entity.position.y + 1.6, cz), true);
      ctl("forward", true);
      for (let k = 0; k < 30 && up(); k++) { await sleep(50); if (Math.hypot(bot.entity.position.x - cx, bot.entity.position.z - cz) < 0.3) break; }
      ctl("forward", false);
      await sleep(60);
      B.done++; B.msg = `Jembatan ${B.done}/${len}`;
    }
    ctl("sneak", false);
    return `jembatan selesai (${B.done} blok)`;
  }

  // ---------- /pillar ----------
  async function pillar(h) {
    const startY = Math.floor(bot.entity.position.y);
    for (let i = 0; i < h && up(); i++) {
      await stopCheck();
      const it = placeable();
      if (!it) throw new Error("tidak punya blok untuk menara");
      const ground = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
      if (!solid(ground)) { await sleep(150); i--; continue; }
      await bot.equip(it, "hand");
      await bot.look(bot.entity.yaw, -Math.PI / 2, true);
      ctl("jump", true);
      for (let k = 0; k < 14 && bot.entity.position.y < ground.position.y + 1.25; k++) await sleep(50);
      try { await bot.placeBlock(ground, new Vec3(0, 1, 0)); B.done++; } catch (e) {}
      ctl("jump", false);
      await sleep(250);
    }
    return `menara naik ${Math.floor(bot.entity.position.y) - startY} blok`;
  }

  // ---------- /tunnel ----------
  async function tunnel(dir, len) {
    const [dx, dz] = dir;
    for (let i = 0; i < len && up(); i++) {
      await stopCheck();
      const feet = bot.entity.position.floored(), a = feet.offset(dx, 0, dz), b = a.offset(0, 1, 0), c = a.offset(0, -1, 0);
      for (const p of [a, b]) if (dangerNear(p) || FLUID.test((bot.blockAt(p) || {}).name || "")) throw new Error("berhenti: ada lava/air di depan");
      const under = bot.blockAt(c);
      if (under && (AIR.test(under.name) || FLUID.test(under.name))) throw new Error("berhenti: ada lubang di depan");
      for (const p of [a, b]) {
        const blk = bot.blockAt(p);
        if (blk && !AIR.test(blk.name) && blk.boundingBox === "block") { if (!human.breakable(bot, blk)) throw new Error("blok dilindungi di depan"); await digBlock(blk); B.done++; await sleep(60); }
      }
      await bot.lookAt(new Vec3(a.x + 0.5, a.y + 1.2, a.z + 0.5), true);
      ctl("forward", true);
      for (let k = 0; k < 24 && up(); k++) { await sleep(50); if (Math.hypot(bot.entity.position.x - (a.x + 0.5), bot.entity.position.z - (a.z + 0.5)) < 0.35) break; }
      ctl("forward", false);
      B.msg = `Terowongan ${i + 1}/${len}`;
    }
    return `terowongan selesai (${B.done} blok digali)`;
  }

  // ---------- /fill ----------
  async function fill(a, b, name) {
    const it0 = registry.itemsByName[name];
    if (!it0) throw new Error("blok tidak dikenal: " + name);
    const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x), y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y), z1 = Math.min(a.z, b.z), z2 = Math.max(a.z, b.z);
    const total = (x2 - x1 + 1) * (y2 - y1 + 1) * (z2 - z1 + 1);
    if (total > 4000) throw new Error(`kotak terlalu besar (${total} > 4000)`);
    const list = [];
    for (let y = y1; y <= y2; y++) for (let z = z1; z <= z2; z++) for (let x = x1; x <= x2; x++) list.push(new Vec3(x, y, z));
    let skipped = 0;
    for (const p of list) {
      await stopCheck();
      const cur = bot.blockAt(p);
      if (!cur || cur.name === name) continue;
      if (!AIR.test(cur.name) && !FLUID.test(cur.name) && !/grass|fern|snow|vine/.test(cur.name)) { skipped++; continue; }
      const it = items().find((i) => i.name === name);
      if (!it) throw new Error(`${name} habis setelah ${B.done} blok`);
      const sup = FACES.map((f) => ({ f, b: bot.blockAt(p.offset(f[0], f[1], f[2])) })).filter((x) => solid(x.b));
      if (!sup.length) { skipped++; continue; }
      if (!(await go(new GoalPlaceBlock(p, bot.world, { range: 4.2 }), false, 1))) { skipped++; continue; }
      const feet = bot.entity.position.floored();
      if (feet.equals(p) || feet.offset(0, 1, 0).equals(p)) { skipped++; continue; }
      try { await bot.equip(it, "hand"); await bot.lookAt(p.offset(0.5, 0.5, 0.5), true); await bot.placeBlock(sup[0].b, new Vec3(-sup[0].f[0], -sup[0].f[1], -sup[0].f[2])); B.done++; B.msg = `Mengisi ${B.done}`; } catch (e) { skipped++; }
    }
    return `selesai mengisi ${B.done} blok${skipped ? `, ${skipped} dilewati` : ""}`;
  }

  const num = (s) => Number(s);
  botState.cmds["/mine"] = (a) => {
    if (!a[0]) return "format: /mine <blok> [jumlah]  contoh: /mine diamond 5, /mine kayu 20";
    const names = resolveBlocks(a[0], registry);
    if (!names.length) return `blok "${a[0]}" tidak dikenal`;
    return botState.cmds.__run(`menambang ${names[0]}`, () => mine(names, Math.max(1, Math.min(256, num(a[1]) || 8))));
  };
  botState.cmds["/bridge"] = (a) => {
    const d = DIRS[String(a[0] || "").toLowerCase()];
    if (!d) return "format: /bridge <n|s|e|w> [panjang]";
    return botState.cmds.__run("jembatan", () => bridge(d, Math.max(1, Math.min(120, num(a[1]) || 10))));
  };
  botState.cmds["/pillar"] = (a) => botState.cmds.__run("menara", () => pillar(Math.max(1, Math.min(60, num(a[0]) || 5))));
  botState.cmds["/tunnel"] = (a) => {
    const d = DIRS[String(a[0] || "").toLowerCase()];
    if (!d) return "format: /tunnel <n|s|e|w> [panjang]";
    return botState.cmds.__run("terowongan", () => tunnel(d, Math.max(1, Math.min(80, num(a[1]) || 12))));
  };
  botState.cmds["/fill"] = (a) => {
    const v = a.slice(0, 6).map(num);
    if (a.length < 7 || v.some((n) => !Number.isFinite(n))) return "format: /fill x1 y1 z1 x2 y2 z2 <blok>";
    return botState.cmds.__run("mengisi " + a[6], () => fill({ x: v[0], y: v[1], z: v[2] }, { x: v[3], y: v[4], z: v[5] }, a[6].replace(/^minecraft:/, "")));
  };
  botState.cmds.__run = run;
  botState.baritoneStop = () => { B.abort = true; };
}

module.exports = { attach, _t: { resolveBlocks, DIRS } };
