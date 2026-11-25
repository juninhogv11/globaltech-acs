"use strict";
// Wi-Fi, clientes conectados, portas LAN e redes vizinhas (TR-181 e TR-098)

function get(doc, path) {
  let o = doc;
  for (const k of path.split(".")) {
    if (o == null) return undefined;
    o = o[k];
  }
  return o;
}

const v = (o, k) => (o && o[k] && o[k]._value !== undefined ? o[k]._value : undefined);
const ts = (o, k) => (o && o[k] && o[k]._timestamp) || null;

// Instâncias numeradas de um objeto: Device.WiFi.Radio -> [[1, {...}], [2, {...}]]
function children(doc, path) {
  const o = get(doc, path);
  if (!o) return [];
  return Object.keys(o).filter((k) => /^\d+$/.test(k)).map((k) => [Number(k), o[k]]).sort((a, b) => a[0] - b[0]);
}

const normMac = (m) => String(m || "").toUpperCase();
const num = (x) => (x === undefined || x === "" || x === null || Number.isNaN(Number(x)) ? null : Number(x));
const newest = (list) => list.filter(Boolean).sort().pop() || null;

function bandOf(text) {
  const s = String(text || "");
  if (/6\s?G/i.test(s)) return "6GHz";
  if (/5\s?G/i.test(s)) return "5GHz";
  if (/2\.4/.test(s)) return "2.4GHz";
  return "";
}

function tr181(doc) {
  const stamps = [];
  const radios = children(doc, "Device.WiFi.Radio").map(([i, r]) => {
    stamps.push(ts(r, "Channel"));
    return {
      ref: `Device.WiFi.Radio.${i}.`,
      name: v(r, "Name") || `Rádio ${i}`,
      band: v(r, "OperatingFrequencyBand") || "",
      channel: num(v(r, "Channel")),
      bandwidth: v(r, "CurrentOperatingChannelBandwidth") || v(r, "OperatingChannelBandwidth") || "",
      autoChannel: v(r, "AutoChannelEnable"),
      status: v(r, "Status") || "",
      possibleChannels: String(v(r, "PossibleChannels") || "").split(",").map(Number).filter(Boolean),
    };
  }).filter((r) => r.channel !== null || r.band);

  const ssids = new Map(children(doc, "Device.WiFi.SSID").map(([i, s]) => [`Device.WiFi.SSID.${i}.`, s]));
  const radioBand = new Map(radios.map((r) => [r.ref, r.band]));

  const clients = [];
  for (const [i, ap] of children(doc, "Device.WiFi.AccessPoint")) {
    const ssid = ssids.get(String(v(ap, "SSIDReference") || "").replace(/([^.])$/, "$1.")) || {};
    const ssidName = v(ssid, "SSID") || "";
    const band = radioBand.get(String(v(ssid, "LowerLayers") || "").replace(/([^.])$/, "$1.")) || bandOf(ssidName) || (i % 2 === 1 ? "2.4GHz" : "5GHz");
    for (const [, c] of children(doc, `Device.WiFi.AccessPoint.${i}.AssociatedDevice`)) {
      if (!v(c, "MACAddress") || v(c, "Active") === false) continue;
      stamps.push(ts(c, "SignalStrength"));
      clients.push({
        mac: normMac(v(c, "MACAddress")),
        signal: num(v(c, "SignalStrength")),
        down: num(v(c, "LastDataDownlinkRate")),
        up: num(v(c, "LastDataUplinkRate")),
        standard: v(c, "OperatingStandard") || "",
        ssid: ssidName,
        band,
      });
    }
  }

  const hosts = children(doc, "Device.Hosts.Host").map(([, h]) => {
    stamps.push(ts(h, "PhysAddress"));
    return {
      mac: normMac(v(h, "PhysAddress") || v(h, "MACAddress")),
      name: v(h, "HostName") || "",
      ip: v(h, "IPAddress") || "",
      active: v(h, "Active"),
      type: v(h, "InterfaceType") || "",
      source: v(h, "AddressSource") || "",
    };
  }).filter((h) => h.mac || h.ip);

  const ports = children(doc, "Device.Ethernet.Interface").map(([i, e]) => {
    stamps.push(ts(e, "Status"));
    return {
      name: v(e, "X_TP_IfNameAlias") || v(e, "Name") || `Porta ${i}`,
      status: v(e, "Status") || "",
      enabled: v(e, "Enable"),
      wan: v(e, "Upstream") === true,
      speed: num(v(e, "CurrentBitRate")) ?? num(v(e, "MaxBitRate")),
      duplex: v(e, "DuplexMode") || "",
    };
  }).filter((p) => p.status || p.enabled !== undefined)
    // Interface "LAN" genérica (bridge) do XX530v não é porta física
    .filter((p) => p.name !== "LAN");

  const diag = get(doc, "Device.WiFi.NeighboringWiFiDiagnostic") || {};
  const neighbors = {
    supported: !!get(doc, "Device.WiFi.NeighboringWiFiDiagnostic"),
    state: v(diag, "DiagnosticsState") || "",
    at: ts(diag, "DiagnosticsState"),
    results: children(doc, "Device.WiFi.NeighboringWiFiDiagnostic.Result").map(([, n]) => ({
      ssid: v(n, "SSID") || "",
      bssid: normMac(v(n, "BSSID")),
      channel: num(v(n, "Channel")),
      band: v(n, "OperatingFrequencyBand") || "",
      bandwidth: v(n, "OperatingChannelBandwidth") || "",
      signal: num(v(n, "SignalStrength")),
      security: v(n, "SecurityModeEnabled") || "",
    })).filter((n) => n.channel !== null),
  };

  return { radios, clients, hosts, ports, neighbors, readAt: newest(stamps) };
}

