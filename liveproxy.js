"use strict";
// Meneruskan viewer (prismarine-viewer, port internal) lewat port panel supaya cukup satu domain.
// /live/*      -> viewer (awalan /live dibuang)
// /socket.io/* -> viewer (dipakai client viewer untuk data realtime)
const http = require("http");
const { viewerPort } = require("./extras");

const map = (u) => (u.startsWith("/live/") ? u.slice(5) : u.startsWith("/socket.io/") ? u : null);

function authOk(req) {
  const pass = process.env.PANEL_PASSWORD;
  if (!pass) return true;
  const [scheme, token] = (req.headers.authorization || "").split(" ");
  return scheme === "Basic" && Buffer.from(token || "", "base64").toString().split(":").slice(1).join(":") === pass;
}

module.exports = function liveProxy(app, server, config) {
  const target = (req, path) => ({ host: "127.0.0.1", port: viewerPort(config), path, method: req.method, headers: { ...req.headers, host: "127.0.0.1" } });

  app.use((req, res, next) => {
    if (req.path === "/live") return res.redirect("/live/");
    const path = map(req.url);
    if (!path) return next();
    const up = http.request(target(req, path), (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on("error", () => {
      if (!res.headersSent) res.status(502).send("Live view belum siap. Pastikan bot utama terhubung dan Live view aktif, lalu ketuk tab Live lagi.");
      else res.end();
    });
    req.pipe(up);
  });

  server.on("upgrade", (req, socket, head) => {
    const path = map(req.url);
    if (!path) return socket.destroy();
    if (!authOk(req)) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); return socket.destroy(); }
    const up = http.request(target(req, path));
    up.on("upgrade", (r, s, h) => {
      let out = "HTTP/1.1 101 Switching Protocols\r\n";
      for (let i = 0; i < r.rawHeaders.length; i += 2) out += `${r.rawHeaders[i]}: ${r.rawHeaders[i + 1]}\r\n`;
      socket.write(out + "\r\n");
      if (h && h.length) socket.write(h);
      if (head && head.length) s.write(head);
      s.pipe(socket); socket.pipe(s);
      s.on("error", () => socket.destroy()); socket.on("error", () => s.destroy());
    });
    up.on("response", () => socket.destroy());
    up.on("error", () => socket.destroy());
    up.end();
  });
};
