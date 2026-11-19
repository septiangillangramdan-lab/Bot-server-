"use strict";
// Pembaca blueprint ("hologram") untuk bot: .litematic (Litematica), .schem (Sponge v2/v3) dan .nbt struktur.
// Tanpa dependensi luar: hanya zlib bawaan Node. Hasilnya daftar blok relatif {x,y,z,name,props}.
const zlib = require("zlib");

// ---------- NBT ----------
function readNbt(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  let o = 0;
  const u8 = () => buf[o++];
  const i16 = () => { const v = buf.readInt16BE(o); o += 2; return v; };
  const i32 = () => { const v = buf.readInt32BE(o); o += 4; return v; };
  const str = () => { const n = buf.readUInt16BE(o); o += 2; const s = buf.toString("utf8", o, o + n); o += n; return s; };
  function payload(t) {
    switch (t) {
      case 1: return buf.readInt8(o++);
      case 2: return i16();
      case 3: return i32();
      case 4: { const v = buf.readBigInt64BE(o); o += 8; return v; }
      case 5: { const v = buf.readFloatBE(o); o += 4; return v; }
      case 6: { const v = buf.readDoubleBE(o); o += 8; return v; }
      case 7: { const n = i32(); const v = buf.subarray(o, o + n); o += n; return v; }
      case 8: return str();
      case 9: { const it = u8(), n = i32(), a = []; for (let k = 0; k < n; k++) a.push(payload(it)); return a; }
      case 10: { const c = {}; for (;;) { const tt = u8(); if (tt === 0) break; const nm = str(); c[nm] = payload(tt); } return c; }
      case 11: { const n = i32(), a = new Int32Array(n); for (let k = 0; k < n; k++) a[k] = i32(); return a; }
      case 12: { // long array -> pasangan Uint32 little-endian (lo, hi) agar mudah dibaca bit demi bit
        const n = i32(), a = new Uint32Array(n * 2);
        for (let k = 0; k < n; k++) { a[k * 2 + 1] = buf.readUInt32BE(o); a[k * 2] = buf.readUInt32BE(o + 4); o += 8; }
        return a;
      }
      default: throw new Error("tag NBT tidak dikenal: " + t);
    }
  }
  const t = u8();
  if (t !== 10) throw new Error("bukan file NBT yang valid");
  str();
  return payload(10);
}

// ---------- utilitas ----------
const bareName = (n) => String(n || "").replace(/^minecraft:/, "");
const AIRRE = /^(air|cave_air|void_air|structure_void)$/;
const MAX_BLOCKS = 400000;

// baca `bits` bit (<=32) mulai dari bit ke-`s` pada aliran kata 32-bit little-endian
function readBits(words, s, bits) {
  const w = s >>> 5, o = s & 31;
  let v = words[w] >>> o;
  if (o + bits > 32) v = (v | (words[w + 1] << (32 - o))) >>> 0;
  return bits === 32 ? v >>> 0 : v & ((1 << bits) - 1);
}

