"use strict";
// Gerak ala manusia untuk bot:
//  - melompati rintangan setinggi 1 blok
//  - menghindari lubang, lava, api, kaktus, dan air
//  - (opsional) menghancurkan blok yang menghalangi, kecuali blok yang dilindungi
// Dipakai oleh jalan acak anti-AFK, patroli, dan perintah gerak lain lewat applyMovements().

// blok yang tidak pernah dihancurkan bot (peti, tungku, pintu, tempat tidur, portal, dll)
const PROTECTED = /chest|barrel|shulker_box|furnace|smoker|blast_furnace|spawner|beacon|_bed$|^bed$|sign|door|trapdoor|fence_gate|command_block|structure_block|jigsaw|end_portal|nether_portal|bedrock|barrier|obsidian|respawn_anchor|enchanting_table|anvil|jukebox|lectern|hopper|dropper|dispenser|crafter|brewing_stand|cauldron|lodestone|conduit|decorated_pot|campfire|crafting_table|bookshelf|banner|head$|skull/;
const HURT = /lava|fire|magma|cactus|sweet_berry|campfire|powder_snow|wither_rose/;
const FALLING = /sand|gravel|concrete_powder|anvil|dragon_egg/;
const TALL = /fence|_wall$/; // pagar & tembok 1,5 blok: tidak bisa dilompati

function applyMovements(m, registry, dig) {
  m.canDig = !!dig;
  m.allowSprinting = true;
  if (dig) {
    m.digCost = 4; // lebih suka melompat / memutar daripada menggali
    try {
      if (!m.blocksCantBreak) m.blocksCantBreak = new Set();
      for (const b of (registry && registry.blocksArray) || []) if (PROTECTED.test(b.name)) m.blocksCantBreak.add(b.id);
    } catch (e) {}
  }
  return m;
}

const solid = (b) => !!b && b.boundingBox === "block";
const liquid = (b) => !!b && /water|lava/.test(b.name);

// lihat satu blok di depan arah hadap `yaw`
function probe(bot, yaw) {
  const Vec3 = bot.entity.position.constructor;
  const p = bot.entity.position;
  const x = Math.floor(p.x - Math.sin(yaw) * 0.9), z = Math.floor(p.z - Math.cos(yaw) * 0.9), y = Math.floor(p.y);
  const at = (dy) => bot.blockAt(new Vec3(x, y + dy, z));
  const feet = at(0), head = at(1), top = at(2), f1 = at(-1), f2 = at(-2);
  if (!feet || !head) return { kind: "unknown" };
  if (HURT.test(feet.name) || (f1 && HURT.test(f1.name)) || liquid(feet) || liquid(f1)) return { kind: "danger" };
  if (solid(feet)) {
    const room = bot.blockAt(new Vec3(Math.floor(p.x), y + 2, Math.floor(p.z))); // ruang kepala untuk melompat
    if (TALL.test(feet.name)) return { kind: "wall", feet, head, blocked: true };
    if (!solid(head) && !solid(top) && !solid(room)) return { kind: "step" };
    return { kind: "wall", feet, head };
  }
  if (!solid(f1) && !solid(f2)) return { kind: "hole" }; // turun 2 blok atau lebih
  return { kind: "clear" };
}

// boleh dihancurkan? (tidak dilindungi, bisa dijangkau, tidak membuka air/lava, tidak menimbulkan pasir jatuh)
function breakable(bot, b) {
  if (!b || !solid(b) || PROTECTED.test(b.name) || TALL.test(b.name)) return false;
  if (b.diggable === false || (b.hardness != null && b.hardness < 0)) return false;
  try { if (!bot.canDigBlock(b)) return false; } catch (e) { return false; }
  const Vec3 = bot.entity.position.constructor;
  for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
    const n = bot.blockAt(new Vec3(b.position.x + dx, b.position.y + dy, b.position.z + dz));
    if (n && (liquid(n) || (dy === 1 && FALLING.test(n.name)))) return false;
  }
  return true;
}

async function digBlock(bot, b) {
  try {
    const tool = bot.pathfinder && bot.pathfinder.bestHarvestTool ? bot.pathfinder.bestHarvestTool(b) : null;
    if (tool) await bot.equip(tool, "hand");
  } catch (e) {}
  try { await bot.lookAt(b.position.offset(0.5, 0.5, 0.5)); } catch (e) {}
  await Promise.race([
    bot.dig(b, true),
    new Promise((_, rej) => setTimeout(() => { try { bot.stopDigging(); } catch (e) {} rej(new Error("timeout menggali")); }, 12000)),
  ]);
}

// jalan acak ala manusia selama 1-4 detik
function walk(bot, botState, log, dig, opts) {
  opts = opts || {};
  if (!bot || !bot.entity || botState.walking) return;
  botState.walking = true;
  let yaw = Math.random() * Math.PI * 2, turns = 0, busy = false, lastJump = 0, lastPos = bot.entity.position.clone(), lastMove = Date.now(), done = false;
  const until = Date.now() + 1200 + Math.random() * 2800;
  const ctl = (k, v) => { try { bot.setControlState(k, v); } catch (e) {} };
  const stop = () => {
    if (done) return;
    done = true; clearInterval(iv); botState.walking = false;
    ["forward", "jump", "sprint"].forEach((k) => ctl(k, false));
  };
  const turn = () => {
    yaw += Math.PI + (Math.random() - 0.5) * 1.6; turns++;
    try { bot.look(yaw, 0, true); } catch (e) {}
  };
  try { bot.look(yaw, 0, true); } catch (e) {}
  ctl("forward", true);
  if (Math.random() < 0.4) ctl("sprint", true);

  const iv = setInterval(async () => {
    if (busy || done) return;
    try {
      if (!bot.entity || !botState.connected || botState.patrolActive || Date.now() > until || turns > 4) return stop();
      const now = Date.now(), pos = bot.entity.position;
      const pr = probe(bot, yaw);
      if (pr.kind === "step") {
        if (bot.entity.onGround && now - lastJump > 500) { lastJump = now; ctl("jump", true); setTimeout(() => ctl("jump", false), 250); }
      } else if (pr.kind === "danger" || pr.kind === "hole") {
        ctl("forward", false); ctl("sprint", false);
        if (opts.onAvoid) opts.onAvoid(pr.kind);
        turn(); setTimeout(() => { if (!done) ctl("forward", true); }, 150 + Math.random() * 250);
      } else if (pr.kind === "wall") {
        ctl("forward", false); ctl("sprint", false);
        const list = [pr.head, pr.feet].filter(solid);
        if (dig && !pr.blocked && list.length && list.every((b) => breakable(bot, b))) {
          busy = true;
          try {
            for (const b of list) await digBlock(bot, b);
            log("[Gerak] Menghancurkan blok yang menghalangi");
          } catch (e) { turn(); }
          busy = false;
          if (!done) ctl("forward", true);
        } else {
          turn(); setTimeout(() => { if (!done) ctl("forward", true); }, 200 + Math.random() * 300);
        }
      }
      // macet (tidak bergeser) -> lompat sekali, lalu putar arah
      if (pos.distanceTo(lastPos) > 0.15) { lastPos = pos.clone(); lastMove = now; }
      else if (now - lastMove > 1200) {
        lastMove = now;
        if (bot.entity.onGround && now - lastJump > 500) { lastJump = now; ctl("jump", true); setTimeout(() => ctl("jump", false), 250); }
        else turn();
      }
    } catch (e) { busy = false; stop(); }
  }, 120);
}

module.exports = { applyMovements, walk, probe, breakable, PROTECTED };
