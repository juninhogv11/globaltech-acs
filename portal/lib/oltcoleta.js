"use strict";
// Coleta das ONUs nas OLTs (Telnet, só leitura) e histórico de quedas com a causa vista pela OLT.
//   ZTE C610:   show gpon onu state + baseinfo por PON; histórico (10 últimas quedas) via detail-info
//   V-SOL EPON: show onu status por porta (MAC, estado, última queda e motivo; relógio da OLT corrigido)
//   Nokia ISAM: show equipment ont status pon + operational-data (down-reason)
// Guarda em data/olt-onus.json: estado atual de cada ONU e histórico de quedas (45 dias).
const fs = require("fs");
const path = require("path");
const { USERS_FILE } = require("./env");
const olts = require("./olts");

const FILE = path.join(path.dirname(USERS_FILE), "olt-onus.json");
const DIAS = 45;
const INTERVALO_MIN = Number(process.env.OLT_COLETA_MIN || 10);

let db = null;
function load() {
  if (db) return db;
  try { db = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { db = { onus: {}, historico: {}, coletas: {} }; }
  return db;
}
function save() {
  fs.writeFileSync(FILE + ".tmp", JSON.stringify(db), { mode: 0o600 });
  fs.renameSync(FILE + ".tmp", FILE);
}

// Causa padronizada: energia | fibra | outro
function causaDe(txt) {
  const t = String(txt || "").toLowerCase();
  if (!t || t === "n/a" || t === "-") return null;
  if (/dying.?gasp/.test(t)) return "energia";
  if (/\blos\b|losi|lofi|loss.?of.?signal|ploam|lof\b|loss.?of.?frame|sf\b|signal.?fail|mpcp|timeout|optical/.test(t)) return "fibra";
  return "outro";
}
const normSn = (s) => String(s || "").toUpperCase().replace(/^SN:/, "").replace(/:/g, "");
const normMac = (s) => String(s || "").toLowerCase().replace(/[^0-9a-f]/g, "");

// ---------- ZTE C610 ----------
async function coletarZte(o) {
  const r1 = await olts.lerComandos(o.id, ["show gpon onu state"]);
  const onus = [];
  for (const l of r1.saidas[0].saida.split("\n")) {
    const m = l.trim().match(/^(\d+\/\d+\/\d+):(\d+)\s+(\S+)\s+(\S+)\s+(\S+)/);
    if (m) onus.push({ index: `${m[1]}:${m[2]}`, pon: m[1], estadoOlt: m[5] });
  }
  const pons = [...new Set(onus.map((x) => x.pon))];
  const sn = {};
  const r2 = await olts.lerComandos(o.id, pons.map((p) => `show gpon onu baseinfo gpon_olt-${p}`));
  for (const s of r2.saidas) for (const l of s.saida.split("\n")) {
    const m = l.trim().match(/^gpon_onu-(\S+)\s+\S+\s+\S+\s+SN:(\S+)/);
    if (m) sn[m[1]] = normSn(m[2]);
  }
  return onus.map((x) => ({
    index: x.index, sn: sn[x.index] || "", online: /^working$/i.test(x.estadoOlt),
    estadoOlt: x.estadoOlt, causa: /working/i.test(x.estadoOlt) ? null : causaDe(x.estadoOlt) || "outro",
  }));
}
// Histórico de uma ONU ZTE (10 últimas quedas). O relógio da C610 está em UTC ("show clock" -> "15:06:43 UTC").
async function historicoZte(o, index) {
  const r = await olts.lerComandos(o.id, [`show gpon onu detail-info gpon_onu-${index}`]);
  const out = [];
  for (const l of r.saidas[0].saida.split("\n")) {
    const m = l.trim().match(/^\d+\s+(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s+(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s+(\S+)/);
    if (m && !/^0000/.test(m[2])) out.push({ caiu: new Date(m[2].replace(" ", "T") + "Z").toISOString(), voltou: null, motivo: m[3], causa: causaDe(m[3]) || "outro", fonte: "olt" });
  }
  return out;
}

// ---------- V-SOL EPON ----------
const portasVsol = {};
async function coletarVsol(o) {
  // Portas EPON: lidas da configuração 1x por dia
  let portas = (portasVsol[o.id] && Date.now() - portasVsol[o.id].em < 86400000) ? portasVsol[o.id].portas : null;
  if (!portas) {
    const r0 = await olts.lerComandos(o.id, ["show running-config"]);
    portas = [...new Set([...r0.saidas[0].saida.matchAll(/^interface epon (\S+)/gm)].map((m) => m[1]))];
    portasVsol[o.id] = { portas, em: Date.now() };
  }
  const cmds = ["configure terminal"];
  for (const p of portas) cmds.push(`interface epon ${p}`, "show onu status");
  const r = await olts.lerComandos(o.id, cmds);
  const onus = [];
  let offset = null; // diferença (ms) entre o relógio da OLT e o real
  const dataOlt = (s) => (/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d$/.test(s) ? Date.parse(s.replace(/\//g, "-").replace(" ", "T") + "-03:00") : null);
  for (const s of r.saidas.filter((x) => x.comando === "show onu status")) {
    for (const l of s.saida.split("\n")) {
      const m = l.trim().match(/^EPON(\S+):(\d+)\s+(online|offline)\s+(\S+)\s+\S+\s+\S+\s+(N\/A|\d{4}\/\S+ \S+)\s+(N\/A|\d{4}\/\S+ \S+)\s+(\S+)\s+(\d+:\d\d:\d\d)/i);
      if (!m) continue;
      const reg = dataOlt(m[5]);
      const [hh, mm, ss] = m[8].split(":").map(Number);
      if (m[3] === "online" && reg && offset === null) offset = reg + (hh * 3600 + mm * 60 + ss) * 1000 - Date.now();
      onus.push({ index: `${m[1]}:${m[2]}`, mac: normMac(m[4]), online: m[3] === "online", estadoOlt: m[3],
        causa: m[3] === "online" ? null : causaDe(m[7]) || "outro", ultimaQuedaOlt: dataOlt(m[6]), motivo: m[7] === "N/A" ? null : m[7] });
    }
  }
  // Corrige as datas da OLT com o relógio real
  for (const x of onus) x.ultimaQueda = x.ultimaQuedaOlt ? new Date(x.ultimaQuedaOlt - (offset || 0)).toISOString() : null;
  return { onus, offsetMin: offset === null ? null : Math.round(offset / 60000) };
}

// ---------- Nokia ISAM ----------
async function coletarNokia(o) {
  const r = await olts.lerComandos(o.id, ["environment inhibit-alarms", "show equipment ont status pon", "show equipment ont operational-data"]);
  const st = r.saidas[1].saida, op = r.saidas[2].saida;
  const motivo = {};
  for (const l of op.split("\n")) {
    const m = l.trim().match(/^(\d+\/\d+\/\d+\/\d+\/\d+)\s.*\s(\S+)\s*$/);
    if (m) motivo[m[1]] = m[2];
  }
  const onus = [];
  for (const l of st.split("\n")) {
    const m = l.trim().match(/^\S+\s+(\d+\/\d+\/\d+\/\d+\/\d+)\s+(\S+)\s+(up|down)\s+(up|down)\s+(\S+)/);
    if (!m) continue;
    const online = m[4] === "up";
    const mot = motivo[m[1]];
    onus.push({ index: m[1], sn: normSn(m[2]), online, estadoOlt: m[4], rx: Number(m[5]) || null,
      causa: online ? null : causaDe(mot) || "outro", motivo: mot && mot !== "n/a" ? mot : null });
  }
  return onus;
}

// ---------- Coleta geral ----------
let rodando = false;
async function coletar() {
  if (rodando) return;
  rodando = true;
  load();
  const agora = new Date().toISOString();
  try {
    for (const o of olts.listar()) {
      const c = { em: agora, ok: false };
      try {
        let onus, extra = {};
        if (o.tipo === "zte") onus = await coletarZte(o);
        else if (o.tipo === "vsol") ({ onus, ...extra } = await coletarVsol(o));
        else if (o.tipo === "nokia") onus = await coletarNokia(o);
        else continue;
        const vistos = new Set();
        for (const x of onus) {
          const key = `${o.id}|${x.index}`;
          vistos.add(key);
          const ant = db.onus[key];
          const h = (db.historico[key] = db.historico[key] || []);
          // Transição online -> offline: registra a queda (hora da OLT quando houver, senão a da coleta)
          if (ant && ant.online && !x.online) h.push({ caiu: x.ultimaQueda || agora, voltou: null, motivo: x.motivo || x.estadoOlt, causa: x.causa, fonte: "coleta" });
          if (ant && !ant.online && x.online) { const u = h[h.length - 1]; if (u && !u.voltou) u.voltou = agora; }
          // V-SOL: a OLT informa a última queda; se for nova, guarda
          if (x.ultimaQueda && !h.some((e) => Math.abs(Date.parse(e.caiu) - Date.parse(x.ultimaQueda)) < 120000)) {
            h.push({ caiu: x.ultimaQueda, voltou: x.online ? agora : null, motivo: x.motivo, causa: causaDe(x.motivo) || "outro", fonte: "olt" });
          }
          db.onus[key] = { olt: o.id, oltNome: o.descricao, oltTipo: o.tipo, index: x.index, sn: x.sn || "", mac: x.mac || "",
            online: x.online, estadoOlt: x.estadoOlt, causa: x.causa, motivo: x.motivo || null, rx: x.rx ?? null, visto: agora };
        }
        // ONUs que sumiram da OLT
        for (const key of Object.keys(db.onus)) if (key.startsWith(o.id + "|") && !vistos.has(key)) delete db.onus[key];
        Object.assign(c, { ok: true, onus: onus.length, online: onus.filter((x) => x.online).length,
          energia: onus.filter((x) => x.causa === "energia").length, fibra: onus.filter((x) => x.causa === "fibra").length, ...extra });
      } catch (e) { c.erro = e.message; }
      db.coletas[o.id] = c;
    }
    const limite = Date.now() - DIAS * 86400000;
    for (const k of Object.keys(db.historico)) {
      db.historico[k] = db.historico[k].filter((e) => Date.parse(e.caiu) >= limite).sort((a, b) => a.caiu.localeCompare(b.caiu));
      if (!db.historico[k].length) delete db.historico[k];
    }
    save();
  } finally { rodando = false; }
}

// ---------- Ligação ONU <-> aparelho do ACS ----------
// GPON TP-Link: serial "TPLG" + últimos 4 bytes do MAC base.
// EPON: MAC da ONU dentro do bloco de 8 MACs do próprio aparelho (base..base+7). Aparelhos do mesmo lote
// ficam a 8 de distância, então tolerância maior ligaria a ONU ao aparelho VIZINHO.
function acharOnu(device) {
  load();
  const mac = normMac(device.mac);
  const serial = normSn(device.serial);
  const candidatos = Object.entries(db.onus);
  for (const [k, x] of candidatos) if (x.sn && (x.sn === serial || (mac.length === 12 && x.sn === "TPLG" + mac.slice(4).toUpperCase()))) return { key: k, ...x };
  if (mac.length === 12) {
    const base = parseInt(mac.slice(6), 16);
    for (const [k, x] of candidatos) {
      if (!x.mac || x.mac.slice(0, 6) !== mac.slice(0, 6)) continue;
      const d = parseInt(x.mac.slice(6), 16) - base;
      if (d >= 0 && d <= 7) return { key: k, ...x };
    }
  }
  return null;
}

// Histórico da ZTE lido na hora (10 últimas quedas), guardado 10 min para não repetir a cada página aberta
const cacheZte = new Map();
async function onuDoAparelho(device, comHistoricoZte = false) {
  const onu = acharOnu(device);
  if (!onu) return null;
  const h = [...((load().historico[onu.key]) || [])];
  if (comHistoricoZte && onu.oltTipo === "zte") {
    let c = cacheZte.get(onu.key);
    if (!c || Date.now() - c.em > 600000) {
      try { c = { em: Date.now(), lista: await historicoZte({ id: onu.olt }, onu.index) }; cacheZte.set(onu.key, c); } catch { c = null; }
    }
    for (const e of (c && c.lista) || []) if (!h.some((x) => Math.abs(Date.parse(x.caiu) - Date.parse(e.caiu)) < 120000)) h.push(e);
  }
  h.sort((a, b) => b.caiu.localeCompare(a.caiu));
  return { ...onu, historico: h };
}

// Liga cada evento do ACS (religou / fibra) à queda vista pela OLT, se houver: a ONU caiu
// entre o último contato antes do evento (com folga de 15 min) e 5 min depois dele.
function confirmarEventos(eventos, onu) {
  if (!onu) return eventos;
  // Reinício pedido pelo ACS (portal, reboot periódico, firmware) também aparece na OLT como queda
  // (na ZTE como "LOSi"): marca essas quedas para não contarem como problema de fibra/energia.
  for (const q of onu.historico || []) {
    const c = Date.parse(q.caiu);
    const e = eventos.find((x) => (x.tipo === "acs" || x.tipo === "firmware") && Date.parse(x.ts) >= c - 120000 && Date.parse(x.ts) - c <= 20 * 60000);
    if (e) q.pedidoAcs = e.tipo;
  }
  for (const e of eventos) {
    if (e.tipo !== "religou" && e.tipo !== "rede") continue;
    const t = Date.parse(e.ts);
    const ini = t - ((e.semContatoMin || 10) + 15) * 60000, fim = t + 5 * 60000;
    const q = onu.historico.find((x) => { const c = Date.parse(x.caiu); return !x.pedidoAcs && c >= ini && c <= fim; });
    if (q) { e.causaOlt = q.causa; e.motivoOlt = q.motivo; }
  }
  return eventos;
}

function resumo() {
  load();
  return { coletas: db.coletas, intervaloMin: INTERVALO_MIN, onus: Object.keys(db.onus).length };
}

function iniciar() {
  setTimeout(() => coletar().catch((e) => console.error("coleta OLT:", e.message)), 20000);
  setInterval(() => coletar().catch((e) => console.error("coleta OLT:", e.message)), INTERVALO_MIN * 60000).unref();
}

module.exports = { coletar, onuDoAparelho, acharOnu, confirmarEventos, resumo, iniciar, causaDe };
