const now = Date.now();

// 1. Identificação do ID e modelo
let devIdObj = declare("DeviceID.ID", {value: 1});
let devIdStr = (devIdObj && devIdObj.value && devIdObj.value[0]) ? String(devIdObj.value[0]) : "Desconhecido";
log(">>> [ETAPA 1] Iniciando provision para: " + devIdStr);

let igdCheck = declare("InternetGatewayDevice.DeviceInfo.HardwareVersion", {value: 1});
// Modelos TR-181 que também respondem pelo TR-098 (ex.: TPLG1507E7F0): seguem o caminho TR-181
const TR181_MODELS = ["XX530v"];
const pcObj = declare("DeviceID.ProductClass", {value: 1});
const isTr181Model = TR181_MODELS.indexOf((pcObj && pcObj.value) ? String(pcObj.value[0]) : "") >= 0;
const isIGD = (igdCheck && igdCheck.value !== undefined) && !isTr181Model;
log(">>> [ETAPA 2] Dispositivo identificado como isIGD = " + isIGD);

// =========================================================================
// 2. FORÇAR COMUNICAÇÃO CWMP VIA IPv4 DIRETO
// =========================================================================
const ACS_URL = "{{ACS_URL}}";
if (isIGD) {
  declare("InternetGatewayDevice.ManagementServer.URL", {value: now}, {value: ACS_URL});
} else {
  declare("Device.ManagementServer.URL", {value: now}, {value: ACS_URL});
}

// =========================================================================
// 3. CREDENCIAIS FIXAS CONNECTION REQUEST (SUMMON)
// =========================================================================
const CR_USER = "{{CR_USER}}";
const CR_PASS = "{{CR_PASS}}";

if (isIGD) {
  declare("InternetGatewayDevice.ManagementServer.ConnectionRequestUsername", {value: now}, {value: CR_USER});
  declare("InternetGatewayDevice.ManagementServer.ConnectionRequestPassword", {value: now}, {value: CR_PASS});
} else {
  declare("Device.ManagementServer.ConnectionRequestUsername", {value: now}, {value: CR_USER});
  declare("Device.ManagementServer.ConnectionRequestPassword", {value: now}, {value: CR_PASS});
}

// =========================================================================
// 4. CAPTURA DO MAC DA WAN (o MAC que o servidor DHCP/SGP enxerga no IPoE)
// =========================================================================
// Antes o script lia:
//  - TR-098: WANEthernetInterfaceConfig.MACAddress -> vem VAZIO nesses modelos
//            e caía no SerialNumber, que o SGP nunca encontra.
//  - TR-181: Device.Ethernet.Interface.1.MACAddress -> é o MAC da LAN
//            (ex: ...D7:08), mas o DHCP da WAN usa outro (ex: ...D7:0A/0B).
// Agora juntamos os MACs candidatos, priorizando os da WAN.

