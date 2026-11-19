"use strict";
// Tes mandiri (tanpa mineflayer): node test/litematic.test.js
const assert = require("assert");
const zlib = require("zlib");
const L = require("../litematic");

// --- penulis NBT minimal untuk membuat fixture ---
const B = (n) => Buffer.from(n);
const w = {
  str: (s) => { const b = Buffer.from(s, "utf8"); const h = Buffer.alloc(2); h.writeUInt16BE(b.length); return Buffer.concat([h, b]); },
  i32: (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; },
};
const tag = (type, name, payload) => Buffer.concat([B([type]), w.str(name), payload]);
const compound = (entries) => Buffer.concat([...entries, B([0])]);
const list = (type, items) => Buffer.concat([B([type]), w.i32(items.length), ...items]);
const longArr = (words) => { const n = words.length / 2; const parts = [w.i32(n)]; for (let k = 0; k < n; k++) { const b = Buffer.alloc(8); b.writeUInt32BE(words[2 * k + 1], 0); b.writeUInt32BE(words[2 * k], 4); parts.push(b); } return Buffer.concat(parts); };

function pack(values, bits) {
  const total = values.length * bits, words = new Uint32Array(Math.ceil(total / 64) * 2);
  values.forEach((v, i) => { for (let b = 0; b < bits; b++) if ((v >> b) & 1) { const s = i * bits + b; words[s >>> 5] |= 1 << (s & 31); } });
  return words;
}
const state = (name, props) => compound([tag(8, "Name", w.str(name)), ...(props ? [tag(10, "Properties", compound(Object.entries(props).map(([k, v]) => tag(8, k, w.str(v)))))] : [])]);
const xyz = (x, y, z) => compound([tag(3, "x", w.i32(x)), tag(3, "y", w.i32(y)), tag(3, "z", w.i32(z))]);

function makeLitematic(sx, sy, sz, palette, valueAt, pos) {
  const vals = []; for (let y = 0; y < Math.abs(sy); y++) for (let z = 0; z < Math.abs(sz); z++) for (let x = 0; x < Math.abs(sx); x++) vals.push(valueAt(x, y, z));
  const bits = Math.max(2, Math.ceil(Math.log2(palette.length)));
  const region = compound([
    tag(10, "Position", xyz(...(pos || [0, 0, 0]))), tag(10, "Size", xyz(sx, sy, sz)),
    tag(9, "BlockStatePalette", list(10, palette)), tag(12, "BlockStates", longArr(pack(vals, bits))),
  ]);
  const root = compound([tag(10, "Metadata", compound([tag(8, "Name", w.str("Rumah Tes")), tag(8, "Author", w.str("tes"))])), tag(10, "Regions", compound([tag(10, "main", region)]))]);
  return zlib.gzipSync(Buffer.concat([B([10]), w.str(""), root]));
}

// 1) litematic 5x3x4 dengan palet 6 entri (3 bit => ada nilai yang melewati batas long)
const pal = [state("minecraft:air"), state("minecraft:stone"), state("minecraft:oak_planks"), state("minecraft:oak_stairs", { facing: "north", half: "bottom" }), state("minecraft:oak_door", { half: "upper", facing: "east" }), state("minecraft:glass_pane", { north: "true", east: "false", south: "false", west: "false" })];
const val = (x, y, z) => (x + y * 2 + z * 3) % 6;
const bp = L.parse(makeLitematic(5, 3, 4, pal, val, [10, 64, -20]), "rumah.litematic");
assert.strictEqual(bp.name, "Rumah Tes");
assert.deepStrictEqual(bp.size, { x: 5, y: 3, z: 4 });
let expected = 0; for (let y = 0; y < 3; y++) for (let z = 0; z < 4; z++) for (let x = 0; x < 5; x++) if (val(x, y, z) !== 0) expected++;
assert.strictEqual(bp.blocks.length, expected);
for (const b of bp.blocks) {
  const v = val(b.x, b.y, b.z), n = pal[v] && ["", "stone", "oak_planks", "oak_stairs", "oak_door", "glass_pane"][v];
  assert.strictEqual(b.name, n, `blok ${b.x},${b.y},${b.z}`);
}
// bit 3 dan kasus melewati batas 64 bit: 60 nilai * 3 bit = 180 bit (3 long) sudah teruji di atas

// 2) rotasi: 4 kali = identik; stairs facing berputar; ukuran bertukar
const r1 = L.rotate(bp, 1);
assert.deepStrictEqual(r1.size, { x: 4, y: 3, z: 5 });
const st = bp.blocks.find((b) => b.name === "oak_stairs"), st1 = r1.blocks.find((b) => b.name === "oak_stairs");
assert.strictEqual(st.props.facing, "north"); assert.strictEqual(st1.props.facing, "east");
const r4 = L.rotate(bp, 4); assert.strictEqual(r4, bp);
const back = L.rotate(L.rotate(L.rotate(L.rotate(bp, 1), 1), 1), 1);
const key = (b) => `${b.x},${b.y},${b.z},${b.name},${JSON.stringify(Object.entries(b.props).sort())}`;
assert.deepStrictEqual(back.blocks.map(key).sort(), bp.blocks.map(key).sort());
// kaca: north=true berputar ke east=true
const gp = L.rotate({ ...bp, blocks: bp.blocks.filter((b) => b.name === "glass_pane").slice(0, 1) }, 1).blocks[0];
assert.strictEqual(gp.props.east, "true"); assert.strictEqual(gp.props.north, "false");

// 3) daftar bahan melewatkan bagian atas pintu
const mats = L.materials(bp.blocks);
assert.ok(!("oak_door" in mats), "pintu bagian atas tidak dihitung");
assert.strictEqual(L.itemFor("wall_torch"), "torch"); assert.strictEqual(L.itemFor("oak_wall_sign"), "oak_sign");

// 4) region berukuran negatif tetap menghasilkan blok pada koordinat benar
const neg = L.parse(makeLitematic(-2, 1, 1, [state("minecraft:air"), state("minecraft:stone"), state("minecraft:dirt")], (x) => x + 1, [5, 0, 0]), "n");
assert.strictEqual(neg.blocks.length, 2);
assert.deepStrictEqual(neg.size, { x: 2, y: 1, z: 1 });

// 5) Sponge .schem v2 (varint)
const spPal = compound([tag(3, "minecraft:air", w.i32(0)), tag(3, "minecraft:stone", w.i32(1)), tag(3, "minecraft:oak_stairs[facing=south,half=top]", w.i32(2))]);
const data = Buffer.concat([w.i32(4), B([0, 1, 2, 1])]);
const sponge = zlib.gzipSync(Buffer.concat([B([10]), w.str("Schematic"), compound([
  tag(3, "Version", w.i32(2)), tag(2, "Width", Buffer.from([0, 2])), tag(2, "Height", Buffer.from([0, 1])), tag(2, "Length", Buffer.from([0, 2])),
  tag(10, "Palette", spPal), tag(7, "BlockData", data)])]));
const sp = L.parse(sponge, "x.schem");
assert.strictEqual(sp.blocks.length, 3);
assert.deepStrictEqual(sp.blocks.find((b) => b.name === "oak_stairs").props, { facing: "south", half: "top" });

// 6) file rusak ditolak dengan pesan jelas
assert.throws(() => L.parse(Buffer.from("bukan nbt"), "x"), /NBT|tag/);
console.log("litematic: semua tes lulus (" + bp.blocks.length + " blok diuji)");
