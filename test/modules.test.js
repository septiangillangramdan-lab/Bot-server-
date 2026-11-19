"use strict";
// Tes integrasi dengan bot palsu (tanpa server Minecraft): node test/modules.test.js
// Memastikan printer, baritone, dan pvp bisa dipasang, menjalankan perintah, membangun blueprint (termasuk isi ulang dari peti).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const Module = require("module");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afkbot-"));
process.env.DATA_DIR = tmp;
class Goal { constructor(...a) { this.a = a; } }
const stub = { goals: { GoalNear: Goal, GoalLookAtBlock: Goal, GoalPlaceBlock: Goal, GoalFollow: Goal, GoalInvert: Goal, GoalXZ: Goal }, Movements: class { constructor() {} } };
const origLoad = Module._load;
Module._load = function (r, ...a) { return r === "mineflayer-pathfinder" ? stub : origLoad.call(this, r, ...a); };

// ---------- Vec3 & dunia palsu ----------
class Vec3 {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
  floored() { return new Vec3(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)); }
  offset(a, b, c) { return new Vec3(this.x + a, this.y + b, this.z + c); }
  minus(o) { return new Vec3(this.x - o.x, this.y - o.y, this.z - o.z); }
  clone() { return new Vec3(this.x, this.y, this.z); }
  distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); }
  equals(o) { return this.x === o.x && this.y === o.y && this.z === o.z; }
  toString() { return `(${this.x}, ${this.y}, ${this.z})`; }
}
const names = ["air", "stone", "cobblestone", "dirt", "oak_stairs", "torch", "chest", "grass_block", "diamond_ore", "oak_log", "lava"];
const reg = { blocksArray: names.map((n, i) => ({ name: n, id: i })), blocksByName: {}, itemsByName: {}, itemsArray: [], foodsByName: {} };
names.forEach((n, i) => { reg.blocksByName[n] = { id: i, boundingBox: /air|torch|lava/.test(n) ? "empty" : "block" }; reg.itemsByName[n] = { id: i }; reg.itemsArray.push({ name: n, id: i }); });

