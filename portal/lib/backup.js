"use strict";
// Backups: conversa com a API de backup do servidor GenieACS (genieacs-backup.js serve)
// e empacota/restaura a pasta data/ do portal (Wi-Fi guardado, firmwares, fotos, usuários).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { USERS_FILE } = require("./env");

const AGENT = (process.env.BACKUP_AGENT_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.BACKUP_TOKEN || "";
const DATA = path.dirname(USERS_FILE);

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

function configured() {
  return !!(AGENT && TOKEN);
}

function tokenOk(value) {
  if (!TOKEN) return false;
  const a = Buffer.from(String(value || ""));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function agent(method, p, body, timeoutMs = 60000) {
  if (!configured()) throw bad("Backup não configurado no portal (BACKUP_AGENT_URL e BACKUP_TOKEN no .env).", 503);
  let r;
  try {
    r = await fetch(AGENT + p, {
      method,
      headers: { "X-Backup-Token": TOKEN, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw bad(`Servidor de backup não respondeu: ${e.message}`, 502);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw bad(j.error || `Servidor de backup respondeu HTTP ${r.status}`, r.status === 409 ? 409 : 502);
  return j;
}

// ---------- dados do portal ----------
function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else if (e.isFile() && !e.name.endsWith(".tmp")) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

function portalBundle() {
  const arquivos = {};
  for (const rel of walk(DATA)) arquivos[rel] = fs.readFileSync(path.join(DATA, rel)).toString("base64");
  return { versao: 1, criado: new Date().toISOString(), arquivos };
}

// Grava os arquivos do backup na pasta data/. users.json só se pedido (evita perder o acesso).
function restorePortal(bundle, { incluirUsuarios = false } = {}) {
  if (!bundle || bundle.versao !== 1 || typeof bundle.arquivos !== "object") throw bad("Dados do portal inválidos no backup.");
  const gravados = [];
  for (const [rel, b64] of Object.entries(bundle.arquivos)) {
    if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/.test(rel) || rel.includes("..")) continue;
    if (rel === "users.json" && !incluirUsuarios) continue;
    const dest = path.join(DATA, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest + ".tmp", Buffer.from(b64, "base64"), { mode: rel.endsWith(".json") && !rel.startsWith("models/") ? 0o600 : 0o644 });
    fs.renameSync(dest + ".tmp", dest);
    gravados.push(rel);
  }
  return gravados;
}

module.exports = { configured, tokenOk, agent, portalBundle, restorePortal };
