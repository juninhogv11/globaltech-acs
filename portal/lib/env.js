"use strict";
// Carrega o arquivo .env (CHAVE=valor) sem dependências externas
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", ".env");
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

module.exports = {
  PORT: Number(process.env.PORT || 3100),
  HOST: process.env.HOST || "127.0.0.1",
  NBI_URL: (process.env.NBI_URL || "http://127.0.0.1:7557").replace(/\/+$/, ""),
  // Endereço do SGP (vazio = sem link): o código do cliente na página do dispositivo abre <SGP_URL>/admin/cliente/<id>/contratos/
  SGP_URL: (process.env.SGP_URL || "").replace(/\/+$/, ""),
  ONLINE_MINUTES: Number(process.env.ONLINE_MINUTES || 6),
  SESSION_HOURS: Number(process.env.SESSION_HOURS || 12),
  COOKIE_SECURE: process.env.COOKIE_SECURE === "1",
  USERS_FILE: process.env.USERS_FILE || path.join(__dirname, "..", "data", "users.json"),
};