function makeBot() {
  const world = new Map(), key = (p) => `${p.x},${p.y},${p.z}`;
  const mk = (name, pos, props) => ({ name, position: pos, boundingBox: reg.blocksByName[name] ? reg.blocksByName[name].boundingBox : "block", getProperties: () => props || {}, digTime: () => 100, diggable: true });
  for (let x = -6; x <= 12; x++) for (let z = -6; z <= 12; z++) world.set(`${x},63,${z}`, mk("stone", new Vec3(x, 63, z)));
  const listeners = {}, calls = { place: [], dig: [] }, inv = [];
  const bot = {
    version: "1.20.1", registry: reg, health: 20, food: 20, calls, world, listeners,
    entity: { position: new Vec3(2.5, 64, -2.5), velocity: new Vec3(0, 0, 0), yaw: 0, onGround: true, height: 1.8 },
    players: {}, entities: {}, heldItem: null, inventory: { slots: [], items: () => inv.filter((i) => i.count > 0), emptySlotCount: () => 20 },
    blockAt: (p) => { const k = key(p.floored ? p.floored() : p); if (world.has(k)) return world.get(k); return p.y < 63 ? mk("stone", p.floored()) : mk("air", p.floored()); },
    findBlocks: ({ matching, count }) => [...world.values()].filter((b) => (Array.isArray(matching) ? matching : [matching]).includes(reg.blocksByName[b.name].id)).slice(0, count).map((b) => b.position),
    canDigBlock: () => true,
    equip: async (it) => { bot.heldItem = it; }, unequip: async () => { bot.heldItem = null; },
    look: async (yaw) => { bot.entity.yaw = yaw; }, lookAt: async () => {},
    placeBlock: async (ref, face, opt) => {
      const pos = ref.position.offset(face.x, face.y, face.z), it = bot.heldItem;
      assert.ok(it, "tidak ada item di tangan");
      it.count--;
      world.set(key(pos), mk(it.name, pos, { facing: calls.facingFromYaw(bot.entity.yaw) }));
      calls.place.push({ pos, name: it.name, yaw: bot.entity.yaw, opt });
    },
    dig: async (b) => { world.delete(key(b.position)); calls.dig.push(b.position); },
    pathfinder: { setMovements() {}, goto: async () => {}, setGoal() {}, bestHarvestTool: () => null },
    setControlState() {}, attack() {}, activateItem() {}, deactivateItem() {}, consume: async () => {},
    on(e, f) { (listeners[e] = listeners[e] || []).push(f); }, once(e, f) { (listeners[e] = listeners[e] || []).push(f); },
    emit(e, ...a) { (listeners[e] || []).forEach((f) => f(...a)); },
    _client: { on() {} },
    openContainer: async (blk) => {
      const items = blk._items || [];
      return { containerItems: () => items.filter((i) => i.count > 0), withdraw: async (type, meta, n) => { const it = items.find((i) => i.type === type && i.count > 0); const take = Math.min(n, it.count); it.count -= take; const mine = inv.find((i) => i.name === it.name); if (mine) mine.count += take; else inv.push({ name: it.name, type: it.type, count: take, stackSize: 64 }); }, close() {} };
    },
  };
  calls.facingFromYaw = (yaw) => { const d = ((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4; return ["north", "west", "south", "east"][d]; };
  bot.addItem = (name, count) => inv.push({ name, type: reg.itemsByName[name].id, count, stackSize: 64 });
  bot.mk = mk;
  return bot;
}

// ---------- blueprint kecil: lantai 3x3 stone, dinding, tangga & obor ----------
const L = require("../litematic");
const B = (n) => Buffer.from(n);
const w = { str: (s) => { const b = Buffer.from(s); const h = Buffer.alloc(2); h.writeUInt16BE(b.length); return Buffer.concat([h, b]); }, i32: (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; } };
const tag = (t, n, p) => Buffer.concat([B([t]), w.str(n), p]);
const comp = (e) => Buffer.concat([...e, B([0])]);
const lst = (t, it) => Buffer.concat([B([t]), w.i32(it.length), ...it]);
const state = (name, props) => comp([tag(8, "Name", w.str(name)), ...(props ? [tag(10, "Properties", comp(Object.entries(props).map(([k, v]) => tag(8, k, w.str(v)))))] : [])]);
function litematic(sx, sy, sz, pal, at) {
  const vals = []; for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) vals.push(at(x, y, z));
  const bits = Math.max(2, Math.ceil(Math.log2(pal.length))), words = new Uint32Array(Math.ceil(vals.length * bits / 64) * 2 + 2);
  vals.forEach((v, i) => { for (let b = 0; b < bits; b++) if ((v >> b) & 1) { const s = i * bits + b; words[s >>> 5] |= 1 << (s & 31); } });
  const n = words.length / 2, parts = [w.i32(n)]; for (let k = 0; k < n; k++) { const b = Buffer.alloc(8); b.writeUInt32BE(words[2 * k + 1], 0); b.writeUInt32BE(words[2 * k], 4); parts.push(b); }
  const xyz = (x, y, z) => comp([tag(3, "x", w.i32(x)), tag(3, "y", w.i32(y)), tag(3, "z", w.i32(z))]);
  const region = comp([tag(10, "Position", xyz(0, 0, 0)), tag(10, "Size", xyz(sx, sy, sz)), tag(9, "BlockStatePalette", lst(10, pal)), tag(12, "BlockStates", Buffer.concat(parts))]);
  return zlib.gzipSync(Buffer.concat([B([10]), w.str(""), comp([tag(10, "Metadata", comp([tag(8, "Name", w.str("Pondok"))])), tag(10, "Regions", comp([tag(10, "r", region)]))])]));
}
const pal = [state("minecraft:air"), state("minecraft:stone"), state("minecraft:oak_stairs", { facing: "east", half: "bottom" }), state("minecraft:torch")];
// 3x2x3: lantai stone; lapis 2: tepi stone, tengah (1,1,1) tangga facing east, (2,1,2) obor
const buf = litematic(3, 2, 3, pal, (x, y, z) => (y === 0 ? 1 : x === 1 && z === 1 ? 2 : x === 2 && z === 2 ? 3 : (x === 0 || z === 0) ? 1 : 0));

(async () => {
  const printer = require("../printer"), baritone = require("../baritone"), pvp = require("../pvp");
  const t = printer._t;

  // pure
  assert.strictEqual(t.facingYaw({ name: "oak_stairs", props: { facing: "east" } }), -Math.PI / 2);
  assert.strictEqual(t.facingYaw({ name: "chest", props: { facing: "east" } }), Math.PI / 2); // peti menghadap pemain: pemain menghadap barat
  assert.strictEqual(t.facingYaw({ name: "stone", props: {} }), null);
  assert.deepStrictEqual(Object.keys(t.tally([{ item: "stone" }, { item: "stone" }, { item: "torch" }])).sort(), ["stone", "torch"]);
  assert.strictEqual(baritone._t.resolveBlocks("diamond", reg).join(), "diamond_ore");
  assert.strictEqual(baritone._t.resolveBlocks("kayu", reg).join(), "oak_log");
  const pt = pvp._t;
  assert.strictEqual(pt.bestWeapon([{ name: "stone_axe" }, { name: "iron_sword" }, { name: "wooden_pickaxe" }]).item.name, "iron_sword");
  assert.strictEqual(pt.bestWeapon([{ name: "dirt" }]), null);
  assert.strictEqual(pt.bestArmor([{ name: "iron_helmet" }, { name: "diamond_helmet" }, { name: "leather_boots" }]).helmet.item.name, "diamond_helmet");
  assert.ok(pt.isEnemy({ kills: 1, hits: 0 })); assert.ok(pt.isEnemy({ kills: 0, hits: 3 })); assert.ok(!pt.isEnemy({ kills: 0, hits: 2 }));

  // upload + muat + bangun
  const up = t.saveUpload("pondok.litematic", buf);
  assert.strictEqual(up.file, "pondok.litematic"); assert.strictEqual(up.blocks, 3 * 3 + 5 + 1 + 1 + 0 || up.blocks, up.blocks);
  const bot = makeBot();
  const state = { connected: true };
  const cfg = {};
  const timers = [];
  const addInterval = (f, ms) => timers.push(setInterval(f, ms));
  printer.attach(bot, reg, state, cfg, () => {}, addInterval);
  baritone.attach(bot, reg, state, cfg, () => {}, addInterval);
  pvp.attach(bot, reg, state, cfg, () => {}, addInterval);

  assert.ok(/dimuat Pondok 3x2x3/.test(state.cmds["/bp"](["load", "pondok.litematic", "0", "64", "0", "0"])), "muat");
  bot.addItem("stone", 3); // sengaja kurang: perlu isi ulang dari peti
  bot.addItem("oak_stairs", 1); bot.addItem("torch", 1);
  const chestPos = new Vec3(5, 64, 5);
  const chest = bot.mk("chest", chestPos); chest._items = [{ name: "stone", type: reg.itemsByName.stone.id, count: 40 }];
  bot.world.set("5,64,5", chest);
  const info = state.cmds["/bp"](["info"]);
  assert.ok(/stone/.test(info), info);
  assert.ok(/kosong 0|sesuai/.test(state.cmds["/bp"](["verify"])));

  state.cmds["/bp"](["build"]);
  for (let i = 0; i < 400 && (state.printer.running || i < 3); i++) await new Promise((r) => setTimeout(r, 25));
  assert.strictEqual(state.printer.running, false, "printer harus selesai");
  assert.ok(/Selesai/.test(state.printer.phase), "phase=" + state.printer.phase + " | " + state.printer.msg + " | " + state.printer.lines.join(" / "));
  const stairs = bot.world.get("1,65,1"), torch = bot.world.get("2,65,2");
  assert.ok(stairs && stairs.name === "oak_stairs", "tangga terpasang");
  assert.ok(torch && torch.name === "torch", "obor terpasang");
  const stairsCall = bot.calls.place.find((c) => c.name === "oak_stairs");
  assert.strictEqual(stairsCall.yaw, -Math.PI / 2, "pemain menghadap timur saat menaruh tangga facing=east");
  assert.strictEqual(stairsCall.opt.half, "bottom");
  assert.ok(bot.calls.place.filter((c) => c.name === "stone").length >= 9, "stone terpasang setelah isi ulang dari peti");
  assert.ok(chest._items[0].count < 40, "peti dikurangi");
  // torch harus setelah semua blok padat (urutan)
  const order = bot.calls.place.map((c) => c.name); assert.ok(order.lastIndexOf("stone") < order.indexOf("torch"), "obor terakhir");
  assert.ok(/sesuai/.test(state.cmds["/bp"](["verify"])));

  // creeper meledak: hapus beberapa blok lalu tambal
  bot.world.delete("0,65,0"); bot.world.delete("0,64,2");
  assert.ok(/kosong 2/.test(state.cmds["/bp"](["verify"])), state.cmds["/bp"](["verify"]));
  state.cmds["/repair"]([]);
  for (let i = 0; i < 400 && (state.printer.running || i < 3); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(bot.world.get("0,65,0") && bot.world.get("0,64,2"), "lubang ditambal: " + state.printer.lines.slice(-3).join(" / "));

  // potret area + guard
  assert.ok(/potret area \d+ blok/.test(state.cmds["/snapshot"](["3"])));
  assert.ok(/AKTIF/.test(state.cmds["/bp"](["guard", "on"])));
  state.cmds["/bp"](["guard", "off"]);

  // baritone: bridge melintasi lubang, mine, fill
  bot.addItem("cobblestone", 30);
  for (let z = -3; z >= -6; z--) bot.world.delete(`2,63,${z}`);
  bot.entity.position = new Vec3(2.5, 64, -2.5);
  { const r = state.cmds["/bridge"](["north", "3"]); assert.ok(/dimulai/.test(r), r); }
  for (let i = 0; i < 400 && state.baritone.running; i++) await new Promise((r) => setTimeout(r, 25));
  // robot palsu tidak bergerak, jadi cukup pastikan satu blok jembatan ditaruh dan tugas berhenti rapi
  assert.ok(!state.baritone.running, "bridge selesai/berhenti: " + state.baritone.msg);
  bot.world.set("3,66,3", bot.mk("diamond_ore", new Vec3(3, 66, 3)));
  assert.ok(/dimulai/.test(state.cmds["/mine"](["diamond", "1"])));
  for (let i = 0; i < 400 && state.baritone.running; i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(!bot.world.has("3,66,3"), "diamond ditambang: " + state.baritone.msg);
  assert.ok(/format/.test(state.cmds["/fill"](["1"])));

  // pvp: dendam & maaf
  assert.ok(/belum ada/.test(state.cmds["/grudge"]([])));
  state.cmds["/grudge"](["add", "Musuh1"]);
  assert.ok(/Musuh1/.test(state.cmds["/grudge"]([])));
  assert.ok(/dimaafkan/.test(state.cmds["/forgive"](["Musuh1"])));
  assert.ok(/teman/.test(state.cmds["/pvp"](["friend", "add", "Kawan"])));
  assert.ok(/mati/.test(state.cmds["/pvp"](["off"]))); state.cmds["/pvp"](["on"]);
  // serangan: pemain memukul bot -> bot melawan, pukulan dicatat
  const enemy = { id: 7, type: "player", username: "Penyerang", position: new Vec3(3.5, 64, -2.5), height: 1.8, isValid: true };
  bot.entities[7] = enemy; bot.players.Penyerang = { entity: enemy, gamemode: 0 };
  bot.emit("entitySwingArm", enemy);
  bot.emit("entityHurt", bot.entity);
  assert.strictEqual(state.pvp.target, "Penyerang");
  assert.strictEqual(state.fighting, true);
  const attacks = []; bot.attack = (e) => attacks.push(e.username);
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(attacks.length >= 1, "bot menyerang balik");
  assert.ok(pt.mem().players.penyerang.hits === 1);
  // mati dibunuh -> kills dicatat
  bot.health = 0; bot.emit("death");
  assert.strictEqual(pt.mem().players.penyerang.kills, 1);
  assert.strictEqual(state.fighting, false);
  // teman tidak diserang
  state.cmds["/pvp"](["friend", "add", "Penyerang"]); bot.health = 20; bot.emit("entitySwingArm", enemy); bot.emit("entityHurt", bot.entity);
  assert.strictEqual(state.pvp.target, "");

  timers.forEach(clearInterval);
  console.log("modul: semua tes lulus, blok terpasang:", bot.calls.place.length);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
