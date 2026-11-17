"use strict";
// Survival mode: eat, fight hostile mobs, flee creepers, hunt food, sleep, craft wooden tools.
// Everything is wrapped in try/catch so a failure here can never crash the bot.
const { goals } = require("mineflayer-pathfinder");
const { GoalNear, GoalFollow, GoalXZ } = goals;

const HOSTILE = new Set(["zombie", "husk", "drowned", "skeleton", "stray", "spider", "cave_spider", "witch", "pillager", "vindicator", "slime", "zombie_villager", "phantom"]);
const ANIMALS = new Set(["cow", "pig", "sheep", "chicken", "rabbit"]);
const TIERS = ["wooden", "golden", "stone", "iron", "diamond", "netherite"];

module.exports = function survival(bot, mcData, move, log, addInterval, botState) {
  move.canDig = true;
  bot.pathfinder.setMovements(move);
  const Vec3 = bot.entity.position.constructor;
  let busy = false, engaged = false, lastHit = 0, huntSpot = null, craftFails = 0;

  const items = () => bot.inventory.items();
  const count = (re) => items().filter((i) => re.test(i.name)).reduce((n, i) => n + i.count, 0);
  const foods = () => items().filter((i) => mcData.foods && mcData.foods[i.type] && !/rotten|pufferfish|spider_eye|poisonous/.test(i.name));
  const dist = (e) => bot.entity.position.distanceTo(e.position);
  const goto = (p, r = 2) => bot.pathfinder.goto(new GoalNear(p.x, p.y, p.z, r));
  const nearby = () => Object.values(bot.entities).filter((e) => e !== bot.entity && e.position && dist(e) < 32);

  async function weapon() {
    const rank = (i) => TIERS.indexOf(i.name.split("_")[0]);
    const w = items().filter((i) => /_(sword|axe)$/.test(i.name)).sort((a, b) => rank(b) - rank(a))[0];
    if (w) await bot.equip(w, "hand");
  }

  async function craft(name, n, table) {
    const it = mcData.itemsByName[name];
    const r = it && bot.recipesFor(it.id, null, 1, table || null)[0];
    if (!r) return false;
    await bot.craft(r, n, table || undefined);
    return true;
  }

  // Wood -> planks -> sticks -> crafting table -> wooden pickaxe + sword
  async function basics() {
    if (count(/_sword$/) && count(/_pickaxe$/)) return false;
    if (count(/_log$/) * 4 + count(/_planks$/) < 12) {
      const b = bot.findBlock({ matching: (x) => x.name.endsWith("_log"), maxDistance: 48 });
      if (!b) return false;
      await goto(b.position);
      await bot.dig(bot.blockAt(b.position));
      return true;
    }
    for (const l of items().filter((i) => /_log$/.test(i.name))) await craft(l.name.replace("_log", "_planks"), l.count);
    await craft("stick", 1);
    const tableId = mcData.blocksByName.crafting_table.id;
    let table = bot.findBlock({ matching: tableId, maxDistance: 16 });
    if (!table) {
      if (!count(/crafting_table$/)) await craft("crafting_table", 1);
      const ref = bot.blockAt(bot.entity.position.floored().offset(1, -1, 0));
      await bot.equip(items().find((i) => i.name === "crafting_table"), "hand");
      await bot.placeBlock(ref, new Vec3(0, 1, 0));
      table = bot.findBlock({ matching: tableId, maxDistance: 6 });
    }
    if (!table) return false;
    await goto(table.position, 3);
    for (const t of ["wooden_pickaxe", "wooden_sword"])
      if (!count(new RegExp(t.split("_")[1] + "$"))) await craft(t, 1, table);
    log("[Survival] Wooden tools crafted");
    return true;
  }

  // Fast loop: reacts to danger even while a long walk is in progress
  async function guard() {
    try {
      if (!bot.entity || bot.isSleeping) return;
      const me = bot.entity.position, ents = nearby();
      const threats = ents.filter((e) => HOSTILE.has(e.name) && dist(e) < 16).sort((a, b) => dist(a) - dist(b));
      const creeper = ents.find((e) => e.name === "creeper" && dist(e) < 8);
      const danger = creeper || (bot.health <= 6 && threats[0]);
      const t = threats[0];
      if (danger) {
        const dx = me.x - danger.position.x, dz = me.z - danger.position.z, len = Math.hypot(dx, dz) || 1;
        bot.pathfinder.setGoal(new GoalXZ(me.x + (dx / len) * 20, me.z + (dz / len) * 20));
        return (engaged = true);
      }
      if (t && dist(t) < 12) {
        bot.pathfinder.setGoal(new GoalFollow(t, 2), true);
        if (dist(t) < 3.3 && Date.now() - lastHit > 650) {
          lastHit = Date.now();
          await weapon();
          await bot.lookAt(t.position.offset(0, (t.height || 1.6) * 0.8, 0));
          bot.attack(t);
        }
        return (engaged = true);
      }
      if (engaged) { engaged = false; bot.pathfinder.setGoal(null); }
    } catch (e) {}
  }

  // Slow loop: food, hunting, sleeping, crafting
  async function work() {
    if (busy || engaged || !bot.entity || bot.isSleeping) return;
    busy = true;
    try {
      const f = foods()[0];
      if (bot.food <= 14 && f) { await bot.equip(f, "hand"); await bot.consume(); return; }
      if (bot.food <= 12) {
        const a = nearby().filter((e) => ANIMALS.has(e.name)).sort((x, y) => dist(x) - dist(y))[0];
        if (a) {
          huntSpot = a.position.clone();
          bot.pathfinder.setGoal(new GoalFollow(a, 2), true);
          if (dist(a) < 3.3 && Date.now() - lastHit > 650) { lastHit = Date.now(); await weapon(); bot.attack(a); }
          return;
        }
        if (huntSpot) { const s = huntSpot; huntSpot = null; await goto(s, 1); return; }
      }
      const night = bot.time && bot.time.timeOfDay >= 12700 && bot.time.timeOfDay <= 23000;
      if (night) {
        const bed = bot.findBlock({ matching: (b) => b.name.endsWith("_bed"), maxDistance: 32 });
        if (bed) { await goto(bed.position, 2); await bot.sleep(bed); log("[Survival] Sleeping"); return; }
      }
      if (craftFails < 4) {
        try { await basics(); craftFails = 0; }
        catch (e) { craftFails++; log("[Survival] Crafting step failed: " + e.message); }
      }
    } catch (e) {
      /* e.g. goal changed by guard, cannot sleep yet - ignore */
    } finally {
      busy = false;
    }
  }

  addInterval(guard, 500);
  addInterval(() => { if (botState && botState.patrolActive) return; work(); }, 1000); // patroli mengambil alih gerakan
  log("[Survival] Mode survival aktif");
};