// Faixa de uma WLANConfiguration (TR-098): X_TP_Band; senão o padrão ("ac,n,a" = 5 GHz, "b,g,n" = 2.4 GHz)
// ou os canais possíveis; o nome da rede por último (muda quando o cliente renomeia)
function bandaTr098(w) {
  const porBand = bandOf(v(w, "X_TP_Band"));
  if (porBand) return porBand;
  const std = String(v(w, "Standard") || "").toLowerCase().split(/[,\s/]+/);
  if (std.some((x) => x === "b" || x === "g")) return "2.4GHz";
  if (std.some((x) => x === "a" || x === "ac" || x === "ax")) return "5GHz";
  const pc = String(v(w, "PossibleChannels") || "");
  if (/\b(36|149)\b/.test(pc)) return "5GHz";
  if (/^1\b/.test(pc)) return "2.4GHz";
  return bandOf(v(w, "SSID")) || "2.4GHz";
}

function tr098(doc) {
  const stamps = [];
  const base = "InternetGatewayDevice.LANDevice.1";
  const radios = [];
  const clients = [];
  for (const [i, w] of children(doc, `${base}.WLANConfiguration`)) {
    const ssid = v(w, "SSID") || "";
    const band = bandaTr098(w);
    // Canal 0 = automático em alguns modelos (Realtek): o canal em uso vem em ChannelsInUse
    const channel = num(v(w, "Channel")) || num(String(v(w, "ChannelsInUse") || "").split(",")[0]) || num(v(w, "Channel"));
    stamps.push(ts(w, "Channel"));
    if (channel !== null && !radios.some((r) => r.band === band)) {
      radios.push({
        name: `WLAN ${i}`,
        band,
        channel,
        bandwidth: v(w, "X_TP_Bandwidth") || "",
        autoChannel: v(w, "AutoChannelEnable"),
        status: v(w, "Status") || "",
        possibleChannels: String(v(w, "PossibleChannels") || "").split(",").map(Number).filter(Boolean),
      });
    }
    for (const [, c] of children(doc, `${base}.WLANConfiguration.${i}.AssociatedDevice`)) {
      if (!v(c, "AssociatedDeviceMACAddress")) continue;
      stamps.push(ts(c, "AssociatedDeviceMACAddress"));
      clients.push({
        mac: normMac(v(c, "AssociatedDeviceMACAddress")),
        signal: num(v(c, "X_TP_StaSignalStrength")),
        down: num(v(c, "X_TP_StaConnectionSpeed")),
        up: null,
        standard: v(c, "X_TP_StaStandard") || "",
        ssid,
        band,
        name: v(c, "X_TP_StaHostName") || "",
        ip: v(c, "AssociatedDeviceIPAddress") || "",
      });
    }
  }

  const hosts = children(doc, `${base}.Hosts.Host`).map(([, h]) => {
    stamps.push(ts(h, "MACAddress"));
    return {
      mac: normMac(v(h, "MACAddress")),
      name: v(h, "HostName") || "",
      ip: v(h, "IPAddress") || "",
      active: v(h, "Active"),
      type: v(h, "InterfaceType") || "",
      source: v(h, "AddressSource") || "",
    };
  }).filter((h) => h.mac || h.ip);

  const ports = children(doc, `${base}.LANEthernetInterfaceConfig`).map(([i, e]) => {
    stamps.push(ts(e, "Status"));
    return {
      name: `LAN${i}`,
      status: v(e, "Status") || "",
      enabled: v(e, "Enable"),
      wan: false,
      speed: num(v(e, "MaxBitRate")),
      duplex: v(e, "DuplexMode") || "",
    };
  }).filter((p) => p.status || p.enabled !== undefined);

  return { radios, clients, hosts, ports, neighbors: { supported: false, state: "", at: null, results: [] }, readAt: newest(stamps) };
}

