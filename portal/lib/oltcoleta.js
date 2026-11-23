"use strict";
// Coleta das ONUs nas OLTs (SNMP para ZTE e Nokia, Telnet para V-SOL e como reserva; só leitura) e histórico de quedas com a causa vista pela OLT.
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
// Nokia ISAM lista as ONTs devagar (~30 s por leitura): lida com menos frequência
const INTERVALO_TIPO = { nokia: Number(process.env.OLT_COLETA_NOKIA_MIN || 30) };

let db = null;
function load() {
  if (db) return db;
  try { db = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { db = { onus: {}, historico: {}, coletas: {} }; }
  db.status = db.status || {};
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
  if (/dying.?gasp|power.?(off|down|fail)/.test(t)) return "energia"; // V-SOL: "Power Off"
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
async function coletarVsol(o, vinc = new Set()) {
  // Portas EPON: lidas da configuração 1x por dia
  let portas = (portasVsol[o.id] && Date.now() - portasVsol[o.id].em < 86400000) ? portasVsol[o.id].portas : null;
  if (!portas) {
    const r0 = await olts.lerComandos(o.id, ["show running-config"]);
    portas = [...new Set([...r0.saidas[0].saida.matchAll(/^interface epon (\S+)/gm)].map((m) => m[1]))];
    portasVsol[o.id] = { portas, em: Date.now() };
  }
  const cmds = ["configure terminal"];
  for (const p of portas) {
    cmds.push(`interface epon ${p}`, "show onu status", "show onu opm-diag");
    // tráfego: só das ONUs ligadas a aparelhos do ACS (1 comando por ONU)
    const pre = `${o.id}|${p}:`;
    for (const k of vinc) if (k.startsWith(pre) && /^\d+$/.test(k.slice(pre.length))) cmds.push(`show onu ${k.slice(pre.length)} statistics`);
  }
  const r = await olts.lerComandos(o.id, cmds);
  const onus = [];
  let offset = null; // diferença (ms) entre o relógio da OLT e o real
  const dataOlt = (s) => (/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d$/.test(s) ? Date.parse(s.replace(/\//g, "-").replace(" ", "T") + "-03:00") : null);
  for (const s of r.saidas.filter((x) => x.comando === "show onu status")) {
    for (const l of s.saida.split("\n")) {
      const m = l.trim().match(/^EPON(\S+):(\d+)\s+(online|offline)\s+(\S+)\s+\S+\s+\S+\s+(N\/A|\d{4}\/\S+ \S+)\s+(N\/A|\d{4}\/\S+ \S+)\s+(\S.*?)\s+(\d+:\d\d:\d\d)/i); // motivo pode ter espaço ("Power Off")
      if (!m) continue;
      const reg = dataOlt(m[5]);
      const [hh, mm, ss] = m[8].split(":").map(Number);
      if (m[3] === "online" && reg && offset === null) offset = reg + (hh * 3600 + mm * 60 + ss) * 1000 - Date.now();
      onus.push({ index: `${m[1]}:${m[2]}`, mac: normMac(m[4]), online: m[3] === "online", estadoOlt: m[3],
        causa: m[3] === "online" ? null : causaDe(m[7]) || "outro", ultimaQuedaOlt: dataOlt(m[6]), motivo: m[7] === "N/A" ? null : m[7] });
    }
  }
  // Sinal (RX da ONU, dBm) e contadores de bytes. rx_good = recebido pela OLT (upload); tx_good = enviado (download)
  const porIdx = new Map(onus.map((x) => [x.index, x]));
  let porta = null;
  for (const s of r.saidas) {
    const pi = s.comando.match(/^interface epon (\S+)$/);
    if (pi) { porta = pi[1]; continue; }
    if (s.comando === "show onu opm-diag") {
      // ONU-ID  Temperature  Voltage  Bias  TX Power  RX Power
      for (const l of s.saida.split("\n")) {
        const m = l.trim().match(/^EPON(\S+):(\d+)\s+-?[\d.]+\s+[\d.]+\s+[\d.]+\s+-?[\d.]+\s+(-?[\d.]+)\s*$/);
        const x = m && porIdx.get(`${m[1]}:${m[2]}`);
        if (x) x.medida = { ...(x.medida || {}), rx: Number(m[3]), lado: "onu" };
      }
    }
    const st = s.comando.match(/^show onu (\d+) statistics$/);
    if (st && porta) {
      const up = s.saida.match(/rx_good_octets\s*=\s*(\d+)/), down = s.saida.match(/tx_good_octets\s*=\s*(\d+)/);
      const x = porIdx.get(`${porta}:${st[1]}`);
      if (x && up && down) x.medida = { ...(x.medida || {}), up: Number(up[1]), down: Number(down[1]) };
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

// ---------- Coleta por SNMP (ZTE e Nokia) ----------
// Mais leve que o Telnet: sem login nem sessão de console, poucas centenas de linhas por GETBULK.
// A V-SOL continua no Telnet: o agente SNMP dela é lento, perde pedidos e já travou (Córrego Preto).
const snDeHex = (v) => {
  const s = String(v || "");
  // o leitor SNMP devolve texto quando os bytes formam UTF-8 válido (ex.: "TPLG" + 51 7B D3 A0): volta aos bytes
  const b = /^[0-9a-f]{16}$/i.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "utf8");
  if (b.length !== 8) return normSn(s);
  if (!/^[A-Z0-9]{4}$/.test(b.subarray(0, 4).toString("latin1"))) return ""; // sem serial (ONU por senha/LOID)
  return b.subarray(0, 4).toString("latin1") + b.subarray(4).toString("hex").toUpperCase();
};
const ultimo = (oid) => oid.split(".");
// Data em OCTET STRING da ZTE (ano 2 bytes, mês, dia, hora, min, seg) — relógio da C610 em UTC
function dataZte(h) {
  if (!/^[0-9a-f]{14,16}$/i.test(String(h || ""))) return null;
  const b = Buffer.from(h, "hex");
  const ano = b.readUInt16BE(0);
  if (ano < 2000) return null;
  return new Date(Date.UTC(ano, b[2] - 1, b[3], b[4], b[5], b[6])).toISOString();
}

const ZTE_OID = {
  sn: "1.3.6.1.4.1.3902.1082.500.20.2.1.2.1.3",       // .<ifIndex PON>.<id ONU>
  fase: "1.3.6.1.4.1.3902.1082.500.10.2.3.8.1.4",
  caiu: "1.3.6.1.4.1.3902.1082.500.10.2.3.8.1.6",
  causa: "1.3.6.1.4.1.3902.1082.500.10.2.3.8.1.7",
};
const ZTE_FASE = { 1: "logging", 2: "LOS", 3: "syncMib", 4: "working", 5: "DyingGasp", 6: "authFailed", 7: "OffLine" };
const ZTE_CAUSA = { 2: "LOS", 3: "LOSi", 9: "DyingGasp" }; // conferido com o "detail-info" do Telnet
async function coletarZteSnmp(o) {
  const t = await olts.snmpColunas(o.id, Object.values(ZTE_OID));
  const por = {};
  for (const [nome, oid] of Object.entries(ZTE_OID)) for (const vb of t[oid]) {
    const p = ultimo(vb.oid), pon = Number(p[p.length - 2]), id = p[p.length - 1];
    const index = `${(pon >>> 16) & 0xff}/${(pon >>> 8) & 0xff}/${pon & 0xff}:${id}`;
    (por[index] = por[index] || { index, ref: `${pon}.${id}` })[nome] = vb.value;
  }
  return Object.values(por).filter((x) => x.fase !== undefined).map((x) => {
    const estado = ZTE_FASE[x.fase] || `fase ${x.fase}`;
    const online = Number(x.fase) === 4;
    const motivo = ZTE_CAUSA[x.causa] || null;
    // ONU autorizada por senha/LOID não tem serial nessa tabela: mantém o que o Telnet já leu
    let sn = snDeHex(x.sn);
    if (!sn) sn = (load().onus[`${o.id}|${x.index}`] || {}).sn || "";
    return { index: x.index, ref: x.ref, sn, online, estadoOlt: estado,
      causa: online ? null : causaDe(estado) || "outro", ultimaQueda: motivo ? dataZte(x.caiu) : null, motivo };
  });
}

const NOKIA_SN = "1.3.6.1.4.1.637.61.1.35.10.1.1.5";     // .<ifIndex ONT>
const NOKIA_CAUSA_OID = "1.3.6.1.4.1.637.61.1.35.10.4.1.8"; // último motivo de queda (a ISAM calcula na hora: ~120 ms por ONT)
const NOKIA_CAUSA = { 6: "signal-degrade", 9: "ploam-inactive", 12: "dying-gasp" }; // conferido com operational-data
// ifIndex da ONT na ISAM: 0x05C00000 = LT 1/1/1; +65536 por PON; +512 por ONT
const nokiaIndex = (x) => `1/1/${((x >>> 20) & 0xf) - 0xc + 1}/${((x >>> 16) & 0xf) + 1}/${((x & 0xffff) >>> 9) + 1}`;
async function coletarNokiaSnmp(o) {
  const sns = (await olts.snmpColunas(o.id, [NOKIA_SN]))[NOKIA_SN];
  const lista = sns.map((vb) => ({ ifx: Number(ultimo(vb.oid).pop()), sn: snDeHex(vb.value) }));
  const oper = await olts.snmpGetLote(o.id, lista.map((x) => `1.3.6.1.2.1.2.2.1.8.${x.ifx}`)); // IF-MIB ifOperStatus
  const st = {}; for (const vb of oper) st[ultimo(vb.oid).pop()] = vb.value;
  const ant = load().onus;
  for (const x of lista) { x.index = nokiaIndex(x.ifx); x.online = Number(st[x.ifx]) === 1; x.ant = ant[`${o.id}|${x.index}`]; }
  // Motivo só das ONTs que acabaram de cair (ou ainda sem motivo); as outras repetem o da leitura anterior
  const pedir = lista.filter((x) => !x.online && (!x.ant || x.ant.online || !x.ant.motivo));
  if (pedir.length) {
    const r = await olts.snmpGetLote(o.id, pedir.map((x) => `${NOKIA_CAUSA_OID}.${x.ifx}`));
    const c = {}; for (const vb of r) c[ultimo(vb.oid).pop()] = vb.value;
    for (const x of pedir) { const v = Number(c[x.ifx]); x.motivo = NOKIA_CAUSA[v] || (v > 0 && v < 255 ? `código ${v}` : null); }
  }
  return lista.map((x) => {
    const mot = x.online ? null : x.motivo !== undefined ? x.motivo : (x.ant && x.ant.motivo) || null;
    return { index: x.index, ref: x.ifx, sn: x.sn, online: x.online, estadoOlt: x.online ? "up" : "down", rx: null,
      causa: x.online ? null : causaDe(mot) || "outro", motivo: mot };
  });
}

// ---------- Sinal e tráfego das ONUs ligadas a aparelhos do ACS ----------
// Guardado em data/olt-series.json: um ponto por coleta (10 min), 7 dias.
//   ZTE (SNMP):  RX na OLT 500.1.2.4.2.1.2 (milésimos de dBm; -80000 = sem sinal);
//                bytes 500.10.2.3.2.2.1.2 (entrada = upload) e .28 (saída = download) — conferidos com "show interface"
//   Nokia (SNMP): RX na OLT 637.61.1.35.10.18.1.2 (décimos de dBm); a ISAM não tem contador de tráfego por ONT
//   V-SOL (Telnet): RX na ONU ("show onu opm-diag") e bytes por ONU ("show onu N statistics")
const SFILE = path.join(path.dirname(USERS_FILE), "olt-series.json");
const SERIE_DIAS = 7;
let sdb = null;
function loadS() {
  if (sdb) return sdb;
  try { sdb = JSON.parse(fs.readFileSync(SFILE, "utf8")); } catch { sdb = {}; }
  return sdb;
}
function saveS() {
  fs.writeFileSync(SFILE + ".tmp", JSON.stringify(sdb), { mode: 0o600 });
  fs.renameSync(SFILE + ".tmp", SFILE);
}
async function medirSnmp(o, onus, vinc) {
  const alvo = onus.filter((x) => x.ref != null && vinc.has(`${o.id}|${x.index}`));
  if (!alvo.length) return;
  if (o.tipo === "zte") {
    const oids = alvo.flatMap((x) => [`1.3.6.1.4.1.3902.1082.500.1.2.4.2.1.2.${x.ref}`, `1.3.6.1.4.1.3902.1082.500.10.2.3.2.2.1.2.${x.ref}`, `1.3.6.1.4.1.3902.1082.500.10.2.3.2.2.1.28.${x.ref}`]);
    const v = {}; for (const vb of await olts.snmpGetLote(o.id, oids)) v[vb.oid] = vb.value;
    for (const x of alvo) {
      const rx = Number(v[`1.3.6.1.4.1.3902.1082.500.1.2.4.2.1.2.${x.ref}`]);
      const up = v[`1.3.6.1.4.1.3902.1082.500.10.2.3.2.2.1.2.${x.ref}`], down = v[`1.3.6.1.4.1.3902.1082.500.10.2.3.2.2.1.28.${x.ref}`];
      x.medida = { rx: rx > -50000 && rx < 10000 ? Math.round(rx / 10) / 100 : null, lado: "olt",
        up: typeof up === "number" ? up : null, down: typeof down === "number" ? down : null };
    }
  } else if (o.tipo === "nokia") {
    const v = {}; for (const vb of await olts.snmpGetLote(o.id, alvo.map((x) => `1.3.6.1.4.1.637.61.1.35.10.18.1.2.${x.ref}`))) v[ultimo(vb.oid).pop()] = vb.value;
    for (const x of alvo) { const rx = Number(v[x.ref]); x.medida = { rx: rx > -500 && rx < 100 ? rx / 10 : null, lado: "olt" }; }
  }
}
function registrarSerie(key, agora, x) {
  const s = (sdb[key] = sdb[key] || { pts: [] });
  const m = x.medida || {};
  let down = null, up = null;
  if (m.up != null && m.down != null) {
    const t = Date.parse(agora);
    if (s.cnt && t > s.cnt.t && t - s.cnt.t < 3 * 3600000) {
      const dt = (t - s.cnt.t) / 1000, dd = m.down - s.cnt.down, du = m.up - s.cnt.up;
      if (dd >= 0 && du >= 0) { down = Math.round((dd * 8) / dt); up = Math.round((du * 8) / dt); } // contador zerado: pula
    }
    s.cnt = { t, down: m.down, up: m.up };
  }
  if (m.lado) s.lado = m.lado;
  s.pts.push([agora, m.rx ?? null, down, up, x.online ? "on" : x.causa || "off"]);
}
function limparSeries() {
  const limite = new Date(Date.now() - SERIE_DIAS * 86400000).toISOString();
  for (const k of Object.keys(sdb)) {
    sdb[k].pts = sdb[k].pts.filter((p) => p[0] >= limite);
    if (!sdb[k].pts.length) delete sdb[k];
  }
}

// ---------- Totais de todas as OLTs (gráfico "Clientes nas OLTs" do dashboard) ----------
// data/olt-totais.json: um ponto por coleta (10 min), 7 dias: [hora, online, sem energia, sem fibra, outros, OLTs lidas]
// Soma a última coleta boa de cada OLT (a Nokia por Telnet é lida a cada 30 min); coleta com mais de 90 min não entra.
const TFILE = path.join(path.dirname(USERS_FILE), "olt-totais.json");
let tdb = null;
function loadT() {
  if (tdb) return tdb;
  try { tdb = JSON.parse(fs.readFileSync(TFILE, "utf8")); } catch { tdb = { pts: [] }; }
  return tdb;
}
function registrarTotais(agora) {
  loadT();
  const t = [agora, 0, 0, 0, 0, 0];
  for (const c of Object.values(db.coletas)) {
    if (!c.ok || Date.now() - Date.parse(c.em) > 90 * 60000) continue;
    t[1] += c.online; t[2] += c.energia; t[3] += c.fibra; t[4] += c.onus - c.online - c.energia - c.fibra; t[5]++;
  }
  if (!t[5]) return;
  const limite = new Date(Date.now() - SERIE_DIAS * 86400000).toISOString();
  tdb.pts = tdb.pts.filter((p) => p[0] >= limite);
  tdb.pts.push(t);
  fs.writeFileSync(TFILE + ".tmp", JSON.stringify(tdb), { mode: 0o600 });
  fs.renameSync(TFILE + ".tmp", TFILE);
}
function totais(horas = 24) {
  const h = Math.min(Math.max(Number(horas) || 24, 1), SERIE_DIAS * 24);
  const desde = new Date(Date.now() - h * 3600000).toISOString();
  return { horas: h, campos: ["em", "online", "energia", "fibra", "outros", "olts"], pts: loadT().pts.filter((p) => p[0] >= desde) };
}

// Tempo ligada em segundos: hrSystemUptime (equipamento) e, se não houver, sysUpTime (agente SNMP).
// GET separado por OID: no SNMP v1 um OID inexistente derruba o pedido inteiro.
async function tempoLigada(o) {
  for (const oid of ["1.3.6.1.2.1.25.1.1.0", "1.3.6.1.2.1.1.3.0"]) {
    try {
      const [vb] = await olts.snmpGetLote(o.id, [oid]);
      if (vb && typeof vb.value === "number" && vb.value > 0) return Math.round(vb.value / 100);
    } catch {}
  }
  return null;
}

// ---------- Temperatura e tempo ligada de cada OLT (data/olt-onus.json -> status) ----------
// Conferido em 23/11/2026 (só leitura):
//   ZTE C610 (Telnet): "show temperature detail" -> pontos da placa (Minor/Major em °C) e ENV (ambiente, High-threshold);
//                      tempo ligada pelo SNMP ou, sem SNMP, "show card slotno N" (Uptime) da placa de controle (GMPA/GMRA)
//   Nokia ISAM (SNMP): 637.61.1.23.10.1 .2 temperatura atual, .3 tca-low e .4 tca-high por sensor (= "show equipment temperature")
//   V-SOL (Telnet, modo config): "show fan" ("current temperature:48.5 .C") e "show time" ("running for 7 days 8 hours ...")
const STATUS_MIN = Number(process.env.OLT_STATUS_MIN || 30);
const VSOL_TEMP = { warn: 60, bad: 70 }; // a V-SOL não informa limites; valores conservadores
const NOKIA_TEMP = { atual: "1.3.6.1.4.1.637.61.1.23.10.1.2", aviso: "1.3.6.1.4.1.637.61.1.23.10.1.3", alto: "1.3.6.1.4.1.637.61.1.23.10.1.4" };
const PIOR = { ok: 0, warn: 1, bad: 2 };
const pior = (a, b) => (PIOR[b] > PIOR[a] ? b : a);
function durTxt(t) {
  const g = (re) => Number((String(t).match(re) || [])[1] || 0);
  const s = g(/(\d+)\s*day/i) * 86400 + g(/(\d+)\s*hour/i) * 3600 + g(/(\d+)\s*min/i) * 60 + g(/(\d+)\s*sec/i);
  return s > 0 ? s : null;
}
async function statusZte(o, comLigado) {
  const r = await olts.lerComandos(o.id, comLigado ? ["show temperature detail", "show card"] : ["show temperature detail"]);
  const t = r.saidas[0].saida;
  const out = { nivel: "ok", pontos: [] };
  for (const m of t.matchAll(/^(\S+)\s+\d+\s+\d+\s+(.+?)\s+\S+\s+(\d+)\s+(\d+)\s+\d+\s+\d+\s+(\d+)\s*$/gm)) {
    const [, , nome, minor, major, atual] = m;
    out.pontos.push({ nome: nome.trim(), temp: +atual });
    out.nivel = pior(out.nivel, +atual >= +major ? "bad" : +atual >= +minor ? "warn" : "ok");
  }
  const env = t.match(/^ENV\s+\S+\s+(\d+)\s+(\d+)/m);
  if (env) {
    const [, alto, atual] = env.map(Number);
    out.temp = atual;
    out.nivel = pior(out.nivel, atual >= alto ? "bad" : atual >= alto - 5 ? "warn" : "ok");
  } else if (out.pontos.length) out.temp = Math.max(...out.pontos.map((p) => p.temp));
  if (comLigado) {
    const linhas = [...r.saidas[1].saida.matchAll(/^\d+\s+(\d+)\s+(\S+)\s+.*INSERVICE/gm)];
    const ctrl = linhas.find((m) => /^GM/i.test(m[2])) || linhas[0];
    if (ctrl) {
      const r2 = await olts.lerComandos(o.id, [`show card slotno ${ctrl[1]}`]);
      const up = r2.saidas[0].saida.match(/^Uptime\s*:\s*(.+)$/m);
      if (up) out.ligadoSeg = durTxt(up[1]);
    }
  }
  return out;
}
async function statusNokia(o) {
  const t = await olts.snmpColunas(o.id, Object.values(NOKIA_TEMP), 500);
  const val = (col) => { const m = {}; for (const vb of t[col]) m[vb.oid.slice(col.length)] = vb.value; return m; };
  const atual = val(NOKIA_TEMP.atual), aviso = val(NOKIA_TEMP.aviso), alto = val(NOKIA_TEMP.alto);
  const out = { nivel: "ok", pontos: [] };
  for (const [k, v] of Object.entries(atual)) {
    if (typeof v !== "number") continue;
    out.pontos.push({ nome: `sensor ${k.replace(/^\./, "")}`, temp: v });
    out.nivel = pior(out.nivel, alto[k] && v >= alto[k] ? "bad" : aviso[k] && v >= aviso[k] ? "warn" : "ok");
  }
  if (out.pontos.length) out.temp = Math.max(...out.pontos.map((p) => p.temp));
  return out;
}
async function statusVsol(o) {
  const r = await olts.lerComandos(o.id, ["configure terminal", "show time", "show fan"]);
  const out = { nivel: "ok" };
  const up = r.saidas[1].saida.match(/running for (.+)/i);
  if (up) out.ligadoSeg = durTxt(up[1]);
  const tm = r.saidas[2].saida.match(/current temperature\s*:\s*(-?[\d.]+)/i);
  if (tm) {
    out.temp = Number(tm[1]);
    out.nivel = out.temp >= VSOL_TEMP.bad ? "bad" : out.temp >= VSOL_TEMP.warn ? "warn" : "ok";
  }
  return out;
}
async function lerStatus(o, c) {
  const agora = new Date().toISOString();
  try {
    let s;
    if (o.tipo === "zte") s = await statusZte(o, c.ligadoSeg == null);
    else if (o.tipo === "nokia" && o.temCommunity) s = await statusNokia(o);
    else if (o.tipo === "vsol") s = await statusVsol(o);
    else return;
    // Tempo ligada lido pelo SNMP na coleta vale quando a leitura própria não trouxe
    if (s.ligadoSeg == null && c.ligadoSeg != null) s.ligadoSeg = c.ligadoSeg;
    db.status[o.id] = { em: agora, ...s };
  } catch (e) {
    // Mantém a última leitura boa, só marca o erro (tenta de novo na próxima coleta)
    db.status[o.id] = { ...(db.status[o.id] || {}), erro: e.message, erroEm: agora };
  }
}

// Quem fornece a lista de aparelhos do ACS (definido em iniciar); usado para saber quais ONUs medir
let aparelhosFn = null;

// ---------- Coleta geral ----------
let rodando = false;
// forcar = true (botão "Ler ONUs agora"): lê todas, sem esperar o intervalo próprio de cada tipo
async function coletar(forcar = false) {
  if (rodando) return;
  rodando = true;
  load();
  loadS();
  const agora = new Date().toISOString();
  // ONUs ligadas a aparelhos do ACS (as únicas que ganham gráfico de sinal/tráfego)
  const vinc = new Set();
  if (aparelhosFn) {
    try { for (const d of await aparelhosFn()) { const k = acharOnu(d); if (k) vinc.add(k.key); } }
    catch (e) { console.error("coleta OLT: lista de aparelhos:", e.message); }
  }
  try {
    for (const o of olts.listar()) {
      const ult = db.coletas[o.id];
      const minTipo = INTERVALO_TIPO[o.tipo];
      // O intervalo maior da Nokia vale só para o Telnet (lento); por SNMP ela é lida junto com as outras
      if (!forcar && minTipo && ult && ult.ok && ult.via !== "snmp" && Date.now() - Date.parse(ult.em) < (minTipo - 1) * 60000) continue;
      const c = { em: agora, ok: false };
      try {
        let onus, extra = {};
        const t0 = Date.now();
        if ((o.tipo === "zte" || o.tipo === "nokia") && o.temCommunity) {
          // SNMP primeiro; se a OLT não responder, cai para o Telnet
          try {
            onus = o.tipo === "zte" ? await coletarZteSnmp(o) : await coletarNokiaSnmp(o);
            if (!onus.length) throw new Error("tabela SNMP vazia");
            extra.via = "snmp";
          } catch (e) { extra.snmpErro = e.message; onus = null; }
        }
        if (!onus) {
          if (o.tipo === "zte") onus = await coletarZte(o);
          else if (o.tipo === "vsol") ({ onus, ...extra } = await coletarVsol(o, vinc));
          else if (o.tipo === "nokia") onus = await coletarNokia(o);
          else continue;
          extra.via = "telnet";
        }
        if (extra.via === "snmp") { try { await medirSnmp(o, onus, vinc); } catch (e) { extra.medidaErro = e.message; } }
        // Tempo ligada (para o quadro do dashboard). V-SOL fica de fora: o agente SNMP dela trava.
        if (extra.via === "snmp") { const s = await tempoLigada(o); if (s != null) extra.ligadoSeg = s; }
        extra.segundos = Math.round((Date.now() - t0) / 100) / 10;
        for (const x of onus) { const key = `${o.id}|${x.index}`; if (vinc.has(key)) registrarSerie(key, agora, x); }
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
      // Temperatura e tempo ligada: a cada STATUS_MIN (são poucas leituras, mas abrem uma sessão Telnet a mais)
      const st = db.status[o.id];
      if (c.ok && (forcar || !st || !st.em || Date.now() - Date.parse(st.em) > (STATUS_MIN - 1) * 60000)) await lerStatus(o, c);
    }
    const limite = Date.now() - DIAS * 86400000;
    for (const k of Object.keys(db.historico)) {
      db.historico[k] = db.historico[k].filter((e) => Date.parse(e.caiu) >= limite).sort((a, b) => a.caiu.localeCompare(b.caiu));
      if (!db.historico[k].length) delete db.historico[k];
    }
    save();
    limparSeries();
    saveS();
    registrarTotais(agora);
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
  return { coletas: db.coletas, status: db.status, intervaloMin: INTERVALO_MIN, intervaloTipo: INTERVALO_TIPO, onus: Object.keys(db.onus).length };
}

// Série de sinal/tráfego da ONU ligada ao aparelho (para os gráficos da página do dispositivo)
function serieDoAparelho(device, horas = 24) {
  const onu = acharOnu(device);
  if (!onu) return { onu: null, pontos: [] };
  const s = loadS()[onu.key] || { pts: [] };
  const desde = new Date(Date.now() - Math.min(Math.max(Number(horas) || 24, 1), SERIE_DIAS * 24) * 3600000).toISOString();
  const temTrafego = onu.oltTipo !== "nokia";
  return {
    onu: { olt: onu.oltNome, tipo: onu.oltTipo, index: onu.index, online: onu.online, causa: onu.causa, visto: onu.visto },
    lado: s.lado || (onu.oltTipo === "vsol" ? "onu" : "olt"), temTrafego, intervaloMin: INTERVALO_MIN,
    pontos: s.pts.filter((p) => p[0] >= desde).map(([t, rx, down, up, st]) => ({ t, rx, down, up, st })),
  };
}

// listarAparelhos: função que devolve os aparelhos do ACS (para saber quais ONUs medir)
function iniciar(listarAparelhos) {
  aparelhosFn = listarAparelhos || null;
  setTimeout(() => coletar().catch((e) => console.error("coleta OLT:", e.message)), 20000);
  setInterval(() => coletar().catch((e) => console.error("coleta OLT:", e.message)), INTERVALO_MIN * 60000).unref();
}

module.exports = { coletar, onuDoAparelho, acharOnu, confirmarEventos, resumo, iniciar, causaDe, serieDoAparelho, totais };
