# Fitur baru v2.4 (terinspirasi Litematica, Baritone Automated Builder, Baritone, HeroBot)

Mod aslinya adalah mod klien Java (Fabric 26.3) dan tidak bisa dipasang di bot Mineflayer, jadi fiturnya ditulis ulang di bot ini.

## Blueprint & auto-build (Litematica + Automated Builder) — `printer.js`, `litematic.js`
Panel → Tugas → **Blueprint**: unggah `.litematic` / `.schem` / `.nbt`, pilih titik asal & rotasi, lihat pratinjau per lapisan, lalu **Bangun**.
- Dibangun dari bawah ke atas; blok tempelan (obor, tombol, dll) paling akhir. Arah tangga, pintu, peti, log, slab diatur lewat arah hadap bot.
- Bahan habis: bot ambil dari peti / barrel / shulker box di sekitar (isi peti diingat), membuka shulker di tas, atau menambang bahan sederhana (cobblestone, dirt, kayu).
- Tinggi: bot membuat pilar perancah lalu membongkarnya setelah selesai.
- **Penjaga** (`/bp guard on`): membandingkan dunia dengan blueprint (atau potret area `/snapshot`) tiap 10 dtk dan 2,5 dtk setelah ledakan, lalu menambal lubang bekas creeper.

Perintah konsol: `/bp list|load <nama> [x y z] [rot]|here|origin|rot|info|verify|build|guard|stop|unload`, `/supply add|scan|list|clear`, `/snapshot [radius]`, `/repair`.

## Ala Baritone — `baritone.js`
`/mine <blok> [n]` (diamond, kayu, iron...), `/bridge <n|s|e|w> [panjang]`, `/pillar [tinggi]`, `/tunnel <arah> [panjang]`, `/fill x1 y1 z1 x2 y2 z2 <blok>`.
`/goto` dan `/follow` memakai pathfinder yang sudah otomatis menjembatani celah dan menggali bila perlu.

## PvP ala HeroBot + ingatan musuh — `pvp.js`
- Siapa pun yang memukul bot dilawan sampai tuntas dengan senjata terbaik yang ada (tangan kosong pun jalan).
- Critical hit, sprint-reset, strafe, perisai, totem di tangan kiri, apel emas saat darah rendah, pasang armor terbaik.
- Ingatan permanen (`pvp.json`): pukulan & pembunuhan per pemain. Yang pernah membunuh atau memukul ≥3x dikejar lagi saat terlihat (`/pvp revenge off` untuk mematikan). Setelah mati, bot kembali ke lokasi mati untuk mengambil barang.
- `/pvp on|off`, `/pvp friend add|del <nama>`, `/grudge`, `/forgive <nama>`, `/attack <pemain|mob>`. Teman & `safe.whitelist` tidak pernah diserang.
- Pengaturan di `settings.json` → `pvp` dan `printer`.

## Tes
`npm test` menjalankan tes parser blueprint dan tes bot palsu (build, isi ulang dari peti, tambal, bridge, mine, PvP). Belum diuji di server Minecraft sungguhan.
