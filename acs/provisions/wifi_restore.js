// Restaura o Wi-Fi principal (nome e senha) depois de um reset de fábrica.
// Roda pelo preset 04_WIFI_RESTORE enquanto existir a tag BOOTSTRAP_PENDING (marcada pela provision "bootstrap").
// Só grava se o Wi-Fi estiver no padrão de fábrica (TP-Link_XXXX): um BOOTSTRAP sem reset não altera nada.
const now = Date.now();

function encerrar(msg) {
  log(">>> [WIFI] " + msg);
  // Não mexe em tags: a marca é tirada pelo preset 05_BOOTSTRAP_DONE (evita preset_loop)
}

const serialObj = declare("DeviceID.SerialNumber", {value: 1});
const serial = (serialObj.value && serialObj.value[0]) ? String(serialObj.value[0]) : "";

const dot = (s) => { s = String(s || ""); return s && !s.endsWith(".") ? s + "." : s; };
const isDefault = (s) => /^TP-Link_[0-9A-F]{4}(_5G)?$/i.test(String(s || ""));
const um = (d) => (d.value && d.value[0] !== undefined && d.value[0] !== null) ? d.value[0] : undefined;

// Cópia do Wi-Fi: portal (pelo serial) ou sistema de gestão. No Hubsoft também pelo serviço (tag SGP_CONTRATO_)
// ou pelo MAC WAN, para aparelhos que ele não conhece pelo serial.
function copiaGuardada() {
  let contrato = "";
  for (const t of declare("Tags.*", {value: 1})) {
    const m = String(t.path).match(/^Tags\.SGP_CONTRATO_(\d+)$/);
    if (m) contrato = m[1];
  }
  const mac = String(um(declare("VirtualParameters.MAC", {value: 1})) || "");
  const raw = ext("wifibackup", "get", serial, contrato, mac);
  if (!raw) return null;
  try { const s = JSON.parse(raw); return s && s.wifi ? s : null; } catch (e) { return null; }
}

// ==========================================
// TR-098 (ex.: Realtek FW323DAC padrão China Telecom, roteadores TP-Link antigos)
// ==========================================
// Reset de fábrica = evento "X CT-COM LONGRESET" nesta sessão (o GenieACS guarda todo evento do Inform como
// Events.<código>) ou rede principal com nome de fábrica TP-Link. Um BOOTSTRAP sem reset (ex.: aparelho vindo de
// outro ACS) não muda nada. Senha gravada em PreSharedKey.1.KeyPassphrase, KeyPassphrase e X_TP_PreSharedKey (os que existirem).
if (!declare("Device.WiFi.SSID.*.SSID", {value: 1}).size) {
  const base = "InternetGatewayDevice.LANDevice.1.WLANConfiguration.";
  if (!declare(base + "*.SSID", {value: 1}).size) {
    encerrar("Modelo sem Wi-Fi conhecido (nem TR-181 nem TR-098): nada a restaurar");
    return;
  }
  const ev = um(declare("Events.X_CT-COM_LONGRESET", {value: 1}));
  const longReset = ev !== undefined && now - new Date(ev).getTime() < 15 * 60000;

  const campo = (nome, idade) => {
    const out = {};
    for (const d of declare(base + "*." + nome, {value: idade})) out[d.path.split(".")[4]] = um(d);
    return out;
  };
  const ssid = campo("SSID", now), enable = campo("Enable", now), std = campo("Standard", 1), pc = campo("PossibleChannels", 1), tpBand = campo("X_TP_Band", 1);
  const existe = (p) => declare(p, {path: 1}).size > 0;
  // Faixa: X_TP_Band; senão o padrão ("ac,n,a" = 5 GHz, "b,g,n" = 2.4 GHz) ou os canais possíveis
  const banda = (i) => {
    const b = String(tpBand[i] || "");
    if (/5\s?G/i.test(b)) return "5GHz";
    if (/2\.4/.test(b)) return "2.4GHz";
    const s = String(std[i] || "").toLowerCase().split(/[,\s\/]+/);
    if (s.indexOf("b") >= 0 || s.indexOf("g") >= 0) return "2.4GHz";
    if (s.indexOf("a") >= 0 || s.indexOf("ac") >= 0 || s.indexOf("ax") >= 0) return "5GHz";
    const c = String(pc[i] || "");
    if (/\b(36|149)\b/.test(c)) return "5GHz";
    if (/^1\b/.test(c)) return "2.4GHz";
    return /5\s?G/i.test(String(ssid[i] || "")) ? "5GHz" : "2.4GHz";
  };
  // Rede principal de cada faixa: a WLANConfiguration ligada de menor índice
  const prim = {};
  for (const i of Object.keys(ssid).map(Number).sort((a, b) => a - b)) {
    const b = banda(i), ligada = enable[i] !== false;
    if (prim[b] && (prim[b].ligada || !ligada)) continue;
    prim[b] = {idx: i, ligada: ligada, ssid: String(ssid[i] || "")};
  }
  const resetado = longReset || Object.keys(prim).some((b) => isDefault(prim[b].ssid));
  const vistos = Object.keys(prim).map((b) => b + " \"" + prim[b].ssid + "\"").join(", ");
  if (!resetado) {
    encerrar("BOOTSTRAP sem reset de fábrica (sem X CT-COM LONGRESET e Wi-Fi fora do padrão TP-Link_XXXX): nada a restaurar [" + vistos + "]");
    return;
  }
  const saved = copiaGuardada();
  if (!saved) {
    encerrar("Reset de fábrica detectado em " + serial + " [" + vistos + "], mas não há Wi-Fi guardado no portal nem no sistema de gestão");
    return;
  }
  const restaurados = [];
  for (const b of Object.keys(prim)) {
    const w = saved.wifi[b];
    if (!w || !w.ssid || !w.pass) continue;
    if (!longReset && !isDefault(prim[b].ssid)) continue;
    const pre = base + prim[b].idx + ".";
    const senhas = [pre + "PreSharedKey.1.KeyPassphrase", pre + "KeyPassphrase", pre + "X_TP_PreSharedKey"].filter(existe);
    if (!senhas.length) continue;
    declare(pre + "SSID", {value: now}, {value: [String(w.ssid), "xsd:string"]});
    for (const p of senhas) declare(p, {value: now}, {value: [String(w.pass), "xsd:string"]});
    // Não registra a senha no log
    restaurados.push(b + " \"" + w.ssid + "\" (WLAN " + prim[b].idx + ")");
  }
  encerrar(restaurados.length
    ? "Wi-Fi restaurado (" + saved.source + ", TR-098" + (longReset ? ", LONGRESET" : "") + "): " + restaurados.join(", ")
    : "Cópia encontrada (" + saved.source + "), mas sem nome e senha completos para as faixas resetadas [" + vistos + "]");
  return;
}