// ---------- Análise de interferência ----------
const MHZ = (bw, band) => {
  const n = parseInt(String(bw), 10);
  return Number.isFinite(n) && n > 0 ? n : band === "2.4GHz" ? 20 : 40;
};
// Canais são espaçados de 5 MHz nas duas faixas: há sobreposição quando a distância
// entre os centros é menor que a metade da soma das larguras
const overlaps = (chA, bwA, chB, bwB) => Math.abs(chA - chB) * 5 < (bwA + bwB) / 2;
const weight = (s) => (s === null ? 1 : s >= -60 ? 3 : s >= -70 ? 2 : s >= -80 ? 1 : 0.5);

function scoreAt(channel, bw, band, list) {
  let score = 0, count = 0;
  for (const n of list) {
    if (n.band !== band || n.channel === null) continue;
    if (overlaps(channel, bw, n.channel, MHZ(n.bandwidth, band))) {
      score += weight(n.signal);
      count++;
    }
  }
  return { score, count };
}

function analyze(radios, results) {
  return radios.filter((r) => r.channel !== null && r.band).map((r) => {
    const band = r.band;
    const myBw = MHZ(r.bandwidth, band);
    const inBand = results.filter((n) => n.band === band);
    const cur = scoreAt(r.channel, myBw, band, results);
    const level = cur.score === 0 ? "Livre" : cur.score < 3 ? "Baixa" : cur.score < 6 ? "Média" : "Alta";

    // 5 GHz: só canais sem DFS (52-144 exigem detecção de radar e podem desligar o Wi-Fi do cliente)
    let candidates = band === "2.4GHz" ? [1, 6, 11]
      : myBw >= 80 ? [36, 149]
      : myBw >= 40 ? [36, 44, 149, 157]
      : [36, 40, 44, 48, 149, 153, 157, 161, 165];
    if (r.possibleChannels.length) candidates = candidates.filter((c) => r.possibleChannels.includes(c));
    const ranked = candidates
      .map((c) => ({ channel: c, ...scoreAt(c, band === "2.4GHz" ? 20 : myBw, band, results) }))
      .sort((a, b) => a.score - b.score || a.count - b.count);
    const best = ranked[0];
    // Só sugere trocar quando o ganho é relevante (pelo menos uma rede forte/média a menos)
    const worth = best && best.channel !== r.channel && cur.score - best.score >= 1;

    return {
      radio: r.ref || null,
      band,
      channel: r.channel,
      bandwidth: r.bandwidth,
      autoChannel: r.autoChannel,
      networks: inBand.length,
      overlapping: cur.count,
      score: cur.score,
      level,
      suggestion: worth ? best.channel : null,
    };
  });
}

function lanInfo(doc) {
  const info = doc.Device ? tr181(doc) : tr098(doc);
  // Junta nome e IP do host aos clientes Wi-Fi pelo MAC
  const byMac = new Map(info.hosts.map((h) => [h.mac, h]));
  for (const c of info.clients) {
    const h = byMac.get(c.mac) || {};
    c.name = c.name || (h.name && h.name !== "Unknown" ? h.name : "");
    c.ip = c.ip || h.ip || "";
  }
  info.interference = info.neighbors.results.length ? analyze(info.radios, info.neighbors.results) : [];
  // "Alterar Wi-Fi" aparece quando há rede principal com lugar para gravar a senha
  info.wifiEditavel = Object.values(wifiPrimary(doc)).some((p) => p.apPath);
  return info;
}

// Objetos que o botão "Ler Wi-Fi e LAN" atualiza no equipamento
function readObjects(doc) {
  return doc.Device
    ? ["Device.DeviceInfo.UpTime", "Device.WiFi.Radio", "Device.WiFi.SSID", "Device.WiFi.AccessPoint", "Device.Hosts.Host", "Device.Ethernet.Interface"]
    : ["InternetGatewayDevice.DeviceInfo.UpTime", "InternetGatewayDevice.LANDevice.1.WLANConfiguration", "InternetGatewayDevice.LANDevice.1.Hosts", "InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig"];
}

