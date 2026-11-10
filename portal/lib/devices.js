"use strict";
// Normaliza os documentos do GenieACS para o formato usado pelo portal
const nbi = require("./nbi");
const { ONLINE_MINUTES } = require("./env");

// Potência óptica: TP-Link XX530v (TR-181) informa em décimos de µW
const RX_PATHS = ["Device.Optical.Interface.1.X_TP_GPON_Config.RXPower"];
const TX_PATHS = ["Device.Optical.Interface.1.X_TP_GPON_Config.TXPower"];

// Versão do firmware: o virtual parameter não é recalculado depois de uma atualização,
// então usa a leitura mais recente entre ele e os parâmetros do próprio equipamento
const SOFTWARE_PATHS = ["Device.DeviceInfo.SoftwareVersion", "InternetGatewayDevice.DeviceInfo.SoftwareVersion", "VirtualParameters.SoftwareVersion"];

const PROJECTION = [
  "_id", "_deviceId", "_lastInform", "_registered", "_tags",
  "VirtualParameters.IP", "VirtualParameters.WANIP", "VirtualParameters.LANIP",
  "VirtualParameters.MAC", "VirtualParameters.SSID", ...SOFTWARE_PATHS,
  ...RX_PATHS, ...TX_PATHS,
].join(",");

function get(doc, path) {
  let o = doc;
  for (const k of path.split(".")) {
    if (o == null) return undefined;
    o = o[k];
  }
  return o;
}

function val(doc, path) {
  const o = get(doc, path);
  return o && o._value !== undefined ? o._value : undefined;
}

// Valor com a data de leitura mais recente entre vários caminhos
function freshest(doc, paths) {
  let best = null;
  for (const p of paths) {
    const o = get(doc, p);
    if (!o || o._value === undefined || o._value === "") continue;
    const t = o._timestamp ? Date.parse(o._timestamp) : 0;
    if (!best || t > best.t) best = { v: String(o._value), t };
  }
  return best ? best.v : "";
}

function first(doc, paths) {
  for (const p of paths) {
    const v = val(doc, p);
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

// décimos de µW -> dBm (0 = sem luz / sem leitura)
function toDbm(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(10 * Math.log10(n / 10000) * 100) / 100;
}

// Faixas para receptor GPON classe B+ (sensibilidade -27 dBm, saturação -8 dBm)
function signalLevel(rx) {
  if (rx === null || rx === undefined) return "none";
  if (rx > -8 || rx < -27) return "bad";
  if (rx < -24) return "warn";
  return "good";
}

// Tempo ligado agora = UpTime lido + tempo desde a leitura (só faz sentido se ainda online)
function uptimeNow(doc, online) {
  for (const p of ["Device.DeviceInfo.UpTime", "InternetGatewayDevice.DeviceInfo.UpTime"]) {
    const o = get(doc, p);
    if (!o || o._value === undefined || o._value === "") continue;
    const base = Number(o._value);
    if (!Number.isFinite(base)) continue;
    const since = o._timestamp ? (Date.now() - new Date(o._timestamp).getTime()) / 1000 : 0;
    return Math.round(online ? base + Math.max(0, since) : base);
  }
  return null;
}

function sgpTag(tags, kind) {
  const t = (tags || []).find((x) => x.startsWith(`SGP_${kind}_`));
  return t ? t.slice(`SGP_${kind}_`.length) : "";
}

function normalize(doc) {
  const id = doc._deviceId || {};
  const lastInform = doc._lastInform ? new Date(doc._lastInform) : null;
  const rx = toDbm(first(doc, RX_PATHS));
  const online = !!lastInform && Date.now() - lastInform.getTime() < ONLINE_MINUTES * 60000;
  return {
    id: doc._id,
    serial: id._SerialNumber || "",
    manufacturer: id._Manufacturer || "Desconhecido",
    model: id._ProductClass || "",
    oui: id._OUI || "",
    mac: val(doc, "VirtualParameters.MAC") || "",
    wanIp: val(doc, "VirtualParameters.IP") || val(doc, "VirtualParameters.WANIP") || "",
    lanIp: val(doc, "VirtualParameters.LANIP") || "",
    ssid: val(doc, "VirtualParameters.SSID") || "",
    software: freshest(doc, SOFTWARE_PATHS),
    rx,
    tx: toDbm(first(doc, TX_PATHS)),
    signal: signalLevel(rx),
    lastInform: lastInform ? lastInform.toISOString() : null,
    registered: doc._registered || null,
    online,
    uptime: uptimeNow(doc, online),
    // Tem fibra (ONU/ONT)? MikroTik e roteadores TR-098 não têm Device.Optical
    hasOptical: rx !== null || !!get(doc, "Device.Optical.Interface.1"),
    // Gravados pela provision_ipoe como tags SGP_CLIENTE_<id> / SGP_CONTRATO_<id>
    sgpCliente: sgpTag(doc._tags, "CLIENTE"),
    sgpContrato: sgpTag(doc._tags, "CONTRATO"),
    tags: doc._tags || [],
  };
}

// Lista completa em cache curto: a frota é pequena e evita martelar o NBI
let cache = { at: 0, list: null, pending: null };
const CACHE_MS = 20000;

async function all() {
  if (cache.list && Date.now() - cache.at < CACHE_MS) return cache.list;
  if (!cache.pending) {
    cache.pending = nbi.devices({}, PROJECTION)
      .then((docs) => {
        cache = { at: Date.now(), list: docs.map(normalize), pending: null };
        return cache.list;
      })
      .catch((e) => {
        cache.pending = null;
        throw e;
      });
  }
  return cache.pending;
}

function invalidate() {
  cache.at = 0;
}

// Achata a árvore de parâmetros para a tabela "Parâmetros" do detalhe
function flatten(doc) {
  const out = [];
  (function walk(o, path) {
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith("_") || v === null || typeof v !== "object") continue;
      const p = path ? path + "." + k : k;
      if (v._value !== undefined) {
        out.push({ path: p, value: v._value, type: v._type || "", writable: !!v._writable, timestamp: v._timestamp || null });
      }
      walk(v, p);
    }
  })(doc, "");
  return out;
}

function rootOf(doc) {
  return doc.Device ? "Device" : "InternetGatewayDevice";
}

module.exports = { all, invalidate, normalize, flatten, rootOf, PROJECTION };
