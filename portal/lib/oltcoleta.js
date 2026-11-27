"use strict";
// Coleta das ONUs nas OLTs (SNMP para ZTE e Nokia, Telnet para V-SOL e como reserva; só leitura) e histórico de quedas com a causa vista pela OLT.
//   ZTE C610:   show gpon onu state + baseinfo por PON; histórico (10 últimas quedas) via detail-info
//   V-SOL EPON: show onu status por porta (MAC, estado, última queda e motivo; relógio da OLT corrigido)
//   Nokia ISAM: show equipment ont status pon + operational-data (down-reason)
//   ZTE C220:   SNMP (árvore antiga 3902.1012) com Telnet de reserva (show gpon onu state, nomes "gpon-onu_1/2/1:1")
//   FiberHome AN5516/AN6000: só SNMP (5875.800.3.10.1.1, tabela de ONUs autorizadas)
//   Huawei MA5608T / MA5800-X2/X15/X17: só SNMP (HUAWEI-XPON-MIB 2011.6.128.1.1.2), conferido em OLTs reais
//   Cianet EPON 4 PON: só SNMP (enterprise 34592: lista de MACs autorizados + ONUs registradas), conferido em OLT real
//   Os 3 últimos foram feitos SEM OLT real (25/11/2026): ver HISTORICO.md o que falta conferir.
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
// C220/C300 usa "gpon-onu_" no lugar de "gpon_onu-"; formato da tabela de quedas igual (a confirmar no C220).
async function historicoZte(o, index, tipo = "zte") {
  const r = await olts.lerComandos(o.id, [`show gpon onu detail-info ${tipo === "zte_c220" ? "gpon-onu_" : "gpon_onu-"}${index}`]);
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
    // RX das ONUs pelo Telnet: opção da OLT (ligada por padrão na V-SOL, como sempre foi)
    cmds.push(`interface epon ${p}`, "show onu status", ...(o.rxTelnet !== false ? ["show onu opm-diag"] : []));
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
      // ONU-ID Status MAC Distance(m) RTT(TQ) LastRegTime LastDeregTime LastDeregReason AliveTime
      const m = l.trim().match(/^EPON(\S+):(\d+)\s+(online|offline)\s+(\S+)\s+(\S+)\s+\S+\s+(N\/A|\d{4}\/\S+ \S+)\s+(N\/A|\d{4}\/\S+ \S+)\s+(\S.*?)\s+(\d+:\d\d:\d\d)/i); // motivo pode ter espaço ("Power Off")
      if (!m) continue;
      const reg = dataOlt(m[6]);
      const [hh, mm, ss] = m[9].split(":").map(Number);
      if (m[3] === "online" && reg && offset === null) offset = reg + (hh * 3600 + mm * 60 + ss) * 1000 - Date.now();
      const dist = Number(m[5]);
      onus.push({ index: `${m[1]}:${m[2]}`, mac: normMac(m[4]), online: m[3] === "online", estadoOlt: m[3],
        distancia: m[3] === "online" && dist > 0 && dist < 100000 ? dist : null,
        causa: m[3] === "online" ? null : causaDe(m[8]) || "outro", ultimaQuedaOlt: dataOlt(m[7]), motivo: m[8] === "N/A" ? null : m[8] });
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

// ---------- ZTE C220 (geração antiga: MIB 3902.1012, CLI "gpon-olt_1/2/1") ----------
// Levantado em documentação/fóruns (C300/C320 v1.x, mesma árvore do C220), SEM OLT real. A confirmar:
//   serial 3902.1012.3.28.1.1.5 (8 bytes "ZTEG"+4 bytes, como no C610) e fase 3902.1012.3.28.2.1.4
//   (mesma numeração do C610: 1 logging, 2 LOS, 3 syncMib, 4 working, 5 DyingGasp, 6 authFailed, 7 OffLine);
//   índice .<ifIndex PON>.<id ONU>, ifIndex = 0x1 tipo | rack 4 bits | shelf 8 | slot 8 | porta 8 (porta começa em 0).
//   RX na ONU 3902.1012.3.50.12.1.1.10.<ifIndex>.<id>.1: dBm = valor × 0,002 − 30 (65535 = sem leitura).
const C220_OID = { sn: "1.3.6.1.4.1.3902.1012.3.28.1.1.5", fase: "1.3.6.1.4.1.3902.1012.3.28.2.1.4" };
const C220_RX = "1.3.6.1.4.1.3902.1012.3.50.12.1.1.10";
const c220Pon = (x) => `${(x >>> 16) & 0xff}/${(x >>> 8) & 0xff}/${(x & 0xff) + 1}`;
async function coletarZteC220Snmp(o) {
  const t = await olts.snmpColunas(o.id, Object.values(C220_OID));
  const por = {};
  for (const [nome, oid] of Object.entries(C220_OID)) for (const vb of t[oid]) {
    const p = vb.oid.slice(oid.length + 1).split(".");
    if (p.length < 2) continue;
    const pon = Number(p[0]), id = p[1];
    const index = `${c220Pon(pon)}:${id}`;
    (por[index] = por[index] || { index, ref: `${pon}.${id}` })[nome] = vb.value;
  }
  return Object.values(por).filter((x) => x.fase !== undefined).map((x) => {
    const estado = ZTE_FASE[x.fase] || `fase ${x.fase}`;
    const online = Number(x.fase) === 4;
    let sn = snDeHex(x.sn);
    if (!sn) sn = (load().onus[`${o.id}|${x.index}`] || {}).sn || "";
    return { index: x.index, ref: x.ref, sn, online, estadoOlt: estado, causa: online ? null : causaDe(estado) || "outro" };
  });
}
// Telnet (reserva): "show gpon onu state" (todas as PONs; se o firmware exigir a PON, lê a lista da configuração)
//   gpon-onu_1/2/1:1   enable   enable   operation   working
// e "show gpon onu baseinfo gpon-olt_1/2/1" (linha com "SN:ZTEG...", igual ao C610).
const FASES_RE = /^(working|los|losi|dyinggasp|dying-gasp|offline|logging|syncmib|authfailed|lofi|lof)$/i;
const ponsC220 = {};
function lerEstadoC220(txt) {
  const out = [];
  for (const l of String(txt).split("\n")) {
    const m = l.trim().match(/^(?:gpon-onu_)?(\d+\/\d+\/\d+):(\d+)\s+(.+)$/);
    if (!m) continue;
    const tk = m[3].trim().split(/\s+/);
    const fase = tk.find((x) => FASES_RE.test(x)) || tk[tk.length - 1];
    out.push({ index: `${m[1]}:${m[2]}`, pon: m[1], estadoOlt: fase });
  }
  return out;
}
async function coletarZteC220(o) {
  let onus = lerEstadoC220((await olts.lerComandos(o.id, ["terminal length 0", "show gpon onu state"])).saidas[1].saida);
  if (!onus.length) {
    let pons = (ponsC220[o.id] && Date.now() - ponsC220[o.id].em < 86400000) ? ponsC220[o.id].pons : null;
    if (!pons) {
      const r0 = await olts.lerComandos(o.id, ["terminal length 0", "show running-config"]);
      pons = [...new Set([...r0.saidas[1].saida.matchAll(/^\s*interface gpon-(?:olt|onu)_(\d+\/\d+\/\d+)/gm)].map((m) => m[1]))];
      ponsC220[o.id] = { pons, em: Date.now() };
    }
    if (!pons.length) throw new Error("nenhuma PON GPON encontrada (show gpon onu state / show running-config)");
    const r = await olts.lerComandos(o.id, ["terminal length 0", ...pons.map((p) => `show gpon onu state gpon-olt_${p}`)]);
    onus = r.saidas.slice(1).flatMap((s) => lerEstadoC220(s.saida));
  }
  const pons = [...new Set(onus.map((x) => x.pon))];
  const sn = {};
  const r2 = await olts.lerComandos(o.id, ["terminal length 0", ...pons.map((p) => `show gpon onu baseinfo gpon-olt_${p}`)]);
  for (const s of r2.saidas) for (const l of s.saida.split("\n")) {
    const m = l.trim().match(/^gpon-onu_(\S+)\s+.*?SN:(\S+)/);
    if (m) sn[m[1]] = normSn(m[2]);
  }
  return onus.map((x) => {
    const online = /^working$/i.test(x.estadoOlt);
    return { index: x.index, sn: sn[x.index] || "", online, estadoOlt: x.estadoOlt, causa: online ? null : causaDe(x.estadoOlt) || "outro" };
  });
}

// ---------- FiberHome AN5516 / AN6000 (MIB própria, enterprise 5875) ----------
// Levantado na biblioteca snmp-fiberhome (testada em AN5516-01/06) e em fóruns, SEM OLT real. A confirmar:
//   tabela de ONUs autorizadas 5875.800.3.10.1.1: .10 serial GPON (texto "FHTT1234abcd") ou MAC (EPON), .11 estado;
//   AN5516: 0 = fibra cortada (LOS), 1 = online, 2 = sem energia (dying gasp), 3 = offline. AN6000: assume a mesma numeração.
//   índice da ONU = slot·2^25 + PON·2^19 + ONU·2^8  -> "slot/PON:ONU" (ex.: 11/1:5)
//   RX na ONU 5875.800.3.9.3.3.1.6.<índice> em centésimos de dBm (a confirmar); temperatura 5875.800.3.9.4.5 (°C).
// Sem Telnet de reserva: a CLI muda muito entre versões (AN5516 "cd gpononu"; AN6000 estilo Cisco) e não foi levantada.
const FH_OID = { sn: "1.3.6.1.4.1.5875.800.3.10.1.1.10", estado: "1.3.6.1.4.1.5875.800.3.10.1.1.11" };
const FH_RX = "1.3.6.1.4.1.5875.800.3.9.3.3.1.6";
const FH_TEMP = "1.3.6.1.4.1.5875.800.3.9.4.5";
const FH_ESTADO = { 0: ["LOS", "fibra"], 1: ["online", null], 2: ["PowerOff", "energia"], 3: ["offline", "outro"] };
const fhIndex = (x) => `${x >>> 25}/${(x >>> 19) & 0x3f}:${(x >>> 8) & 0x7ff}`;
async function coletarFhSnmp(o) {
  const t = await olts.snmpColunas(o.id, Object.values(FH_OID));
  const por = {};
  for (const [nome, oid] of Object.entries(FH_OID)) for (const vb of t[oid]) {
    const ifx = Number(vb.oid.slice(oid.length + 1));
    if (!ifx) continue;
    (por[ifx] = por[ifx] || { ifx })[nome] = vb.value;
  }
  return Object.values(por).filter((x) => x.estado !== undefined).map((x) => {
    const [estado, causa] = FH_ESTADO[x.estado] || [`estado ${x.estado}`, "outro"];
    const online = Number(x.estado) === 1;
    // EPON devolve o MAC da ONU; GPON o serial (texto ou 8 bytes)
    const bruto = String(x.sn || "").trim();
    const mac = /^([0-9a-f]{2}[:\-.]?){5}[0-9a-f]{2}$/i.test(bruto) ? normMac(bruto) : "";
    return { index: fhIndex(x.ifx), ref: x.ifx, sn: mac ? "" : snDeHex(bruto), mac, online, estadoOlt: estado, causa: online ? null : causa };
  });
}

// ---------- Cianet EPON 4 PON (MIB própria, enterprise 34592; "EPON System", firmware OLT-1.5.27s) ----------
// Conferido em OLT real (Superi "SERTAO RIO DOCE", 172.16.7.86, 26/11/2026):
//   ONUs registradas (online) 34592.1.3.3.12.1.1.4.<slot>.<PON>.<ONU> = MAC (12 hex; alguns chegam como bytes);
//   MACs autorizados 34592.1.3.1.6.3.1.2.<n> (todas as online estão nela: quem está na lista e não registrou = offline).
//   Não informa por SNMP o motivo da queda nem o sinal (RX); a CLI Telnet só tem "show vlan/trunk".
const CIANET_ONLINE = "1.3.6.1.4.1.34592.1.3.3.12.1.1.4";
const CIANET_AUTORIZADOS = "1.3.6.1.4.1.34592.1.3.1.6.3.1.2";
// MAC em texto hex ou em 6 bytes (o snmp.js devolve como texto quando os bytes formam UTF-8 válido)
function macCianet(v) {
  const s = String(v ?? "");
  if (/^([0-9a-f]{2}[:\-.]?){5}[0-9a-f]{2}$/i.test(s.trim())) return normMac(s);
  // Sem trim aqui: o último byte do MAC pode ser 0x20 (espaço), ex.: 50:3d:d1:9a:7b:20
  const b = Buffer.from(s, "utf8");
  return b.length === 6 ? b.toString("hex") : "";
}
async function coletarCianetSnmp(o) {
  const t = await olts.snmpColunas(o.id, [CIANET_ONLINE, CIANET_AUTORIZADOS]);
  const onus = [], vistos = new Set();
  for (const vb of t[CIANET_ONLINE]) {
    const p = vb.oid.slice(CIANET_ONLINE.length + 1).split(".");
    const mac = macCianet(vb.value);
    if (p.length !== 3 || !mac) continue;
    vistos.add(mac);
    onus.push({ index: `${p[0]}/${p[1]}:${p[2]}`, mac, sn: "", online: true, estadoOlt: "online", causa: null });
  }
  // Offline: autorizada e não registrada. A OLT não diz a porta; usa a posição da última vez que foi vista online.
  const ant = {};
  for (const x of Object.values(load().onus)) if (x.olt === o.id && x.mac && !String(x.index).startsWith("?")) ant[x.mac] = x.index;
  for (const vb of t[CIANET_AUTORIZADOS]) {
    const mac = macCianet(vb.value);
    if (!mac || vistos.has(mac)) continue;
    vistos.add(mac);
    onus.push({ index: ant[mac] || `?:${mac}`, mac, sn: "", online: false, estadoOlt: "offline", causa: "outro" });
  }
  return onus;
}

// ---------- Huawei MA5608T / MA5800-X2/X15/X17 (HUAWEI-XPON-MIB, enterprise 2011) ----------
// Conferido na MIB (mibs.observium.org) e em OLTs reais em 25/11/2026 (MA5608T V800R015, MA5800-X2 V100R019, X15 V100R020,
// X17): serial, estado, causa, RX na ONT e na OLT batem com "display ont info" / "display ont optical-info". Tabelas indexadas por .<ifIndex da PON>.<id da ONT>:
//   serial 2011.6.128.1.1.2.43.1.3 (8 bytes "HWTC"+4 bytes), estado 46.1.15 (1 up, 2 down, -1 sem leitura),
//   última causa de queda 46.1.24 (1 LOS, 2 LOSi/LOBi, 3 LOFi, 4 SFi, 5 LOAi, 6 LOAMi, 9 reset, 13 dying-gasp ...),
//   RX na ONT 51.1.4 (centésimos de dBm); RX da ONT na OLT 51.1.6 (dBm = (valor - 10000) / 100).
//   Porta PON: nome pelo ifDescr ("...GPON_UNI 0/1/0"; a MA5608T não traz o número -> fórmula, conferida); reserva: ifIndex = 0xFA000000 + quadro·2^18 + slot·2^13 + porta·2^8.
//   Temperatura das placas: 2011.2.6.7.1.1.2.1.10 (°C).
const HW_OID = {
  sn: "1.3.6.1.4.1.2011.6.128.1.1.2.43.1.3",
  estado: "1.3.6.1.4.1.2011.6.128.1.1.2.46.1.15",
  causa: "1.3.6.1.4.1.2011.6.128.1.1.2.46.1.24",
};
const HW_RX_ONT = "1.3.6.1.4.1.2011.6.128.1.1.2.51.1.4";
const HW_RX_OLT = "1.3.6.1.4.1.2011.6.128.1.1.2.51.1.6";
const HW_DIST = "1.3.6.1.4.1.2011.6.128.1.1.2.46.1.20";
const HW_TEMP = "1.3.6.1.4.1.2011.2.6.7.1.1.2.1.10";
const HW_CAUSA = {
  1: "LOS", 2: "LOSi", 3: "LOFi", 4: "SFi", 5: "LOAi", 6: "LOAMi", 7: "desativar falhou", 8: "desativada", 9: "reset",
  10: "re-registro", 11: "pop up fail", 13: "dying-gasp", 15: "LOKi", 18: "desativada (anel)", 30: "laser desligado",
  31: "reset por comando", 32: "reset pelo botão", 33: "reset pelo software", 34: "desativada (ataque broadcast)",
  35: "operator check fail", 37: "ONT rogue",
};
function hwPon(ifx) {
  const r = Number(ifx) - 0xfa000000;
  if (!(r >= 0)) return String(ifx);
  return `${r >>> 18}/${(r >>> 13) & 0x1f}/${(r >>> 8) & 0x1f}`;
}
// Nome das PONs pelo IF-MIB (guardado 1 dia por OLT)
const hwPons = {};
async function nomesPonHw(o, ifxs) {
  const c = hwPons[o.id] && Date.now() - hwPons[o.id].em < 86400000 ? hwPons[o.id] : (hwPons[o.id] = { em: Date.now(), nomes: {} });
  const falta = ifxs.filter((x) => !(x in c.nomes));
  if (falta.length) {
    try {
      for (const vb of await olts.snmpGetLote(o.id, falta.map((x) => `1.3.6.1.2.1.2.2.1.2.${x}`))) {
        const m = String(vb.value || "").match(/(\d+)\/(\d+)\/(\d+)/);
        c.nomes[ultimo(vb.oid).pop()] = m ? `${m[1]}/${m[2]}/${m[3]}` : null;
      }
    } catch {}
    for (const x of falta) if (!c.nomes[x]) c.nomes[x] = hwPon(x);
  }
  return c.nomes;
}
async function coletarHuaweiSnmp(o) {
  const t = await olts.snmpColunas(o.id, Object.values(HW_OID));
  const por = {};
  for (const [nome, oid] of Object.entries(HW_OID)) for (const vb of t[oid]) {
    const p = vb.oid.slice(oid.length + 1).split(".");
    if (p.length !== 2) continue;
    const k = `${p[0]}.${p[1]}`;
    (por[k] = por[k] || { ifx: p[0], ont: p[1], ref: k })[nome] = vb.value;
  }
  const lista = Object.values(por).filter((x) => x.estado !== undefined);
  const nomes = await nomesPonHw(o, [...new Set(lista.map((x) => x.ifx))]);
  return lista.map((x) => {
    const online = Number(x.estado) === 1;
    const motivo = HW_CAUSA[x.causa] || (Number(x.causa) > 0 ? `código ${x.causa}` : null);
    const causa = online ? null : Number(x.causa) === 13 ? "energia" : [1, 2, 3, 4, 5, 6, 15].includes(Number(x.causa)) ? "fibra" : "outro";
    return { index: `${nomes[x.ifx] || hwPon(x.ifx)}:${x.ont}`, ref: x.ref, sn: snDeHex(x.sn), online,
      estadoOlt: online ? "online" : Number(x.estado) === 2 ? "offline" : "sem leitura", causa, motivo: online ? null : motivo };
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
    // Distância (m) 500.10.2.3.10.1.2: conferida em 25/11/2026 com "show gpon onu detail-info" (ONU Distance: 2261m)
    const oids = alvo.flatMap((x) => [`1.3.6.1.4.1.3902.1082.500.1.2.4.2.1.2.${x.ref}`, `1.3.6.1.4.1.3902.1082.500.10.2.3.2.2.1.2.${x.ref}`, `1.3.6.1.4.1.3902.1082.500.10.2.3.2.2.1.28.${x.ref}`, `1.3.6.1.4.1.3902.1082.500.10.2.3.10.1.2.${x.ref}`]);
    const v = {}; for (const vb of await olts.snmpGetLote(o.id, oids)) v[vb.oid] = vb.value;
    for (const x of alvo) {
      const rx = Number(v[`1.3.6.1.4.1.3902.1082.500.1.2.4.2.1.2.${x.ref}`]);
      const up = v[`1.3.6.1.4.1.3902.1082.500.10.2.3.2.2.1.2.${x.ref}`], down = v[`1.3.6.1.4.1.3902.1082.500.10.2.3.2.2.1.28.${x.ref}`];
      const dist = Number(v[`1.3.6.1.4.1.3902.1082.500.10.2.3.10.1.2.${x.ref}`]);
      const rxOlt = rx > -50000 && rx < 10000 ? Math.round(rx / 10) / 100 : null;
      x.medida = { rx: rxOlt, lado: "olt", rxOlt, dist: dist > 0 && dist < 100000 ? dist : null,
        up: typeof up === "number" ? up : null, down: typeof down === "number" ? down : null };
    }
  } else if (o.tipo === "nokia") {
    const v = {}; for (const vb of await olts.snmpGetLote(o.id, alvo.map((x) => `1.3.6.1.4.1.637.61.1.35.10.18.1.2.${x.ref}`))) v[ultimo(vb.oid).pop()] = vb.value;
    for (const x of alvo) { const rx = Number(v[x.ref]); const rxOlt = rx > -500 && rx < 100 ? rx / 10 : null; x.medida = { rx: rxOlt, lado: "olt", rxOlt }; }
  } else if (o.tipo === "zte_c220") {
    const v = {}; for (const vb of await olts.snmpGetLote(o.id, alvo.map((x) => `${C220_RX}.${x.ref}.1`))) v[vb.oid] = vb.value;
    for (const x of alvo) {
      const bruto = v[`${C220_RX}.${x.ref}.1`];
      const rx = typeof bruto === "number" && bruto !== 65535 ? Math.round((bruto * 0.002 - 30) * 100) / 100 : null;
      x.medida = { rx: rx != null && rx > -50 && rx < 10 ? rx : null, lado: "onu" };
    }
  } else if (o.tipo === "fh_an5516" || o.tipo === "fh_an6000") {
    const v = {}; for (const vb of await olts.snmpGetLote(o.id, alvo.map((x) => `${FH_RX}.${x.ref}`))) v[ultimo(vb.oid).pop()] = vb.value;
    for (const x of alvo) { const rx = Number(v[x.ref]); x.medida = { rx: Number.isFinite(rx) && rx > -5000 && rx < 1000 && rx !== 0 ? rx / 100 : null, lado: "onu" }; }
  } else if (olts.ehHuawei(o.tipo)) {
    // RX na ONT (gráfico); se ela não informar, o RX da ONT medido na OLT. Distância 46.1.20 (m), conferida com "ONT distance(m)".
    const v = {}; for (const vb of await olts.snmpGetLote(o.id, alvo.flatMap((x) => [`${HW_RX_ONT}.${x.ref}`, `${HW_RX_OLT}.${x.ref}`, `${HW_DIST}.${x.ref}`]))) v[vb.oid] = vb.value;
    for (const x of alvo) {
      const a = Number(v[`${HW_RX_ONT}.${x.ref}`]), b = Number(v[`${HW_RX_OLT}.${x.ref}`]), d = Number(v[`${HW_DIST}.${x.ref}`]);
      const ont = Number.isFinite(a) && a > -5000 && a < 1000 && a !== 0 ? a / 100 : null;
      const olt = Number.isFinite(b) && b > 5000 && b < 11000 ? Math.round(b - 10000) / 100 : null;
      x.medida = { ...(ont != null ? { rx: ont, lado: "onu" } : { rx: olt, lado: olt != null ? "olt" : "onu" }),
        rxOlt: olt, dist: d > 0 && d < 100000 ? d : null };
    }
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
  // Firmwares diferentes: "The olt has been running for 7 days ..." ou "Syetem Running Time:  20 Hours 54 Minutes ..."
  const up = r.saidas[1].saida.match(/running (?:for|time\s*:)\s*(.+)/i);
  if (up) out.ligadoSeg = durTxt(up[1]);
  const tm = r.saidas[2].saida.match(/current temperature\s*:\s*(-?[\d.]+)/i);
  if (tm) {
    out.temp = Number(tm[1]);
    out.nivel = out.temp >= VSOL_TEMP.bad ? "bad" : out.temp >= VSOL_TEMP.warn ? "warn" : "ok";
  }
  return out;
}
// ZTE C220 e FiberHome: limites não conferidos na OLT -> mesmos valores conservadores da V-SOL
const nivelTemp = (t) => (t >= VSOL_TEMP.bad ? "bad" : t >= VSOL_TEMP.warn ? "warn" : "ok");
// Temperaturas soltas num texto da CLI: linhas com "temp" e um número de 0 a 120 (ex.: "Temperature : 45 C")
function tempsDeTexto(txt) {
  const out = [];
  for (const l of String(txt).split("\n")) {
    if (!/temp/i.test(l) || /threshold|limit|alarm/i.test(l)) continue;
    const m = l.match(/temp\w*[^\d\-]*(-?\d+(?:\.\d+)?)/i);
    if (m && +m[1] > 0 && +m[1] < 120) out.push({ nome: l.trim().split(/\s{2,}|:/)[0].slice(0, 30), temp: +m[1] });
  }
  return out;
}
// C220: placa de controle (SNMP 3902.1015.2.1.3.2, a confirmar) ou CLI "show environment"
async function statusZteC220(o) {
  const out = { nivel: "ok", pontos: [] };
  if (o.temCommunity) {
    try {
      const t = await olts.snmpColunas(o.id, ["1.3.6.1.4.1.3902.1015.2.1.3.2"], 50);
      for (const vb of t["1.3.6.1.4.1.3902.1015.2.1.3.2"]) if (typeof vb.value === "number" && vb.value > 0 && vb.value < 120) out.pontos.push({ nome: `placa ${ultimo(vb.oid).pop()}`, temp: vb.value });
    } catch {}
  }
  if (!out.pontos.length) {
    try { out.pontos = tempsDeTexto((await olts.lerComandos(o.id, ["show environment"])).saidas[0].saida); } catch {}
  }
  if (out.pontos.length) { out.temp = Math.max(...out.pontos.map((p) => p.temp)); out.nivel = nivelTemp(out.temp); }
  return out;
}
// FiberHome: temperatura do equipamento (SNMP 5875.800.3.9.4.5, °C inteiro, a confirmar)
async function statusFh(o) {
  const t = await olts.snmpColunas(o.id, [FH_TEMP], 50);
  const out = { nivel: "ok", pontos: [] };
  for (const vb of t[FH_TEMP]) if (typeof vb.value === "number" && vb.value > 0 && vb.value < 120) out.pontos.push({ nome: `sensor ${vb.oid.slice(FH_TEMP.length + 1) || 0}`, temp: vb.value });
  if (out.pontos.length) { out.temp = Math.max(...out.pontos.map((p) => p.temp)); out.nivel = nivelTemp(out.temp); }
  return out;
}
// Huawei: temperatura de cada placa (SNMP 2011.2.6.7.1.1.2.1.10, °C; placa vazia volta 2147483647) e o nome dela (.7).
// Conferido em 25/11/2026 com "display temperature 0/3" (MA5608T: controladora H801MCUD1 a 72 °C trabalhando normal).
// A controladora da Huawei trabalha quente e a OLT não informa o limite por SNMP: aviso a partir de 75 °C, alarme a 85 °C.
const HW_NOME_PLACA = "1.3.6.1.4.1.2011.2.6.7.1.1.2.1.7";
const HW_TEMP_LIM = { warn: 75, bad: 85 };
async function statusHuawei(o) {
  const t = await olts.snmpColunas(o.id, [HW_TEMP, HW_NOME_PLACA], 100);
  const nomes = {}; for (const vb of t[HW_NOME_PLACA]) nomes[vb.oid.slice(HW_NOME_PLACA.length + 1)] = String(vb.value || "").trim();
  const out = { nivel: "ok", pontos: [] };
  for (const vb of t[HW_TEMP]) {
    if (typeof vb.value !== "number" || vb.value <= 0 || vb.value >= 120) continue;
    const k = vb.oid.slice(HW_TEMP.length + 1);
    out.pontos.push({ nome: `placa ${k.replace(/^0\./, "")}${nomes[k] ? " " + nomes[k] : ""}`, temp: vb.value });
  }
  if (out.pontos.length) {
    out.temp = Math.max(...out.pontos.map((p) => p.temp));
    out.nivel = out.temp >= HW_TEMP_LIM.bad ? "bad" : out.temp >= HW_TEMP_LIM.warn ? "warn" : "ok";
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
    else if (o.tipo === "zte_c220") s = await statusZteC220(o);
    else if ((o.tipo === "fh_an5516" || o.tipo === "fh_an6000") && o.temCommunity) s = await statusFh(o);
    else if (olts.ehHuawei(o.tipo) && o.temCommunity) s = await statusHuawei(o);
    else return;
    // Tempo ligada lido pelo SNMP na coleta vale quando a leitura própria não trouxe
    if (s.ligadoSeg == null && c.ligadoSeg != null) s.ligadoSeg = c.ligadoSeg;
    db.status[o.id] = { em: agora, ...s };
  } catch (e) {
    // Mantém a última leitura boa, só marca o erro (tenta de novo na próxima coleta)
    db.status[o.id] = { ...(db.status[o.id] || {}), erro: e.message, erroEm: agora };
  }
}

// Leitura por SNMP de cada tipo (os outros só por Telnet)
const COLETA_SNMP = { zte: coletarZteSnmp, nokia: coletarNokiaSnmp, zte_c220: coletarZteC220Snmp, fh_an5516: coletarFhSnmp, fh_an6000: coletarFhSnmp, cianet_epon: coletarCianetSnmp };
for (const t of Object.keys(olts.TIPOS)) if (olts.ehHuawei(t)) COLETA_SNMP[t] = coletarHuaweiSnmp;
// Quem informa tráfego por ONU (gráfico da página do dispositivo)
const COM_TRAFEGO = new Set(["zte", "vsol"]);

// Quem fornece a lista de aparelhos do ACS (definido em iniciar); usado para saber quais ONUs medir
let aparelhosFn = null;

// ---------- Coleta geral ----------
let rodando = false;
// forcar = true (botão "Ler ONUs agora"): lê todas, sem esperar o intervalo próprio de cada tipo
async function coletar(forcar = false) {
  if (rodando) return;
  load();
  // Cada OLT tem o seu intervalo (5, 10 ou 20 min) e pode estar com a consulta desligada; o relógio passa a cada minuto
  // e só lê as que estão na hora (o "Ler ONUs agora" lê todas as ligadas)
  const naHora = olts.listar().filter((o) => {
    if (!o.ativo) return false;
    if (forcar) return true;
    const ult = db.coletas[o.id];
    if (!ult || !ult.em) return true;
    const desde = Date.now() - Date.parse(ult.em);
    // O intervalo maior da Nokia vale só para o Telnet (lento); por SNMP ela segue o intervalo da OLT
    const minTipo = INTERVALO_TIPO[o.tipo];
    if (minTipo && ult.ok && ult.via !== "snmp" && desde < (minTipo - 1) * 60000) return false;
    return desde >= o.intervaloMin * 60000 - 30000;
  });
  if (!naHora.length) return;
  rodando = true;
  loadS();
  const agora = new Date().toISOString();
  // ONUs ligadas a aparelhos do ACS (as únicas que ganham gráfico de sinal/tráfego)
  const vinc = new Set();
  // RX que o próprio aparelho informa ao ACS (TR-069): usado no gráfico quando a OLT não mede (Cianet EPON)
  const rxAcs = {};
  if (aparelhosFn) {
    try { for (const d of await aparelhosFn()) { const k = acharOnu(d); if (k) { vinc.add(k.key); if (d.rx != null) rxAcs[k.key] = d.rx; } } }
    catch (e) { console.error("coleta OLT: lista de aparelhos:", e.message); }
  }
  try {
    for (const o of naHora) {
      const c = { em: agora, ok: false };
      try {
        let onus, extra = {};
        const t0 = Date.now();
        if (COLETA_SNMP[o.tipo] && o.temCommunity) {
          // SNMP primeiro; se a OLT não responder, cai para o Telnet
          try {
            onus = await COLETA_SNMP[o.tipo](o);
            if (!onus.length) throw new Error("tabela SNMP vazia");
            extra.via = "snmp";
          } catch (e) { extra.snmpErro = e.message; onus = null; }
        }
        if (!onus) {
          if (o.tipo === "zte") onus = await coletarZte(o);
          else if (o.tipo === "vsol") ({ onus, ...extra } = await coletarVsol(o, vinc));
          else if (o.tipo === "nokia") onus = await coletarNokia(o);
          else if (o.tipo === "zte_c220") onus = await coletarZteC220(o);
          else if (o.tipo === "fh_an5516" || o.tipo === "fh_an6000") throw new Error(o.temCommunity ? `SNMP falhou (${extra.snmpErro}); a FiberHome é lida só por SNMP` : "a FiberHome é lida só por SNMP: cadastre a community");
          else if (olts.ehHuawei(o.tipo)) throw new Error(o.temCommunity ? `SNMP falhou (${extra.snmpErro}); a Huawei é lida só por SNMP` : "a Huawei é lida só por SNMP: cadastre a community");
          else if (o.tipo === "cianet_epon") throw new Error(o.temCommunity ? `SNMP falhou (${extra.snmpErro}); a Cianet é lida só por SNMP` : "a Cianet é lida só por SNMP: cadastre a community");
          else continue;
          extra.via = "telnet";
        }
        if (extra.via === "snmp") { try { await medirSnmp(o, onus, vinc); } catch (e) { extra.medidaErro = e.message; } }
        // RX pelo Telnet (opção da OLT): FiberHome, só das ONUs ligadas a aparelhos que ficaram sem RX pelo SNMP
        if (o.rxTelnet && o.tipo === "fh_an5516") { try { extra.rxTelnet = await rxTelnetFh(o, onus, vinc); } catch (e) { extra.rxTelnetErro = e.message; } }
        // Tempo ligada (para o quadro do dashboard). V-SOL fica de fora: o agente SNMP dela trava.
        if (extra.via === "snmp") { const s = await tempoLigada(o); if (s != null) extra.ligadoSeg = s; }
        extra.segundos = Math.round((Date.now() - t0) / 100) / 10;
        for (const x of onus) {
          const key = `${o.id}|${x.index}`;
          if (!vinc.has(key)) continue;
          if (o.tipo === "cianet_epon" && x.online && rxAcs[key] != null && !(x.medida && x.medida.rx != null)) x.medida = { ...(x.medida || {}), rx: rxAcs[key], lado: "onu" };
          registrarSerie(key, agora, x);
        }
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
            online: x.online, estadoOlt: x.estadoOlt, causa: x.causa, motivo: x.motivo || null, rx: x.rx ?? null, visto: agora,
            // RX da ONU medido na OLT e distância (só das ONUs ligadas a aparelhos do ACS; V-SOL informa a distância de todas)
            rxOlt: (x.medida && x.medida.rxOlt) ?? null, distancia: x.distancia ?? (x.medida && x.medida.dist) ?? null };
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

// FiberHome AN5516 pelo Telnet: "cd gpononu" → "show optic_module slot S link P onu N" (campo "RECV POWER", dBm).
// Comando conferido numa AN5516 real em 25/11/2026 (mesmo valor do SNMP); o texto exato da saída ainda a conferir.
// Máximo de 40 ONUs por leitura (1 comando por ONU) para não segurar a sessão da OLT.
async function rxTelnetFh(o, onus, vinc) {
  const alvo = onus.filter((x) => x.online && vinc.has(`${o.id}|${x.index}`) && !(x.medida && x.medida.rx != null)).slice(0, 40);
  if (!alvo.length) return 0;
  const cmd = (x) => { const m = x.index.match(/^(\d+)\/(\d+):(\d+)$/); return m ? `show optic_module slot ${m[1]} link ${m[2]} onu ${m[3]}` : null; };
  const comAlvo = alvo.filter(cmd);
  const r = await olts.lerComandos(o.id, ["cd gpononu", ...comAlvo.map(cmd)]);
  let n = 0;
  comAlvo.forEach((x, i) => {
    const s = (r.saidas[i + 1] || {}).saida || "";
    const m = s.match(/RECV\s*POWER[^-\d]*(-?\d+(?:\.\d+)?)/i);
    const rx = m ? Number(m[1]) : NaN;
    if (Number.isFinite(rx) && rx > -50 && rx < 10) { x.medida = { ...(x.medida || {}), rx, lado: "onu" }; n++; }
  });
  return n;
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
  // Huawei (e outras): serial TR-069 com o fabricante em hexa — "HWTC1A2B3C4D" na OLT = "485754431A2B3C4D" no ACS
  if (/^[0-9A-F]{16}$/.test(serial)) {
    const sn = Buffer.from(serial.slice(0, 8), "hex").toString("latin1") + serial.slice(8);
    if (/^[A-Z0-9]{4}/.test(sn)) for (const [k, x] of candidatos) if (x.sn === sn) return { key: k, ...x };
  }
  // Realtek (ex.: FW323DAC): serial TR-069 "12345006D61AAAFE0" e serial GPON "GPON00AAAFE0" -> a parte hexa do
  // serial GPON, sem os zeros à esquerda, é o fim do serial TR-069 (conferido 25/11/2026 pelo RX na OLT FiberHome)
  if (serial.length >= 12) {
    for (const [k, x] of candidatos) {
      const hex = /^[A-Z]{4}[0-9A-F]{8}$/.test(x.sn) ? x.sn.slice(4).replace(/^0+/, "") : "";
      if (hex.length >= 6 && serial.endsWith(hex)) return { key: k, ...x };
    }
  }
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
  if (comHistoricoZte && (onu.oltTipo === "zte" || onu.oltTipo === "zte_c220")) {
    let c = cacheZte.get(onu.key);
    if (!c || Date.now() - c.em > 600000) {
      try { c = { em: Date.now(), lista: await historicoZte({ id: onu.olt }, onu.index, onu.oltTipo) }; cacheZte.set(onu.key, c); } catch { c = null; }
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
  const temTrafego = COM_TRAFEGO.has(onu.oltTipo);
  return {
    onu: { olt: onu.oltNome, tipo: onu.oltTipo, tipoNome: olts.TIPOS[onu.oltTipo] || onu.oltTipo, index: onu.index, online: onu.online, causa: onu.causa, visto: onu.visto },
    lado: s.lado || (["zte", "nokia"].includes(onu.oltTipo) ? "olt" : "onu"), temTrafego,
    intervaloMin: (olts.listar().find((o) => o.id === onu.olt) || {}).intervaloMin || INTERVALO_MIN,
    pontos: s.pts.filter((p) => p[0] >= desde).map(([t, rx, down, up, st]) => ({ t, rx, down, up, st })),
  };
}

// listarAparelhos: função que devolve os aparelhos do ACS (para saber quais ONUs medir)
function iniciar(listarAparelhos) {
  aparelhosFn = listarAparelhos || null;
  setTimeout(() => coletar().catch((e) => console.error("coleta OLT:", e.message)), 20000);
  // A cada minuto: cada OLT é lida quando passa o intervalo dela (5, 10 ou 20 min)
  setInterval(() => coletar().catch((e) => console.error("coleta OLT:", e.message)), 60000).unref();
}

module.exports = { coletar, onuDoAparelho, acharOnu, confirmarEventos, resumo, iniciar, causaDe, serieDoAparelho, totais };