// Valida e monta a troca de canal de um rádio TR-181.
// channel = "auto" religa o canal automático; um número fixa o canal.
function channelChange(doc, radioRef, channel) {
  if (!doc.Device) throw Object.assign(new Error("Troca de canal disponível só para modelos TR-181."), { status: 400 });
  const radio = tr181(doc).radios.find((r) => r.ref === radioRef);
  if (!radio) throw Object.assign(new Error("Rádio não encontrado. Clique em \"Ler Wi-Fi e LAN agora\" e tente de novo."), { status: 400 });
  if (channel === "auto") {
    return { radio, parameterValues: [[radioRef + "AutoChannelEnable", true, "xsd:boolean"]] };
  }
  const ch = Number(channel);
  if (!Number.isInteger(ch) || (radio.possibleChannels.length && !radio.possibleChannels.includes(ch))) {
    throw Object.assign(new Error(`Canal ${channel} não é permitido neste rádio.`), { status: 400 });
  }
  return {
    radio,
    parameterValues: [
      [radioRef + "AutoChannelEnable", false, "xsd:boolean"],
      [radioRef + "Channel", ch, "xsd:unsignedInt"],
    ],
  };
}

// Rede principal de cada faixa: { ssidPath, ssid, apPath, passParams (onde gravar a senha) }
//   TR-181: o SSID de menor índice ligado a cada rádio e o AccessPoint que aponta para ele (onde fica a senha)
//   TR-098: a WLANConfiguration ligada de menor índice de cada faixa (ex.: Realtek FW323DAC: 1 = 5G, 5 = 2.4G);
//           senha em PreSharedKey.1.KeyPassphrase (padrão) e KeyPassphrase, os que existirem e forem graváveis
function wifiPrimary(doc) {
  if (!doc.Device) {
    const base = "InternetGatewayDevice.LANDevice.1.WLANConfiguration";
    const prim = {};
    for (const [i, w] of children(doc, base)) {
      if (v(w, "SSID") === undefined) continue;
      const band = bandaTr098(w);
      const ligada = v(w, "Enable") !== false;
      const atual = prim[band];
      if (atual && (atual.ligada || !ligada)) continue; // já tem uma ligada de índice menor
      const pre = `${base}.${i}.`;
      const pode = (o, k) => o && o[k] && o[k]._writable !== false;
      const passParams = [];
      if (pode(get(w, "PreSharedKey.1"), "KeyPassphrase")) passParams.push(pre + "PreSharedKey.1.KeyPassphrase");
      if (pode(w, "KeyPassphrase")) passParams.push(pre + "KeyPassphrase");
      if (pode(w, "X_TP_PreSharedKey")) passParams.push(pre + "X_TP_PreSharedKey"); // roteadores TP-Link TR-098
      prim[band] = { idx: i, ligada, ssidPath: pre, ssid: v(w, "SSID") || "", apPath: passParams.length ? pre : undefined, passParams };
    }
    return prim;
  }
  const dot = (s) => { s = String(s || ""); return s && !s.endsWith(".") ? s + "." : s; };
  const radioBand = new Map(children(doc, "Device.WiFi.Radio").map(([i, r]) => [`Device.WiFi.Radio.${i}.`, v(r, "OperatingFrequencyBand")]));
  const prim = {};
  for (const [i, s] of children(doc, "Device.WiFi.SSID")) {
    const band = radioBand.get(dot(v(s, "LowerLayers")));
    if (!band) continue;
    if (!prim[band] || i < prim[band].idx) prim[band] = { idx: i, ssidPath: `Device.WiFi.SSID.${i}.`, ssid: v(s, "SSID") || "" };
  }
  for (const [i, ap] of children(doc, "Device.WiFi.AccessPoint")) {
    const ref = dot(v(ap, "SSIDReference"));
    for (const b of Object.keys(prim)) if (prim[b].ssidPath === ref) { prim[b].apPath = `Device.WiFi.AccessPoint.${i}.`; prim[b].passParams = [`Device.WiFi.AccessPoint.${i}.Security.KeyPassphrase`]; }
  }
  return prim;
}

module.exports = { lanInfo, readObjects, channelChange, wifiPrimary };
