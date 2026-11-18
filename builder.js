"use strict";
// Pembangun otonom. Alur: rancang (Claude API) -> pilih lahan -> kumpulkan bahan & crafting -> bangun.
// Bot memutuskan sendiri desain, lokasi, dan bahan. Hanya bangunan statis dari blok biasa
// (tanpa air, lava, redstone, pintu, tangga) karena orientasi blok khusus tidak bisa dijamin.
const { goals, Movements } = require("mineflayer-pathfinder");
const { GoalNear, GoalLookAtBlock, GoalPlaceBlock } = goals;
const human = require("./human");

const LIMITS = { maxW: 13, maxD: 13, maxH: 6, maxBlocks: 450, radius: 22, maxClear: 140 };
const AIR = /^(air|cave_air|void_air)$/;
const REPLACEABLE = /^(short_grass|grass|tall_grass|fern|large_fern|snow|vine|dead_bush|seagrass|tall_seagrass)$/;
const FOLIAGE = /_leaves$|_log$|_wood$|^vine$|mushroom_block/;
const GRAVITY = /^(sand|red_sand|gravel|[a-z_]+_concrete_powder)$/;
const FACES = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// bahan yang bisa didapat bot sendiri: planks/log dari pohon, batu dari tambang, tanah, dan hasil crafting sederhana
const obtainKind = (n) => /_planks$/.test(n) ? "planks" : /_log$/.test(n) ? "log" : /^(cobblestone|andesite|diorite|granite)$/.test(n) ? "stone" : n === "dirt" ? "dirt" : /^(crafting_table|chest|furnace)$/.test(n) ? "craft" : null;
const MINE_FROM = { cobblestone: ["stone", "cobblestone"], andesite: ["andesite"], diorite: ["diorite"], granite: ["granite"], dirt: ["dirt", "grass_block"] };

// ---------- fungsi murni (mudah diuji) ----------
function mainWood(inventory, treeLogs) {
  const pick = (names) => { const c = {}; names.forEach((n) => (c[n] = (c[n] || 0) + 1)); return Object.keys(c).sort((a, b) => c[b] - c[a])[0]; };
  const inv = Object.keys(inventory).filter((n) => /_planks$|_log$/.test(n)).map((n) => n.replace(/_planks$|_log$/, ""));
  return pick(inv.length ? inv : (treeLogs || []).map((n) => n.replace(/_log$/, ""))) || "oak";
}

// Ubah palet rancangan menjadi blok yang benar-benar bisa didapat bot. Mengembalikan {name, note}
function resolveBlock(name, ctx) {
  const inv = ctx.inventory || {}, wood = ctx.wood || "oak", has = (n) => ctx.registry.blocksByName[n] && ctx.registry.itemsByName[n];
  if (!name || AIR.test(name)) return { name: null };
  if (/^(stone|stone_bricks|smooth_stone|cobbled_deepslate|deepslate|deepslate_bricks|bricks|sandstone|smooth_sandstone|blackstone)$/.test(name) && !(inv[name] > 0)) return { name: "cobblestone", note: `${name} -> cobblestone` };
  if (inv[name] > 0 && has(name) && !GRAVITY.test(name)) return { name };
  if (/_planks$/.test(name)) { const n = `${wood}_planks`; return n === name ? { name } : { name: n, note: `${name} -> ${n} (kayu yang tersedia)` }; }
  if (/_log$/.test(name)) return { name: `${wood}_log`, note: name === `${wood}_log` ? undefined : `${name} -> ${wood}_log` };
  if (obtainKind(name)) return { name };
  if (/glass|pane/.test(name)) return { name: null, note: `${name} -> dikosongkan (tidak punya kaca)` };
  if (/torch|lantern|door|trapdoor|stairs|slab|fence|bed|sign|ladder|button|pressure|water|lava|redstone|hopper|rail/.test(name)) return { name: null, note: `${name} dilewati (tidak didukung)` };
  return { name: `${wood}_planks`, note: `${name} -> ${wood}_planks` };
}

