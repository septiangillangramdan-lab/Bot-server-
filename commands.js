"use strict";
// Penghubung perintah konsol/panel ke modul baru: /bp /supply /snapshot /repair /mine /bridge /pillar /tunnel /fill /pvp /grudge /forgive
// Tiap modul mendaftarkan fungsinya di botState.cmds saat bot spawn.
const KNOWN = ["/bp", "/supply", "/snapshot", "/repair", "/mine", "/bridge", "/pillar", "/tunnel", "/fill", "/pvp", "/grudge", "/forgive"];

function run(cmd, targets) {
  const [c, ...a] = cmd.trim().split(/\s+/);
  if (c === "/stop") { // hentikan semua pekerjaan baru, lalu biarkan extras.js mengurus /stop bawaan
    for (const b of targets) { const s = b.botState; try { s.printerStop && s.printerStop(); s.baritoneStop && s.baritoneStop(); s.pvpStop && s.pvpStop(); } catch (e) {} }
    return null;
  }
  if (!KNOWN.includes(c)) return null;
  return targets.map((b) => {
    const fn = b.botState && b.botState.cmds && b.botState.cmds[c];
    if (!b.botState || !b.botState.connected || !fn) return `[${b.name}] belum terhubung / fitur belum aktif`;
    try { return `[${b.name}] ${fn(a)}`; } catch (e) { return `[${b.name}] error: ${e.message}`; }
  });
}

const HELP = [
  "/bp list|load <nama> [x y z] [rot]|here|origin x y z|rot n|info|verify|build|guard on|off|stop|unload   (blueprint .litematic)",
  "/supply add x y z|scan|list|clear   /snapshot [radius]   /repair   (isi ulang bahan & tambal lubang)",
  "/mine <blok> [n]  /bridge <n|s|e|w> [panjang]  /pillar [tinggi]  /tunnel <arah> [panjang]  /fill x1 y1 z1 x2 y2 z2 <blok>",
  "/pvp on|off|revenge on|off|friend add|del <nama>   /grudge   /forgive <nama>   /attack <pemain|mob>",
];
module.exports = { run, HELP, KNOWN };
