const fs = require("fs");
const path = require("path");

const dir = path.join(process.env.DATA_DIR || __dirname, "logs");
const file = path.join(dir, "bot.log");
const logs = [];
const listeners = [];

// log disimpan ke logs/bot.log (diputar saat > 2 MB) dan dimuat lagi saat restart
try {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file) && fs.statSync(file).size > 2e6) fs.renameSync(file, file + ".old");
  if (fs.existsSync(file)) logs.push(...fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-300));
} catch (e) {}

function addLog(message) {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  const time = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const formatted = `[${time}] ${message}`;

  console.log(formatted);
  logs.push(formatted);
  if (logs.length > 300) logs.shift();
  fs.appendFile(file, formatted + "\n", () => {});
  listeners.forEach((f) => { try { f(formatted); } catch (e) {} });
}

function getLogs() {
  return logs;
}

function onLog(fn) {
  listeners.push(fn);
}

module.exports = { addLog, getLogs, onLog, file };