// rancangan JSON -> daftar blok relatif {x,y,z,name}; layers[y][z] = string sepanjang x, '.' = kosong
function parseBlueprint(raw, ctx) {
  let t = String(raw || "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("rancangan bukan JSON");
  const bp = JSON.parse(t.slice(a, b + 1));
  if (!bp.palette || typeof bp.palette !== "object" || !Array.isArray(bp.layers) || !bp.layers.length) throw new Error("rancangan tidak lengkap (palette/layers)");
  const H = bp.layers.length;
  let W = 0, D = 0;
  for (const L of bp.layers) { if (!Array.isArray(L)) throw new Error("layer harus berupa daftar baris"); D = Math.max(D, L.length); for (const row of L) W = Math.max(W, String(row).length); }
  if (W > LIMITS.maxW || D > LIMITS.maxD || H > LIMITS.maxH) throw new Error(`ukuran ${W}x${D}x${H} melebihi batas ${LIMITS.maxW}x${LIMITS.maxD}x${LIMITS.maxH}`);
  const notes = [], map = {};
  for (const [ch, nm] of Object.entries(bp.palette)) { const r = resolveBlock(String(nm), ctx); map[ch] = r.name; if (r.note) notes.push(r.note); }
  const blocks = [];
  bp.layers.forEach((L, y) => L.forEach((row, z) => { for (let x = 0; x < String(row).length; x++) { const ch = String(row)[x]; if (ch === "." || ch === " ") continue; if (!(ch in map)) throw new Error(`karakter '${ch}' tidak ada di palette`); if (map[ch]) blocks.push({ x, y, z, name: map[ch] }); } }));
  if (!blocks.length) throw new Error("rancangan kosong");
  if (blocks.length > LIMITS.maxBlocks) throw new Error(`terlalu banyak blok (${blocks.length} > ${LIMITS.maxBlocks})`);
  return { name: String(bp.name || "Bangunan").slice(0, 60), description: String(bp.description || "").slice(0, 300), notes: notes.concat(bp.notes ? [String(bp.notes).slice(0, 200)] : []), size: { w: W, d: D, h: H }, blocks };
}

const tally = (blocks) => { const c = {}; blocks.forEach((b) => (c[b.name] = (c[b.name] || 0) + 1)); return c; };

// cari lahan paling datar & dekat; mengembalikan {x0,z0,gy,clear} (gy = y lantai pertama)
function findSite(bot, size, opts) {
  const R = (opts && opts.radius) || LIMITS.radius, Vec3 = bot.entity.position.constructor;
  const px = Math.floor(bot.entity.position.x), py = Math.floor(bot.entity.position.y), pz = Math.floor(bot.entity.position.z);
  const cache = new Map();
  const col = (x, z) => {
    const k = x + "," + z;
    if (cache.has(k)) return cache.get(k);
    let r = { bad: true };
    for (let y = py + 12; y >= py - 14; y--) {
      const b = bot.blockAt(new Vec3(x, y, z));
      if (!b) { r = { bad: true }; break; }
      if (AIR.test(b.name) || REPLACEABLE.test(b.name)) continue;
      if (/lava|water|ice/.test(b.name)) { r = { bad: true }; break; }
      if (FOLIAGE.test(b.name)) { r = { bad: false, tree: true, y: null, top: y }; continue; } // pohon: lanjut cari tanah di bawahnya
      if (b.boundingBox !== "block") continue;
      r = { bad: false, y, tree: r.tree ? true : false, top: r.top || y };
      break;
    }
    cache.set(k, r);
    return r;
  };
  let best = null;
  for (let x0 = px - R; x0 <= px + R - size.w; x0 += 2) {
    for (let z0 = pz - R; z0 <= pz + R - size.d; z0 += 2) {
      let min = 1e9, max = -1e9, bad = false, trees = 0;
      for (let x = x0; x < x0 + size.w && !bad; x++) for (let z = z0; z < z0 + size.d; z++) {
        const c = col(x, z);
        if (c.bad || c.y == null) { bad = true; break; }
        if (c.tree) trees++;
        min = Math.min(min, c.y); max = Math.max(max, c.y);
      }
      if (bad || max - min > 2) continue;
      const clear = trees * 3 + (max - min) * size.w * size.d * 0.3;
      if (clear > LIMITS.maxClear) continue;
      const dx = x0 + size.w / 2 - px, dz = z0 + size.d / 2 - pz;
      const score = (max - min) * 6 + clear * 0.4 + Math.hypot(dx, dz) * 0.3;
      if (!best || score < best.score) best = { x0, z0, gy: max + 1, score, clear };
    }
  }
  return best;
}

function plannerPrompts(goal, ctx) {
  const inv = Object.entries(ctx.inventory).map(([k, v]) => `${k} x${v}`).join(", ") || "(kosong)";
  const system = `You design small static Minecraft structures that a survival bot can build block by block. Answer with ONE JSON object only, no prose, no markdown.
Schema: {"name":string,"description":string,"notes":string,"palette":{"<char>":"<minecraft_block_id>"},"layers":[[ "row", ... ], ...]}
- layers[0] is the floor level, layers[y] is y blocks above it. Each layer is a list of rows (z axis, north to south); each row is a string along the x axis (west to east). "." means empty.
- Footprint max ${LIMITS.maxW}x${LIMITS.maxD}, height max ${LIMITS.maxH} layers, max ${LIMITS.maxBlocks} solid blocks in total. Prefer compact, sturdy, good-looking designs.
- Use ONLY these block ids: any <wood>_planks, any <wood>_log, cobblestone, andesite, diorite, granite, dirt, crafting_table, chest, furnace, plus these inventory items if they are full blocks: ${inv}.
- Do NOT use water, lava, redstone, doors, trapdoors, stairs, slabs, fences, beds, signs, torches, ladders, hoppers, glass (unless in inventory). Leave a 1-wide, 2-high empty doorway; leave 1x1 empty gaps as windows.
- Everything must be connected so each block touches the ground or another block (build outward from the floor). Make rooms walkable inside (2 blocks of headroom).
- If the request needs mechanics that are impossible with plain blocks (farms needing water, XP/mob farms, redstone), design the best purely static approximation (platforms, pens, walls, towers, shelters) and explain the limitation in "notes".`;
  const user = `Request from the owner: "${goal}"\nWood available nearby: ${ctx.wood}. Bot inventory: ${inv}.\nReturn the JSON object now.`;
  return { system, user };
}

async function callClaude(system, user) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY belum diisi (Railway → Variables)");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5", max_tokens: 6000, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  return (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
}
// OpenAI (atau layanan yang kompatibel, mis. OpenRouter/Groq lewat OPENAI_BASE_URL)
async function callOpenAI(system, user) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY belum diisi (Railway → Variables)");
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const res = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify(Object.assign(
      { model: process.env.OPENAI_MODEL || "gpt-4o", max_completion_tokens: Number(process.env.OPENAI_MAX_TOKENS) || 12000, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content: user }] },
      process.env.OPENAI_REASONING ? { reasoning_effort: process.env.OPENAI_REASONING } : {} // opsional: low | medium | high | none
    )),
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
}
// penyedia: AI_PROVIDER=openai|anthropic; bila kosong, pakai yang kuncinya terisi (Anthropic diutamakan)
function provider() {
  const p = String(process.env.AI_PROVIDER || "").toLowerCase();
  if (p === "openai" || p === "anthropic") return p;
  return !process.env.ANTHROPIC_API_KEY && process.env.OPENAI_API_KEY ? "openai" : "anthropic";
}
const hasKey = () => !!(provider() === "openai" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY);
const modelName = () => (provider() === "openai" ? process.env.OPENAI_MODEL || "gpt-4o" : process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5");
let llm = (system, user) => (provider() === "openai" ? callOpenAI(system, user) : callClaude(system, user));

// ---------- per bot ----------
function attach(bot, mcData, botState, config, log, addInterval) {
  const registry = bot.registry || mcData;
  const Vec3 = bot.entity.position.constructor;
  const S = { running: false, abort: false, phase: "Menganggur", msg: "", done: 0, total: 0, plan: null, need: [], origin: null, error: "", lines: [], startedAt: 0 };
  botState.build = S;
  const say = (m) => { S.msg = m; S.lines.push(new Date().toLocaleTimeString("id-ID") + " " + m); if (S.lines.length > 40) S.lines.shift(); log("[Bangun] " + m); };
  const up = () => botState.connected && bot.entity && !S.abort;
  const inv = () => { const c = {}; bot.inventory.items().forEach((i) => (c[i.name] = (c[i.name] || 0) + i.count)); return c; };
  const count = (n) => inv()[n] || 0;
  const items = () => bot.inventory.items();
  const stopCheck = async () => { while (botState.fighting && up()) await sleep(500); if (!up()) throw new Error("dihentikan"); };
  const moveCfg = () => { const m = human.applyMovements(new Movements(bot), registry, false, false); m.allowParkour = false; return m; };
  async function go(goal, tries) {
    for (let i = 0; i < (tries || 2); i++) {
      await stopCheck();
      try { bot.pathfinder.setMovements(moveCfg()); await bot.pathfinder.goto(goal); return true; } catch (e) { if (S.abort) throw new Error("dihentikan"); await sleep(400); }
    }
    return false;
  }
  const solid = (b) => b && b.boundingBox === "block";

  // ----- crafting -----
  async function craft(name, n, table) {
    const it = registry.itemsByName[name];
    if (!it) return false;
    const r = bot.recipesFor(it.id, null, 1, table || null)[0];
    if (!r) return false;
    try { await bot.craft(r, n, table || undefined); return true; } catch (e) { return false; }
  }
  async function ensureTable() {
    const id = registry.blocksByName.crafting_table.id;
    let t = bot.findBlock({ matching: id, maxDistance: 32 });
    if (!t) {
      if (!count("crafting_table")) { await planksFor(4); if (!(await craft("crafting_table", 1))) return null; }
      const feet = bot.entity.position.floored();
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ref = bot.blockAt(feet.offset(dx, -1, dz)), above = bot.blockAt(feet.offset(dx, 0, dz));
        if (solid(ref) && above && AIR.test(above.name)) {
          try { await bot.equip(items().find((i) => i.name === "crafting_table"), "hand"); await bot.placeBlock(ref, new Vec3(0, 1, 0)); break; } catch (e) {}
        }
      }
      t = bot.findBlock({ matching: id, maxDistance: 8 });
    }
    if (!t) return null;
    await go(new GoalNear(t.position.x, t.position.y, t.position.z, 2.5));
    return bot.blockAt(t.position);
  }
  // pastikan ada minimal n planks (dari log yang ada, atau cari log dulu)
  async function planksFor(n) {
    const have = items().filter((i) => /_planks$/.test(i.name)).reduce((s, i) => s + i.count, 0);
    if (have >= n) return true;
    const need = n - have;
    await getMaterial("log", Math.ceil(need / 4));
    for (const l of items().filter((i) => /_log$/.test(i.name))) {
      const w = l.name.replace("_log", "");
      await craft(`${w}_planks`, Math.min(l.count, Math.ceil((n - items().filter((i) => /_planks$/.test(i.name)).reduce((s, i) => s + i.count, 0)) / 4)));
      if (items().filter((i) => /_planks$/.test(i.name)).reduce((s, i) => s + i.count, 0) >= n) break;
    }
    return items().filter((i) => /_planks$/.test(i.name)).reduce((s, i) => s + i.count, 0) >= n;
  }
  async function ensureTool(kind) { // kind: pickaxe
    if (items().some((i) => new RegExp(`_${kind}$`).test(i.name) && /stone|iron|diamond|netherite/.test(i.name))) return true;
    if (items().some((i) => new RegExp(`^wooden_${kind}$`).test(i.name)) && kind !== "pickaxe") return true;
    if (!(await planksFor(8))) return false;
    await craft("stick", 2);
    const table = await ensureTable();
    if (!table) return false;
    if (!items().some((i) => i.name === "wooden_pickaxe") && !(await craft("wooden_pickaxe", 1, table))) return false;
    return true;
  }

  // ----- mengumpulkan -----
  const dropsNear = () => Object.values(bot.entities).filter((e) => e.position && (e.name === "item" || e.objectType === "Item" || e.displayName === "Item") && e.position.distanceTo(bot.entity.position) < 7);
  async function pickup() { for (const e of dropsNear().slice(0, 4)) { await go(new GoalNear(e.position.x, e.position.y, e.position.z, 0.8), 1); } }
  async function mineKind(names, wantCount, itemName, deadline) {
    let got = 0, fails = 0;
    const bad = new Set();
    const ids = names.map((n) => registry.blocksByName[n] && registry.blocksByName[n].id).filter((x) => x != null);
    const before = () => count(itemName);
    const start = before();
    while (up() && before() - start < wantCount && fails < 10 && Date.now() < deadline) {
      await stopCheck();
      const found = bot.findBlocks({ matching: ids, maxDistance: 48, count: 24 }).map((p) => bot.blockAt(p)).filter((b) => b && !bad.has(b.position.toString()) && human.breakable(bot, b) && FACES.some((f) => { const n = bot.blockAt(b.position.offset(...f)); return n && AIR.test(n.name); }));
      if (!found.length) { fails++; const a = Math.random() * 6.28; await go(new GoalNear(bot.entity.position.x + Math.cos(a) * 16, bot.entity.position.y, bot.entity.position.z + Math.sin(a) * 16, 3), 1); continue; }
      found.sort((a, b) => a.position.y - b.position.y || a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
      const t = found[0];
      if (!(await go(new GoalLookAtBlock(t.position, bot.world, { reach: 4 }), 1))) { bad.add(t.position.toString()); fails++; continue; }
      try {
        const tool = bot.pathfinder.bestHarvestTool ? bot.pathfinder.bestHarvestTool(bot.blockAt(t.position)) : null;
        if (tool) await bot.equip(tool, "hand");
        await bot.dig(bot.blockAt(t.position), true);
        await sleep(250); await pickup();
      } catch (e) { bad.add(t.position.toString()); fails++; }
      S.msg = `Mengumpulkan ${itemName} (${before() - start}/${wantCount})`;
    }
    return before() - start >= wantCount;
  }
  async function getMaterial(kind, n) { // kind: log | stone-name | dirt
    const deadline = Date.now() + 8 * 60 * 1000;
    if (kind === "log") return mineKind(registry.blocksArray.filter((b) => /_log$/.test(b.name)).map((b) => b.name), n, items().find((i) => /_log$/.test(i.name)) ? items().find((i) => /_log$/.test(i.name)).name : "oak_log", deadline).catch(() => false);
    return false;
  }
  async function acquire(name, n) {
    const have = count(name);
    if (have >= n) return true;
    const k = obtainKind(name), missing = n - have;
    S.phase = "Mengumpulkan bahan";
    if (k === "planks") { const ok = await planksFor(have + missing); return ok || count(name) >= n; }
    if (k === "log") { await mineKind(registry.blocksArray.filter((b) => /_log$/.test(b.name)).map((b) => b.name), missing, name, Date.now() + 8 * 60000); return count(name) >= n; }
    if (k === "stone") { if (!(await ensureTool("pickaxe"))) return false; await mineKind(MINE_FROM[name], missing, name, Date.now() + 10 * 60000); return count(name) >= n; }
    if (k === "dirt") { await mineKind(MINE_FROM.dirt, missing, "dirt", Date.now() + 5 * 60000); return count(name) >= n; }
    if (k === "craft") {
      if (name === "crafting_table") { await planksFor(4 * missing); return craft(name, missing); }
      await (name === "furnace" ? acquire("cobblestone", 8 * missing) : planksFor(8 * missing));
      const t = await ensureTable();
      return t ? craft(name, missing, t) : false;
    }
    return false;
  }

  // ----- membangun -----
  async function placeOne(p, name) {
    const cur = bot.blockAt(p);
    if (cur && cur.name === name) return "ok";
    if (cur && !AIR.test(cur.name) && !REPLACEABLE.test(cur.name)) {
      if (!human.breakable(bot, cur)) return "blocked";
      await go(new GoalLookAtBlock(p, bot.world, { reach: 4 }), 1);
      try { const tool = bot.pathfinder.bestHarvestTool ? bot.pathfinder.bestHarvestTool(cur) : null; if (tool) await bot.equip(tool, "hand"); await bot.dig(bot.blockAt(p), true); } catch (e) { return "blocked"; }
    }
    const item = items().find((i) => i.name === name);
    if (!item) return "noitem";
    const supports = FACES.map((f) => ({ f, b: bot.blockAt(p.offset(...f)) })).filter((x) => solid(x.b));
    if (!supports.length) return "floating";
    if (!(await go(new GoalPlaceBlock(p, bot.world, { range: 4.2 }), 2))) return "unreachable";
    const feet = bot.entity.position.floored();
    if (feet.equals(p) || feet.offset(0, 1, 0).equals(p)) return "inway";
    const s = supports[0];
    try {
      await bot.equip(item, "hand");
      await bot.lookAt(p.offset(0.5, 0.5, 0.5), true);
      await bot.placeBlock(s.b, new Vec3(-s.f[0], -s.f[1], -s.f[2]));
      return "ok";
    } catch (e) { return "error"; }
  }

  async function run(goal) {
    try {
      S.running = true; S.abort = false; S.error = ""; S.plan = null; S.done = 0; S.total = 0; S.need = []; S.origin = null; S.lines = []; S.startedAt = Date.now();
      botState.task = true;
      // 1. rancang
      S.phase = "Merancang"; say(`Merancang: "${goal}"`);
      const treeLogs = bot.findBlocks({ matching: registry.blocksArray.filter((b) => /_log$/.test(b.name)).map((b) => b.id), maxDistance: 48, count: 30 }).map((p) => (bot.blockAt(p) || {}).name).filter(Boolean);
      const ctx = { registry, inventory: inv(), wood: mainWood(inv(), treeLogs) };
      let bp = null, lastErr = "";
      for (let attempt = 1; attempt <= 2 && !bp; attempt++) {
        const { system, user } = plannerPrompts(goal, ctx);
        const raw = await llm(system, lastErr ? user + `\nYour previous answer was invalid: ${lastErr}. Fix it and return only the JSON.` : user);
        try { bp = parseBlueprint(raw, ctx); } catch (e) { lastErr = e.message; say(`Rancangan ditolak (${e.message})${attempt < 2 ? ", mencoba lagi" : ""}`); }
      }
      if (!bp) throw new Error("gagal mendapat rancangan yang valid: " + lastErr);
      S.plan = { name: bp.name, description: bp.description, notes: bp.notes, size: bp.size, blocks: bp.blocks.length };
      say(`Rancangan: ${bp.name} (${bp.size.w}x${bp.size.d}x${bp.size.h}, ${bp.blocks.length} blok)`);
      bp.notes.forEach((n) => say("Catatan: " + n));

      // 2. lahan
      S.phase = "Mencari lahan";
      const site = findSite(bot, bp.size);
      if (!site) throw new Error("tidak ada lahan datar yang cukup dalam radius " + LIMITS.radius + " blok (pindahkan bot ke area lapang)");
      S.origin = { x: site.x0, y: site.gy, z: site.z0 };
      say(`Lahan dipilih di ${site.x0} ${site.gy} ${site.z0}`);

      // 3. bahan
      const need = tally(bp.blocks);
      const refreshNeed = () => (S.need = Object.entries(need).map(([n, c]) => ({ name: n, need: c, have: count(n) })));
      refreshNeed();
      for (const [name, c] of Object.entries(need)) {
        if (count(name) >= c) continue;
        say(`Butuh ${name}: ${c - count(name)} lagi`);
        const ok = await acquire(name, c);
        refreshNeed();
        if (!ok) say(`Bahan ${name} kurang (${count(name)}/${c}), lanjut dengan yang ada`);
      }

      // 4. bangun
      S.phase = "Membangun";
      const base = new Vec3(site.x0, site.gy, site.z0);
      // pondasi: isi lubang di bawah lantai
      const floorBlocks = bp.blocks.filter((b) => b.y === 0);
      let queue = bp.blocks.slice().sort((a, b) => a.y - b.y || a.z - b.z || (a.z % 2 ? b.x - a.x : a.x - b.x)).map((b) => ({ p: base.offset(b.x, b.y, b.z), name: b.name }));
      for (const fb of floorBlocks) for (let d = 1; d <= 3; d++) { const q = base.offset(fb.x, -d, fb.z), cur = bot.blockAt(q); if (cur && (AIR.test(cur.name) || REPLACEABLE.test(cur.name))) queue.unshift({ p: q, name: fb.name }); else break; }
      queue.sort((a, b) => a.p.y - b.p.y);
      S.total = queue.length;
      const stats = {};
      for (let pass = 1; pass <= 6 && queue.length && up(); pass++) {
        const next = [];
        let progress = 0;
        for (const job of queue) {
          await stopCheck();
          const r = await placeOne(job.p, job.name);
          if (r === "ok") { progress++; S.done++; S.msg = `Membangun ${S.done}/${S.total}`; }
          else { stats[r] = (stats[r] || 0) + 1; next.push(job); if (r === "inway") { await go(new GoalNear(job.p.x + 2, job.p.y, job.p.z + 2, 1), 1); } }
          refreshNeed();
        }
        queue = next;
        if (!progress) break;
        if (queue.length) say(`Putaran ${pass}: sisa ${queue.length} blok, mengulang`);
      }
      S.phase = queue.length ? "Selesai sebagian" : "Selesai";
      say(queue.length ? `Selesai sebagian: ${S.done}/${S.total} blok terpasang (gagal: ${JSON.stringify(stats)})` : `Selesai! ${S.done} blok terpasang`);
    } catch (e) {
      S.error = e.message; S.phase = e.message === "dihentikan" ? "Dihentikan" : "Gagal"; say(`${S.phase}: ${e.message}`);
    } finally {
      S.running = false; botState.task = false;
      try { bot.pathfinder.setGoal(null); } catch (e) {}
    }
  }

  botState.buildStart = (goal) => {
    if (S.running) return "bot masih mengerjakan proyek sebelumnya";
    if (!botState.connected) return "bot belum terhubung";
    run(String(goal || "").trim().slice(0, 300) || "rumah kayu kecil yang nyaman");
    return "dimulai";
  };
  botState.buildStop = () => { S.abort = true; return "menghentikan"; };
  bot.once("end", () => { S.abort = true; });
}

// ---------- API untuk panel ----------
function routes(app, manager, config, addLog) {
  const pick = (id) => manager.list.find((b) => b.id === id && b.botState.connected) || manager.list.find((b) => b.botState.connected);
  app.get("/api/build", (req, res) => {
    const out = manager.list.map((b) => { const s = b.botState.build; return { id: b.id, online: !!b.botState.connected, status: s ? { running: s.running, phase: s.phase, msg: s.msg, done: s.done, total: s.total, plan: s.plan, need: s.need, origin: s.origin, error: s.error, lines: s.lines.slice(-14) } : null }; });
    res.json({ success: true, hasKey: hasKey(), provider: provider(), model: modelName(), bots: out, limits: LIMITS });
  });
  app.post("/api/build/start", (req, res) => {
    const b = pick((req.body || {}).bot);
    if (!b || !b.botState.buildStart) return res.json({ success: false, msg: "Tidak ada bot online" });
    if (!hasKey()) return res.json({ success: false, msg: provider() === "openai" ? "OPENAI_API_KEY belum diisi di Railway (Variables)" : "ANTHROPIC_API_KEY atau OPENAI_API_KEY belum diisi di Railway (Variables)" });
    const r = b.botState.buildStart((req.body || {}).goal);
    addLog(`[Bangun] Perintah: "${String((req.body || {}).goal || "").slice(0, 80)}" -> ${r}`);
    res.json({ success: r === "dimulai", msg: r, bot: b.id });
  });
  app.post("/api/build/stop", (req, res) => {
    manager.list.forEach((b) => b.botState.buildStop && b.botState.buildStop());
    res.json({ success: true });
  });
}

module.exports = { attach, routes, _t: { callOpenAI, provider, hasKey, modelName, parseBlueprint, resolveBlock, tally, findSite, mainWood, plannerPrompts, setLLM: (f) => { llm = f; }, LIMITS } };