function parseState(str) { // "minecraft:oak_stairs[facing=north,half=bottom]"
  const m = /^([^\[]+)(?:\[(.*)\])?$/.exec(String(str));
  const props = {};
  if (m[2]) for (const kv of m[2].split(",")) { const [k, v] = kv.split("="); if (k) props[k] = v; }
  return { name: bareName(m[1]), props };
}

// ---------- .litematic ----------
function fromLitematic(root, fileName) {
  const regions = root.Regions;
  if (!regions) throw new Error("file litematic tidak punya Regions");
  const list = [];
  for (const [rname, r] of Object.entries(regions)) {
    const sz = r.Size, ps = r.Position;
    const ax = Math.abs(sz.x), ay = Math.abs(sz.y), az = Math.abs(sz.z);
    const minX = ps.x + (sz.x < 0 ? sz.x + 1 : 0), minY = ps.y + (sz.y < 0 ? sz.y + 1 : 0), minZ = ps.z + (sz.z < 0 ? sz.z + 1 : 0);
    const pal = (r.BlockStatePalette || []).map((e) => ({ name: bareName(e.Name), props: e.Properties || {} }));
    const bits = Math.max(2, Math.ceil(Math.log2(Math.max(pal.length, 1))));
    const words = r.BlockStates;
    if (!words) throw new Error("region " + rname + " tanpa BlockStates");
    if (ax * ay * az > 4000000) throw new Error("region terlalu besar");
    const blocks = [];
    let idx = 0;
    for (let y = 0; y < ay; y++) for (let z = 0; z < az; z++) for (let x = 0; x < ax; x++, idx++) {
      const e = pal[readBits(words, idx * bits, bits)];
      if (!e || AIRRE.test(e.name)) continue;
      blocks.push({ x: minX + x, y: minY + y, z: minZ + z, name: e.name, props: e.props });
    }
    list.push({ rname, blocks });
  }
  const meta = root.Metadata || {};
  return { name: meta.Name || fileName || "blueprint", author: meta.Author || "", blocks: [].concat(...list.map((l) => l.blocks)) };
}

// ---------- Sponge .schem (v2 / v3) ----------
function fromSponge(root, fileName) {
  const s = root.Schematic || root;
  const W = s.Width, H = s.Height, L = s.Length;
  const palObj = (s.Blocks && s.Blocks.Palette) || s.Palette;
  const data = (s.Blocks && s.Blocks.Data) || s.BlockData;
  if (!palObj || !data) throw new Error("schem tanpa Palette/BlockData");
  const pal = []; for (const [k, v] of Object.entries(palObj)) pal[v] = parseState(k);
  const blocks = [];
  let p = 0, idx = 0;
  const total = W * H * L;
  while (idx < total && p < data.length) {
    let v = 0, sh = 0, b;
    do { b = data[p++]; v |= (b & 0x7f) << sh; sh += 7; } while (b & 0x80);
    const e = pal[v];
    if (e && !AIRRE.test(e.name)) {
      const x = idx % W, z = Math.floor(idx / W) % L, y = Math.floor(idx / (W * L));
      blocks.push({ x, y, z, name: e.name, props: e.props });
    }
    idx++;
  }
  return { name: fileName || "schem", author: "", blocks };
}

// ---------- struktur vanilla (.nbt) ----------
function fromStructure(root, fileName) {
  const pal = (root.palette || []).map((e) => ({ name: bareName(e.Name), props: e.Properties || {} }));
  const blocks = [];
  for (const b of root.blocks || []) {
    const e = pal[b.state];
    if (!e || AIRRE.test(e.name)) continue;
    blocks.push({ x: b.pos[0], y: b.pos[1], z: b.pos[2], name: e.name, props: e.props });
  }
  return { name: fileName || "struktur", author: "", blocks };
}

// ---------- titik masuk ----------
function parse(buf, fileName) {
  const root = readNbt(buf);
  const base = String(fileName || "").replace(/\.(litematic|schem|schematic|nbt)$/i, "");
  let bp;
  if (root.Regions) bp = fromLitematic(root, base);
  else if (root.Schematic || root.BlockData || root.Palette) bp = fromSponge(root, base);
  else if (root.palette && root.blocks) bp = fromStructure(root, base);
  else throw new Error("format tidak dikenal (butuh .litematic, .schem atau struktur .nbt)");
  if (!bp.blocks.length) throw new Error("blueprint kosong");
  if (bp.blocks.length > MAX_BLOCKS) throw new Error(`blueprint terlalu besar (${bp.blocks.length} blok, batas ${MAX_BLOCKS})`);
  return normalize(bp);
}

function normalize(bp) {
  let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
  for (const b of bp.blocks) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); z0 = Math.min(z0, b.z); x1 = Math.max(x1, b.x); y1 = Math.max(y1, b.y); z1 = Math.max(z1, b.z); }
  for (const b of bp.blocks) { b.x -= x0; b.y -= y0; b.z -= z0; }
  bp.size = { x: x1 - x0 + 1, y: y1 - y0 + 1, z: z1 - z0 + 1 };
  return bp;
}

// ---------- rotasi (searah jarum jam, kelipatan 90 derajat) ----------
const CW = { north: "east", east: "south", south: "west", west: "north" };
function rotProps(props, turns) {
  const p = { ...props };
  for (let t = 0; t < turns; t++) {
    const q = { ...p };
    if (p.facing && CW[p.facing]) q.facing = CW[p.facing];
    if (p.axis === "x") q.axis = "z"; else if (p.axis === "z") q.axis = "x";
    if (p.rotation != null && /^\d+$/.test(p.rotation)) q.rotation = String((Number(p.rotation) + 4) % 16);
    const dirs = ["north", "east", "south", "west"].filter((d) => d in p); // pagar, kaca, tembok, vine
    for (const d of dirs) delete q[d];
    for (const d of dirs) q[CW[d]] = p[d];
    for (const k of Object.keys(p)) delete p[k];
    Object.assign(p, q);
  }
  return p;
}
function rotate(bp, turns) {
  turns = ((turns % 4) + 4) % 4;
  if (!turns) return bp;
  let W = bp.size.x, D = bp.size.z, blocks = bp.blocks;
  for (let t = 0; t < turns; t++) {
    blocks = blocks.map((b) => ({ ...b, x: D - 1 - b.z, z: b.x }));
    [W, D] = [D, W];
  }
  return { ...bp, size: { x: W, y: bp.size.y, z: D }, blocks: blocks.map((b) => ({ ...b, props: rotProps(b.props, turns) })) };
}

