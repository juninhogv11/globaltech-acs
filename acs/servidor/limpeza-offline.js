#!/usr/bin/env node
"use strict";
// Limpeza de equipamentos offline no GenieACS (roda no servidor do GenieACS, Node 16+).
//
// Para cada equipamento sem inform há DIAS dias ou mais:
//   - sem tag SGP_CONTRATO_<id> (não vinculado ao SGP)  -> remove
//   - com contrato: consulta o SGP; status "Cancelado"   -> remove
//   - contrato ativo/suspenso, não encontrado ou erro no SGP -> mantém (nunca remove na dúvida)
//   - tag SEM_LIMPEZA                                    -> mantém sempre
//
//   node limpeza-offline.js              simulação: só mostra o que faria
//   node limpeza-offline.js --apply      remove de verdade
//   opções: --dias 7   --max 10 (para tudo se for remover mais que isso numa execução)
//
// Antes de remover, guarda o documento completo do equipamento em BACKUP_DIR/<data>/<id>.json.
// Credenciais: /opt/genieacs/sgp.env, as mesmas da extensão "sistema" (SGP_* ou, com SISTEMA=hubsoft, HUBSOFT_*).
// No Hubsoft, "contrato" é o serviço do cliente (id_cliente_servico) e cancelado = status "cancelado".

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const APPLY = args.includes("--apply");
const DIAS = Number(opt("--dias", 7));
const MAX = Number(opt("--max", 10));
const NBI = (process.env.NBI_URL || "http://127.0.0.1:7557").replace(/\/+$/, "");
const SGP_ENV = process.env.SGP_ENV_FILE || "/opt/genieacs/sgp.env";
const BACKUP_DIR = process.env.LIMPEZA_BACKUP_DIR || "/var/lib/genieacs-limpeza";
const SGP_PATH = "/api/ura/consultacliente";

const log = (...a) => console.log(...a);