function normMac(v) {
  let s = String(v || "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (s.length !== 12 || s === "000000000000") return "";
  return s.match(/.{2}/g).join(":");
}

// Converte endereço IPv6 SLAAC (EUI-64) no MAC da interface. Ex:
// 2804:...:0eef:15ff:fe07:d70b -> 0C:EF:15:07:D7:0B
function macFromEui64(addr) {
  let a = String(addr || "").split("/")[0].toLowerCase();
  if (!a || a.indexOf(":") < 0) return "";
  let parts = a.split("::");
  let head = parts[0] ? parts[0].split(":") : [];
  let tail = (parts.length > 1 && parts[1]) ? parts[1].split(":") : [];
  let fill = [];
  for (let i = 0; i < 8 - head.length - tail.length; i++) fill.push("0");
  let g = head.concat(fill, tail);
  if (g.length !== 8) return "";
  let hex = g.slice(4).map(x => ("0000" + x).slice(-4)).join("");
  if (hex.substr(6, 4) !== "fffe") return "";
  let b0 = (parseInt(hex.substr(0, 2), 16) ^ 0x02).toString(16);
  return normMac(("0" + b0).slice(-2) + hex.substr(2, 4) + hex.substr(10, 6));
}

let candidates = [];
function addMac(v, origem) {
  let m = normMac(v);
  if (m && candidates.indexOf(m) < 0) {
    candidates.push(m);
    log(">>> [MAC] candidato " + m + " (" + origem + ")");
  }
}

if (isIGD) {
  // TR-098: MAC da conexão WAN IPoE / PPP
  for (let p of declare("InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANIPConnection.*.MACAddress", {value: 1})) {
    if (p.value) addMac(p.value[0], p.path);
  }
  for (let p of declare("InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.MACAddress", {value: 1})) {
    if (p.value) addMac(p.value[0], p.path);
  }
  for (let p of declare("InternetGatewayDevice.WANDevice.*.WANEthernetInterfaceConfig.MACAddress", {value: 1})) {
    if (p.value) addMac(p.value[0], p.path);
  }
} else {
  // TR-181: descobre a interface WAN (IPv4 que não é LAN) e deriva o MAC
  // pelo IPv6 SLAAC dela; depois as interfaces Ethernet, da última para a primeira
  // (nos XX530v a WAN é a última; a .1 é LAN).
  let wanIf = "";
  for (let item of declare("Device.IP.Interface.*.IPv4Address.*.IPAddress", {value: 1})) {
    let ip = (item.value && item.value[0]) ? String(item.value[0]) : "";
    if (ip && !ip.startsWith("192.168.") && !ip.startsWith("127.") && ip !== "0.0.0.0") {
      wanIf = item.path.split(".IPv4Address")[0];
      break;
    }
  }
  if (wanIf) {
    for (let p of declare(wanIf + ".IPv6Address.*.IPAddress", {value: 1})) {
      if (p.value) addMac(macFromEui64(p.value[0]), "EUI-64 " + p.path);
    }
  }
  let eth = [];
  for (let p of declare("Device.Ethernet.Interface.*.MACAddress", {value: 1})) {
    if (p.value) eth.push([p.path, p.value[0]]);
  }
  eth.reverse();
  for (let e of eth) addMac(e[1], e[0]);
}

// TR-098: o MAC WAN costuma ser o da LAN + 1 (ex.: VALDETE LAN ...B7:44, login no SGP ...b7:45)
function macPlus(mac, n) {
  const h = normMac(mac).replace(/:/g, "");
  if (!h) return "";
  const v = (parseInt(h, 16) + n).toString(16).toUpperCase();
  return normMac(("000000000000" + v).slice(-12));
}
if (isIGD) {
  for (let p of declare("InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.*.MACAddress", {value: 1})) {
    if (p.value) {
      addMac(macPlus(p.value[0], 1), "LAN+1 " + p.path);
      addMac(p.value[0], p.path);
    }
  }
}

// TR-181 (MikroTik e outros): o login no SGP pode ser o MAC + 1
// (ex.: GT_MARCIO_PTP ...E8:4C -> login cc2d-e069-e84d). Vão para o fim da lista.
if (!isIGD) {
  for (const c of candidates.slice()) addMac(macPlus(c, 1), "+1 de " + c);
}

log(">>> [ETAPA 3] MACs candidatos: " + candidates.join(", "));

// =========================================================================
// 5. CONSULTA EXTERNA (SGP)
// =========================================================================
// Limite de tentativas: cada ext() pode levar até GENIEACS_EXT_TIMEOUT (3s por padrão);
// muitas chamadas seguidas geram a falha "Extension timed out".
const MAX_TENTATIVAS = 6;
let auth = null;
let macEncontrado = "";

let sgpErro = "";

// 1º: pelo serial do equipamento (é assim que o SGP vincula o serviço ao ACS)
let serialObj = declare("DeviceID.SerialNumber", {value: 1});
let serial = (serialObj && serialObj.value && serialObj.value[0]) ? String(serialObj.value[0]) : "";
if (serial) {
  let r = ext("sistema", "contratoPorSerial", serial);
  if (r && r.error) {
    sgpErro = String(r.error);
    log(">>> [ETAPA 4] SGP(serial " + serial + ") ERRO: " + sgpErro);
  } else if (r && r.username) {
    auth = r;
    macEncontrado = "serial " + serial;
    log(">>> [ETAPA 4] SGP(serial " + serial + ") => contrato " + r.username);
  } else {
    log(">>> [ETAPA 4] SGP(serial " + serial + ") => sem contrato");
  }
}

// 2º: pelo login IPoE, que é o MAC WAN (só se o SGP respondeu sem erro)
for (let i = 0; !sgpErro && i < candidates.length && i < MAX_TENTATIVAS && !auth; i++) {
  let r = ext("sistema", "pppoeLoginByMac", candidates[i]);
  if (r && r.error) {
    // SGP fora do ar ou credencial inválida: não adianta tentar os outros MACs
    sgpErro = String(r.error);
    log(">>> [ETAPA 4] SGP(" + candidates[i] + ") ERRO: " + sgpErro);
    break;
  }
  // Só conta como encontrado se veio um contrato de verdade (com login)
  const achou = !!(r && r.username);
  log(">>> [ETAPA 4] SGP(" + candidates[i] + ") => " + (achou ? "contrato " + r.username : "sem contrato"));
  if (achou) {
    auth = r;
    macEncontrado = candidates[i];
  }
}

if (!auth) {
  log(">>> [PAROU] " + (sgpErro ? "Falha ao consultar o SGP: " + sgpErro : "SGP não encontrou o serial " + serial + " nem os MACs: " + candidates.join(", ")));
  declare("Tags.ERRO_SGP", null, {value: true});
  return;
}

declare("Tags.ERRO_SGP", null, {value: false});
// Não registra senhas no log: só o login e os códigos do contrato
log(">>> [ETAPA 5] SGP encontrou (" + macEncontrado + "): cliente " + auth.cliente + ", contrato " + auth.contrato + ", login " + auth.username);

// Guarda cliente e contrato do SGP como tags (o portal mostra "Cliente 20952"),
// removendo códigos antigos caso o equipamento tenha mudado de cliente
const sgpTags = {};
if (auth.cliente) sgpTags["SGP_CLIENTE_" + auth.cliente] = true;
if (auth.contrato) sgpTags["SGP_CONTRATO_" + auth.contrato] = true;
for (let t of declare("Tags.*", {value: 1})) {
  const name = t.path.split(".")[1];
  if (/^SGP_(CLIENTE|CONTRATO)_/.test(name) && !sgpTags[name]) declare("Tags." + name, null, {value: false});
}
for (const name of Object.keys(sgpTags)) declare("Tags." + name, null, {value: true});

// =========================================================================
// 6. PRÉ-CONFIGURAÇÃO DO SPEEDTEST (TR-143)
// =========================================================================
const SPEEDTEST_URL = "{{SPEEDTEST_URL}}";

if (isIGD) {
  declare("InternetGatewayDevice.DownloadDiagnostics.DownloadURL", {value: now}, {value: SPEEDTEST_URL});
} else {
  let wanInterface = "Device.IP.Interface.6";
  let ips = declare("Device.IP.Interface.*.IPv4Address.*.IPAddress", {value: now});

  for (let item of ips) {
    let ip = (item.value && item.value[0]) ? String(item.value[0]) : "";
    if (ip && !ip.startsWith("192.168.") && !ip.startsWith("127.") && ip !== "0.0.0.0") {
      wanInterface = item.path.split(".IPv4Address")[0];
      break;
    }
  }

  declare("Device.IP.Diagnostics.DownloadDiagnostics.Interface", {value: now}, {value: [wanInterface, "xsd:string"]});
  declare("Device.IP.Diagnostics.DownloadDiagnostics.DownloadURL", {value: now}, {value: [SPEEDTEST_URL, "xsd:string"]});
}

declare("Tags.Provisioned", null, {value: true});
log(">>> [SUCESSO] Provision finalizado com sucesso!");