// ---------- item pengganti & blok yang tidak ditaruh sendiri ----------
// bagian kedua dari blok dua-bagian dan blok teknis tidak ditaruh langsung
function isSecondary(b) {
  const p = b.props || {};
  if (/_door$/.test(b.name) && p.half === "upper") return true;
  if (/_bed$/.test(b.name) && p.part === "head") return true;
  if (/^(tall_grass|large_fern|sunflower|lilac|rose_bush|peony|tall_seagrass)$/.test(b.name) && p.half === "upper") return true;
  if (b.name === "piston_head" || b.name === "moving_piston") return true;
  if (/^(water|lava|bubble_column|fire|soul_fire|nether_portal|end_portal|end_gateway|frosted_ice|bedrock|barrier|light)$/.test(b.name)) return true;
  if (/^(chest|trapped_chest)$/.test(b.name) && (p.type === "left" || p.type === "right")) return false; // peti ganda: dua peti terpisah
  return false;
}
const ITEM_OF = [
  [/^wall_torch$/, "torch"], [/^soul_wall_torch$/, "soul_torch"], [/^redstone_wall_torch$/, "redstone_torch"],
  [/^(.+)_wall_sign$/, "$1_sign"], [/^(.+)_wall_hanging_sign$/, "$1_hanging_sign"], [/^(.+)_wall_banner$/, "$1_banner"],
  [/^(.+)_wall_head$/, "$1_head"], [/^(.+)_wall_skull$/, "$1_skull"], [/^redstone_wire$/, "redstone"], [/^tripwire$/, "string"],
  [/^potted_.+$/, "flower_pot"], [/^(water_)?cauldron$|^lava_cauldron$|^powder_snow_cauldron$/, "cauldron"],
  [/^kelp_plant$/, "kelp"], [/^carrots$/, "carrot"], [/^potatoes$/, "potato"], [/^beetroots$/, "beetroot_seeds"], [/^wheat$/, "wheat_seeds"],
  [/^sweet_berry_bush$/, "sweet_berries"], [/^cocoa$/, "cocoa_beans"], [/^bamboo_sapling$/, "bamboo"], [/^cave_vines(_plant)?$/, "glow_berries"],
  [/^(weeping|twisting)_vines_plant$/, "$1_vines"], [/^pumpkin_stem$|^attached_pumpkin_stem$/, "pumpkin_seeds"], [/^melon_stem$|^attached_melon_stem$/, "melon_seeds"],
  [/^big_dripleaf_stem$/, "big_dripleaf"], [/^lava$/, "lava_bucket"], [/^water$/, "water_bucket"],
];
function itemFor(name) {
  for (const [re, to] of ITEM_OF) if (re.test(name)) return name.replace(re, to);
  return name;
}

// daftar bahan: item -> jumlah (peti dihitung per blok, slab dobel dihitung 2)
function materials(blocks) {
  const m = {};
  for (const b of blocks) {
    if (isSecondary(b)) continue;
    const it = itemFor(b.name);
    m[it] = (m[it] || 0) + (b.props && b.props.type === "double" && /_slab$/.test(b.name) ? 2 : 1);
  }
  return m;
}

// satu lapisan (y) untuk pratinjau di panel: grid z x x berisi indeks palet
function layer(bp, y) {
  const names = [], idx = new Map(), rows = [];
  for (let z = 0; z < bp.size.z; z++) rows.push(new Array(bp.size.x).fill(-1));
  for (const b of bp.blocks) {
    if (b.y !== y) continue;
    let i = idx.get(b.name);
    if (i == null) { i = names.length; names.push(b.name); idx.set(b.name, i); }
    rows[b.z][b.x] = i;
  }
  return { y, names, rows };
}

module.exports = { parse, readNbt, rotate, materials, itemFor, isSecondary, layer, parseState, readBits, normalize, MAX_BLOCKS };