function readEnv(file) {
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

function request(url, { method = "GET", body, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = mod.request(u, {
      method,
      timeout,
      headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {},
    }, (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve({ status: res.statusCode, text: t }));
    });
    req.on("timeout", () => req.destroy(new Error(`sem resposta em ${timeout} ms`)));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function nbiJson(p) {
  const r = await request(NBI + p);
  if (r.status !== 200) throw new Error(`NBI ${p}: HTTP ${r.status}`);
  return JSON.parse(r.text);
}

// Situação do contrato no SGP: { status: "Cancelado" | ..., cancelado: bool } ou { erro }
async function statusContrato(sgp, contrato) {
  try {
    const r = await request(`https://${sgp.host}${SGP_PATH}`, {
      method: "POST",
      body: { contrato, app: sgp.app, token: sgp.token },
    });
    if (r.status !== 200) return { erro: `SGP HTTP ${r.status}` };
    const j = JSON.parse(r.text);
    const lista = Array.isArray(j.contratos) ? j.contratos : [];
    const c = lista.find((x) => String(x.contratoId) === String(contrato));
    if (!c) return { erro: `contrato ${contrato} não encontrado no SGP (${lista.length} contrato(s) na resposta)` };
    // Mostra os campos de status que o SGP mandou (para conferir na simulação)
    const campos = Object.fromEntries(Object.entries(c).filter(([k]) => /status|situa/i.test(k)));
    const texto = String(c.contratoStatusDisplay || c.contratoStatusDescricao || c.status_display || c.statusDisplay || c.contratoStatus || "");
    return { status: texto, campos, cancelado: /cancelad/i.test(texto) };
  } catch (e) {
    return { erro: `SGP: ${e.message}` };
  }
}

(async () => {
  log(`${new Date().toISOString()} limpeza-offline: ${APPLY ? "REMOVENDO" : "SIMULAÇÃO (nada será removido)"}; offline há ${DIAS}+ dias; máximo ${MAX}`);

  const env = readEnv(SGP_ENV);
  let consultar;
  if (String(env.SISTEMA || "sgp").toLowerCase() === "hubsoft") {
    // Hubsoft: a tag SGP_CONTRATO_<id> guarda o id_cliente_servico; usa o mesmo código da extensão.
    // Sem arquivo de token (esta tarefa roda como root e o arquivo é do usuário genieacs).
    process.env.HUBSOFT_TOKEN_FILE = "";
    const hs = require(path.join(process.env.GENIEACS_EXT_DIR || "/opt/genieacs/ext", "hubsoft"));
    consultar = async (contrato) => {
      try { return await hs.statusServico(contrato); } catch (e) { return { erro: e.message }; }
    };
  } else {
    // Sem SGP_HOST no sgp.env: usa o mesmo endereço da extensão "sistema" instalada
    let host = env.SGP_HOST;
    if (!host) {
      try {
        const m = fs.readFileSync(process.env.SGP_EXT_FILE || "/opt/genieacs/ext/sistema", "utf8").match(/const HOST = "([^"]+)"/);
        if (m) host = m[1];
      } catch {}
    }
    const sgp = { host, app: env.SGP_APP, token: env.SGP_TOKEN };
    if (!sgp.host || !sgp.app || !sgp.token) throw new Error(`credenciais do SGP ausentes em ${SGP_ENV}`);
    consultar = (contrato) => statusContrato(sgp, contrato);
  }

  const limite = new Date(Date.now() - DIAS * 86400000).toISOString();
  const q = encodeURIComponent(JSON.stringify({ _lastInform: { $lt: limite } }));
  const devs = await nbiJson(`/devices/?query=${q}&projection=_id,_lastInform,_tags,_deviceId`);

  const remover = [];
  for (const d of devs) {
    const tags = d._tags || [];
    const dias = Math.floor((Date.now() - Date.parse(d._lastInform)) / 86400000);
    const modelo = (d._deviceId || {})._ProductClass || "?";
    const ctag = tags.find((t) => t.startsWith("SGP_CONTRATO_"));
    const contrato = ctag ? ctag.slice("SGP_CONTRATO_".length) : "";
    const pre = `${d._id} (${modelo}, ${dias} dias offline)`;

    if (tags.includes("SEM_LIMPEZA")) { log(`MANTER   ${pre}: tag SEM_LIMPEZA`); continue; }
    if (!contrato) { log(`REMOVER  ${pre}: não vinculado ao SGP`); remover.push({ id: d._id, motivo: "não vinculado" }); continue; }

    const s = await consultar(contrato);
    if (s.erro) { log(`MANTER   ${pre}: contrato ${contrato}: ${s.erro}`); continue; }
    const detalhe = `contrato ${contrato} "${s.status}" ${JSON.stringify(s.campos)}`;
    if (s.cancelado) { log(`REMOVER  ${pre}: ${detalhe}`); remover.push({ id: d._id, motivo: `contrato ${contrato} cancelado` }); }
    else log(`MANTER   ${pre}: ${detalhe}`);
  }

  log(`${devs.length} offline há ${DIAS}+ dias; ${remover.length} para remover.`);
  if (!APPLY || !remover.length) return;
  if (remover.length > MAX) throw new Error(`${remover.length} para remover passa do máximo (${MAX}); nada removido. Confira e rode com --max ${remover.length}.`);

  const dir = path.join(BACKUP_DIR, new Date().toISOString().slice(0, 10));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const r of remover) {
    const doc = await nbiJson(`/devices/?query=${encodeURIComponent(JSON.stringify({ _id: r.id }))}`);
    fs.writeFileSync(path.join(dir, `${r.id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`), JSON.stringify(doc[0] || {}, null, 1), { mode: 0o600 });
    for (const f of await nbiJson(`/faults/?query=${encodeURIComponent(JSON.stringify({ device: r.id }))}`)) {
      await request(`${NBI}/faults/${encodeURIComponent(f._id)}`, { method: "DELETE" });
    }
    const del = await request(`${NBI}/devices/${encodeURIComponent(r.id)}`, { method: "DELETE" });
    if (del.status >= 300) { log(`ERRO     ${r.id}: HTTP ${del.status} ${del.text.slice(0, 120)}`); continue; }
    log(`REMOVIDO ${r.id} (${r.motivo}); cópia em ${dir}`);
  }
})().catch((e) => {
  console.error(`${new Date().toISOString()} limpeza-offline ERRO: ${e.message}`);
  process.exit(1);
});