// Rede principal de cada faixa: SSID de menor índice em cada rádio + AccessPoint que aponta para ele
const radios = {};
for (const r of declare("Device.WiFi.Radio.*.OperatingFrequencyBand", {value: now})) {
  if (r.value) radios[r.path.slice(0, -"OperatingFrequencyBand".length)] = String(r.value[0]);
}
const prim = {};
for (const s of declare("Device.WiFi.SSID.*.LowerLayers", {value: now})) {
  const band = radios[dot(s.value && s.value[0])];
  if (!band) continue;
  const base = s.path.slice(0, -"LowerLayers".length);
  const idx = Number(base.split(".")[3]);
  if (!prim[band] || idx < prim[band].idx) prim[band] = {idx: idx, ssidPath: base};
}
for (const ap of declare("Device.WiFi.AccessPoint.*.SSIDReference", {value: now})) {
  const ref = dot(ap.value && ap.value[0]);
  for (const b of Object.keys(prim)) if (prim[b].ssidPath === ref) prim[b].apPath = ap.path.slice(0, -"SSIDReference".length);
}

let resetado = false;
for (const b of Object.keys(prim)) {
  const s = declare(prim[b].ssidPath + "SSID", {value: now});
  prim[b].ssid = (s.value && s.value[0]) ? String(s.value[0]) : "";
  if (isDefault(prim[b].ssid)) resetado = true;
}

if (!resetado) {
  encerrar("BOOTSTRAP sem reset de fábrica (Wi-Fi fora do padrão TP-Link_XXXX): nada a restaurar");
  return;
}

const saved = copiaGuardada();
if (!saved) {
  encerrar("Reset de fábrica detectado em " + serial + ", mas não há Wi-Fi guardado no portal nem no sistema de gestão");
  return;
}

const restaurados = [];
for (const b of Object.keys(prim)) {
  const w = saved.wifi[b];
  if (!w || !w.ssid || !w.pass || !prim[b].apPath || !isDefault(prim[b].ssid)) continue;
  declare(prim[b].ssidPath + "SSID", {value: now}, {value: [String(w.ssid), "xsd:string"]});
  declare(prim[b].apPath + "Security.KeyPassphrase", {value: now}, {value: [String(w.pass), "xsd:string"]});
  // Não registra a senha no log
  restaurados.push(b + " \"" + w.ssid + "\"");
}

encerrar(restaurados.length
  ? "Wi-Fi restaurado (" + saved.source + "): " + restaurados.join(", ")
  : "Cópia encontrada (" + saved.source + "), mas sem nome e senha completos para as faixas resetadas");
