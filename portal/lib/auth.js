"use strict";
// Login com usuários locais (data/users.json, senha em scrypt). Sessões em memória e gravadas em data/sessions.json
// (só o hash SHA-256 do cookie), para que reiniciar/atualizar o portal não desconecte quem está usando.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { USERS_FILE, SESSION_HOURS, COOKIE_SECURE, VERIFICAR } = require("./env");

const COOKIE = "gp_sid";
const sessions = new Map(); // hash do cookie -> { user, name, expires }
const SESS_FILE = path.join(path.dirname(USERS_FILE), "sessions.json");
const hashSid = (sid) => crypto.createHash("sha256").update(String(sid)).digest("hex");
try {
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(SESS_FILE, "utf8")))) if (v && v.expires > Date.now()) sessions.set(k, v);
} catch {}
function saveSessions() {
  if (VERIFICAR) return;
  try {
    fs.writeFileSync(SESS_FILE + ".tmp", JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
    fs.renameSync(SESS_FILE + ".tmp", SESS_FILE);
  } catch (e) {
    console.error("sessões: não gravou", e.message);
  }
}
const failures = new Map();
const MAX_FAILS = 5;
const BLOCK_MS = 15 * 60000;

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveUsers(users) {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), { mode: 0o600 });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function checkPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored || "").split("$");
  if (alg !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, value, maxAge) {
  const attrs = [`${COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAge}`];
  if (COOKIE_SECURE) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

function session(req) {
  const cookie = parseCookies(req.headers.cookie)[COOKIE];
  const sid = cookie && hashSid(cookie);
  const s = sid && sessions.get(sid);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(sid);
    saveSessions();
    return null;
  }
  return { sid, ...s };
}

function login(req, res) {
  const ip = req.ip;
  const f = failures.get(ip);
  if (f && f.count >= MAX_FAILS && Date.now() - f.at < BLOCK_MS) {
    return res.status(429).json({ error: "Muitas tentativas. Aguarde 15 minutos." });
  }
  const { username, password } = req.body || {};
  const user = loadUsers()[String(username || "")];
  if (!user || typeof password !== "string" || !checkPassword(password, user.hash)) {
    const cur = f && Date.now() - f.at < BLOCK_MS ? f : { count: 0 };
    failures.set(ip, { count: cur.count + 1, at: Date.now() });
    return res.status(401).json({ error: "Usuário ou senha inválidos" });
  }
  failures.delete(ip);
  const sid = crypto.randomBytes(32).toString("hex");
  sessions.set(hashSid(sid), { user: username, name: user.name || username, expires: Date.now() + SESSION_HOURS * 3600000 });
  saveSessions();
  setCookie(res, sid, SESSION_HOURS * 3600);
  res.json({ user: username, name: user.name || username });
}

function logout(req, res) {
  const s = session(req);
  if (s) { sessions.delete(s.sid); saveSessions(); }
  setCookie(res, "", 0);
  res.json({ ok: true });
}

function requireAuth(req, res, next) {
  const s = session(req);
  if (!s) return res.status(401).json({ error: "Não autenticado" });
  // Proteção CSRF: navegadores não enviam este cabeçalho em requisições de outros sites
  if (req.method !== "GET" && req.get("X-Requested-With") !== "portal") {
    return res.status(403).json({ error: "Requisição bloqueada" });
  }
  req.user = { user: s.user, name: s.name };
  next();
}

// Limpeza periódica: sessões vencidas e bloqueios de login antigos não ficam acumulando na memória
setInterval(() => {
  const now = Date.now();
  let mudou = false;
  for (const [sid, s] of sessions) if (s.expires < now) { sessions.delete(sid); mudou = true; }
  if (mudou) saveSessions();
  for (const [ip, f] of failures) if (now - f.at > BLOCK_MS) failures.delete(ip);
}, 10 * 60000).unref();

module.exports = { login, logout, requireAuth, loadUsers, saveUsers, hashPassword };
