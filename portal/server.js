"use strict";
const http = require("http");
const path = require("path");
const env = require("./lib/env");
const auth = require("./lib/auth");
const nbi = require("./lib/nbi");
const devices = require("./lib/devices");
const lan = require("./lib/lan");
const speedtest = require("./lib/speedtest");
const models = require("./lib/models");
const wifibackup = require("./lib/wifibackup");
const firmware = require("./lib/firmware");

// IPs que podem ler a cópia do Wi-Fi (o servidor GenieACS, na restauração após reset)
const WIFI_BACKUP_ALLOW = (process.env.WIFI_BACKUP_ALLOW || "192.168.10.2").split(",").map((s) => s.trim());
const { createRouter, decorate, readJson, sendFile, serveStatic } = require("./lib/http");

const PUBLIC = path.join(__dirname, "public");
const CHART_JS = path.join(__dirname, "vendor", "chart.umd.js");
const api = createRouter();

// ---------- Dashboard ----------
function countBy(list, key) {
  const m = {};
  for (const d of list) {
    const k = d[key] || "Desconhecido";
    m[k] = (m[k] || 0) + 1;
  }
  return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count }));
}

api.get("/api/me", (req, res) => res.json({ ...req.user, sgpUrl: env.SGP_URL }));

api.get("/api/summary", async (req, res) => {
  const [list, faults] = await Promise.all([devices.all(), nbi.faults()]);
  const now = Date.now();
  const since = (ms) => list.filter((d) => d.registered && now - new Date(d.registered).getTime() < ms).length;
  const optical = list.filter((d) => d.rx !== null);
  const byId = new Map(list.map((d) => [d.id, d]));
  res.json({
    total: list.length,
    online: list.filter((d) => d.online).length,
    offline: list.filter((d) => !d.online).length,
    faults: faults.length,
    signal: {
      good: list.filter((d) => d.signal === "good").length,
      warn: list.filter((d) => d.signal === "warn").length,
      bad: list.filter((d) => d.signal === "bad").length,
      none: list.filter((d) => d.signal === "none").length,
    },
    manufacturers: countBy(list, "manufacturer"),
    models: countBy(list, "model"),
    registered: { day: since(86400000), week: since(7 * 86400000), month: since(30 * 86400000) },
    tags: {
      provisioned: list.filter((d) => d.tags.includes("Provisioned")).length,
      erroSgp: list.filter((d) => d.tags.includes("ERRO_SGP")).length,
    },
    worstSignal: optical.sort((a, b) => a.rx - b.rx).slice(0, 8),
    recentFaults: faults
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
      .slice(0, 6)
      .map((f) => ({ ...f, deviceName: (byId.get(f.device) || {}).ssid || "" })),
    updatedAt: new Date().toISOString(),
  });
});

// ---------- Dispositivos ----------
api.get("/api/devices", async (req, res) => res.json(await devices.all()));

api.get("/api/devices/:id", async (req, res) => {
  const doc = await nbi.device(req.params.id);
  const device = devices.normalize(doc);
  res.json({
    device,
    modelImage: models.imageUrl(device.model),
    lan: lan.lanInfo(doc),
    speedtest: { ...speedtest.info(doc), running: speedtest.runningJob(req.params.id) },
    firmwareJob: { ...(firmware.history(req.params.id) || {}), lockMinutes: firmware.lockMinutes(req.params.id) },
    root: devices.rootOf(doc),
  });
});

const taskResult = (r) => ({ done: r.status === 200, queued: r.status === 202 });

// Mesma operação já em andamento no mesmo aparelho: reaproveita em vez de mandar outra
// (ex.: dois operadores abrindo a página ao mesmo tempo disparam a leitura automática)
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// Lê clientes Wi-Fi, hosts e portas LAN do equipamento agora
api.post("/api/devices/:id/read-lan", async (req, res) => {
  res.json(await once("lan:" + req.params.id, async () => {
    const doc = await nbi.device(req.params.id);
    for (const objectName of lan.readObjects(doc)) {
      const r = await nbi.task(req.params.id, { name: "refreshObject", objectName }, 20000);
      // Se o equipamento não atendeu o connection request, as demais ficariam só na fila
      if (r.status === 202) return taskResult(r);
    }
    return { done: true, queued: false };
  }));
});

// Troca o canal de um rádio Wi-Fi (fixa o canal; o automático é desligado)
api.post("/api/devices/:id/set-channel", async (req, res) => {
  const { radio, channel } = req.body || {};
  const doc = await nbi.device(req.params.id);
  const change = lan.channelChange(doc, String(radio || ""), channel);
  const r = await nbi.task(req.params.id, { name: "setParameterValues", parameterValues: change.parameterValues }, 20000);
  if (r.status === 200) {
    await nbi.task(req.params.id, { name: "refreshObject", objectName: change.radio.ref.replace(/\.$/, "") }, 20000).catch(() => {});
  }
  console.log(new Date().toISOString(), `canal ${change.radio.band} -> ${channel === "auto" ? "automático" : channel} em ${req.params.id} por ${req.user.user}`);
  res.json(taskResult(r));
});

// ---------- Wi-Fi: alterar pelo portal e guardar cópia para restaurar após reset ----------
const WIFI_OBJECTS = ["Device.WiFi.Radio", "Device.WiFi.SSID", "Device.WiFi.AccessPoint"];

api.get("/api/devices/:id/wifi", async (req, res) => {
  let doc = await nbi.device(req.params.id);
  if (!doc.Device) return res.json({ supported: false });
  let prim = lan.wifiPrimary(doc);
  // Sem o vínculo SSID -> rádio no cache: lê do equipamento uma vez
  if (!Object.values(prim).some((p) => p.apPath)) {
    for (const o of WIFI_OBJECTS) {
      const r = await nbi.task(req.params.id, { name: "refreshObject", objectName: o }, 20000);
      if (r.status === 202) return res.status(409).json({ error: "O equipamento não respondeu agora. Tente de novo em alguns minutos." });
    }
    doc = await nbi.device(req.params.id);
    prim = lan.wifiPrimary(doc);
  }
  const serial = devices.normalize(doc).serial;
  res.json({
    supported: true,
    bands: Object.entries(prim).map(([band, p]) => ({ band, ssid: p.ssid, ok: !!p.apPath })),
    backup: wifibackup.summary(serial),
  });
});

api.post("/api/devices/:id/wifi", async (req, res) => {
  const bands = (req.body || {}).bands || {};
  const doc0 = await nbi.device(req.params.id);
  if (!doc0.Device) return res.status(400).json({ error: "Alterar Wi-Fi pelo portal só está disponível para modelos TR-181 (XX530v)." });
  // Lê rádios, SSIDs e AccessPoints antes, para saber exatamente onde gravar
  for (const o of WIFI_OBJECTS) {
    const r = await nbi.task(req.params.id, { name: "refreshObject", objectName: o }, 20000);
    if (r.status === 202) return res.status(409).json({ error: "O equipamento não respondeu agora. Tente de novo em alguns minutos." });
  }
  const doc = await nbi.device(req.params.id);
  const prim = lan.wifiPrimary(doc);
  const params = [];
  const toSave = {};
  for (const [band, w] of Object.entries(bands)) {
    const p = prim[band];
    if (!p || !p.apPath) return res.status(400).json({ error: `Rede ${band} não encontrada neste equipamento.` });
    const ssid = String(w.ssid || "").trim();
    const pass = String(w.pass || "");
    if (ssid.length < 1 || ssid.length > 32) return res.status(400).json({ error: `Nome da rede ${band} precisa ter de 1 a 32 caracteres.` });
    if (pass && (pass.length < 8 || pass.length > 63)) return res.status(400).json({ error: `A senha ${band} precisa ter de 8 a 63 caracteres.` });
    if (ssid !== p.ssid) params.push([p.ssidPath + "SSID", ssid, "xsd:string"]);
    if (pass) params.push([p.apPath + "Security.KeyPassphrase", pass, "xsd:string"]);
    toSave[band] = { ssid, pass };
  }
  if (!params.length) return res.status(400).json({ error: "Nada para alterar." });
  const r = await nbi.task(req.params.id, { name: "setParameterValues", parameterValues: params }, 20000);
  const serial = devices.normalize(doc).serial;
  wifibackup.put(serial, toSave, req.user.user);
  // Não registra senhas: só quais faixas foram alteradas
  console.log(new Date().toISOString(), `wifi alterado em ${req.params.id} (${Object.keys(toSave).join(", ")}) por ${req.user.user}`);
  res.json(taskResult(r));
});

// ---------- Firmware (arquivos por modelo no GenieACS e atualização do equipamento) ----------
api.get("/api/firmware", async (req, res) => {
  const [files, list] = await Promise.all([firmware.list(), devices.all()]);
  res.json({
    files,
    models: [...new Set(list.map((d) => d.model).filter(Boolean))].sort(),
    maxMb: firmware.MAX_BYTES / 1048576,
  });
});

// Corpo binário (o arquivo); modelo, versão e nome vêm na URL
api.post("/api/firmware/upload", async (req, res) => {
  const q = new URL(req.url, "http://localhost").searchParams;
  const r = await firmware.upload(req, { model: q.get("model"), version: q.get("version"), filename: q.get("filename") });
  console.log(new Date().toISOString(), `firmware enviado ${r.name} (${Math.round(r.size / 1048576)} MB) por ${req.user.user}`);
  res.json(r);
});

api.delete("/api/firmware/:name", async (req, res) => {
  await firmware.remove(req.params.name);
  console.log(new Date().toISOString(), `firmware apagado ${req.params.name} por ${req.user.user}`);
  res.json({ ok: true });
});

api.post("/api/devices/:id/firmware", async (req, res) => {
  const d = devices.normalize(await nbi.device(req.params.id));
  if (!d.online) return res.status(409).json({ error: "O equipamento está offline. Atualize só com ele online." });
  const { file, task } = await firmware.upgradeTask(d, (req.body || {}).file);
  const r = await nbi.task(req.params.id, task, 20000);
  devices.invalidate();
  firmware.record(req.params.id, { status: "enviado", at: new Date().toISOString(), user: req.user.user, file: file.name, from: d.software, to: file.version, code: null, message: "", result: null });
  setTimeout(() => firmware.watch(), 15000);
  console.log(new Date().toISOString(), `atualizacao de firmware ${file.name} enviada para ${req.params.id} (era ${d.software}) por ${req.user.user}`);
  res.json({ ...taskResult(r), from: d.software, to: file.version, file: file.name });
});

// Foto do modelo: arquivo (dataUrl, já reduzido no navegador) ou URL externa
api.get("/api/models/:model/image", async (req, res) => {
  const file = models.filePath(req.params.model);
  if (!file) return res.status(404).json({ error: "Sem foto" });
  sendFile(res, file);
});

api.post("/api/models/:model/image", async (req, res) => {
  const { dataUrl, url } = req.body || {};
  if (dataUrl) models.setFile(req.params.model, dataUrl);
  else if (url) models.setUrl(req.params.model, url);
  else return res.status(400).json({ error: "Envie um arquivo ou uma URL." });
  console.log(new Date().toISOString(), `foto do modelo ${req.params.model} alterada por ${req.user.user}`);
  res.json({ image: models.imageUrl(req.params.model) });
});

api.delete("/api/models/:model/image", async (req, res) => {
  models.remove(req.params.model);
  res.json({ ok: true });
});

// Teste de velocidade (roda em segundo plano; a página acompanha pelo /api/speedtest/:job)
api.post("/api/devices/:id/speedtest", async (req, res) => {
  const type = (req.body || {}).type;
  if (type !== "download" && type !== "upload") return res.status(400).json({ error: "Tipo de teste inválido" });
  const job = speedtest.start(req.params.id, type, req.user.user);
  res.json(job);
});

api.get("/api/speedtest/:job", async (req, res) => {
  const job = speedtest.getJob(req.params.job);
  if (!job) return res.status(404).json({ error: "Teste não encontrado" });
  res.json(job);
});

// Varredura de redes Wi-Fi vizinhas (TR-181 NeighboringWiFiDiagnostic)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
api.post("/api/devices/:id/wifi-scan", async (req, res) => {
  const doc = await nbi.device(req.params.id);
  if (!doc.Device) return res.status(400).json({ error: "Este modelo (TR-098) não suporta varredura de redes vizinhas pelo ACS." });
  res.json(await once("scan:" + req.params.id, async () => {
    const base = "Device.WiFi.NeighboringWiFiDiagnostic";
    let r = await nbi.task(req.params.id, {
      name: "setParameterValues",
      parameterValues: [[base + ".DiagnosticsState", "Requested", "xsd:string"]],
    }, 20000);
    if (r.status === 202) return taskResult(r);
    // A varredura leva alguns segundos; tenta ler o resultado até 2 vezes (cabe no timeout de 60 s do nginx)
    for (let i = 0; i < 2; i++) {
      await sleep(12000);
      r = await nbi.task(req.params.id, { name: "refreshObject", objectName: base }, 20000);
      const fresh = await nbi.devices({ _id: req.params.id }, base + ".DiagnosticsState");
      const state = (((fresh[0] || {}).Device || {}).WiFi || {}).NeighboringWiFiDiagnostic;
      if (state && state.DiagnosticsState && state.DiagnosticsState._value !== "Requested") break;
    }
    return { done: r.status === 200, queued: r.status === 202 };
  }));
});

async function refreshTask(id) {
  const doc = await nbi.device(id);
  return nbi.task(id, { name: "refreshObject", objectName: devices.rootOf(doc) + ".DeviceInfo" });
}

api.post("/api/devices/:id/refresh", async (req, res) => {
  const r = await refreshTask(req.params.id);
  devices.invalidate();
  res.json(taskResult(r));
});

api.post("/api/devices/:id/reboot", async (req, res) => {
  // Reiniciar no meio da gravação do firmware pode deixar o equipamento sem funcionar
  const lock = firmware.lockMinutes(req.params.id);
  if (lock) return res.status(409).json({ error: `Atualização de firmware em andamento. Aguarde ${lock} min antes de reiniciar.` });
  const r = await nbi.task(req.params.id, { name: "reboot" });
  devices.invalidate();
  res.json(taskResult(r));
});

// Reprovisionar: remove a tag Provisioned para o preset 02_PROVISION_IPOE rodar de novo
api.post("/api/devices/:id/reprovision", async (req, res) => {
  await nbi.removeTag(req.params.id, "Provisioned");
  const r = await refreshTask(req.params.id);
  devices.invalidate();
  res.json(taskResult(r));
});

const TAG_RE = /^[A-Za-z0-9_.-]{1,64}$/;
api.post("/api/devices/:id/tags/:tag", async (req, res) => {
  if (!TAG_RE.test(req.params.tag)) return res.status(400).json({ error: "Tag inválida" });
  await nbi.addTag(req.params.id, req.params.tag);
  devices.invalidate();
  res.json({ ok: true });
});

api.delete("/api/devices/:id/tags/:tag", async (req, res) => {
  await nbi.removeTag(req.params.id, req.params.tag);
  devices.invalidate();
  res.json({ ok: true });
});

// ---------- Falhas ----------
api.get("/api/faults", async (req, res) => {
  const [faults, list] = await Promise.all([nbi.faults(), devices.all()]);
  const byId = new Map(list.map((d) => [d.id, d]));
  res.json(faults
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .map((f) => ({ ...f, deviceName: (byId.get(f.device) || {}).ssid || "" })));
});

api.delete("/api/faults/:id", async (req, res) => {
  await nbi.deleteFault(req.params.id);
  res.json({ ok: true });
});

// ---------- Configuração (somente leitura) ----------
for (const c of ["provisions", "presets", "virtual_parameters"]) {
  api.get(`/api/${c}`, async (req, res) => res.json(await nbi.list(c)));
}

// ---------- Servidor ----------
const server = http.createServer(async (req, res) => {
  decorate(req, res);
  res.set({ "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" });
  const { pathname } = new URL(req.url, "http://localhost");

  try {
    // Upload do teste de velocidade: quem envia é o roteador, autorizado pelo token da URL
    // O TP-Link acrescenta o número da conexão ao fim da URL (token + "0", "1", "2")
    const up = pathname.match(/^\/speedtest\/upload\/([a-f0-9]{32})\d{0,2}$/);
    if (up) return speedtest.handleUpload(req, res, up[1]);

    // Cópia do Wi-Fi para a extensão "wifibackup" do GenieACS (só o IP do ACS, sem login)
    const wb = pathname.match(/^\/internal\/wifi\/([A-Za-z0-9_.%-]{1,64})$/);
    if (wb) {
      const ip = String(req.ip || "").replace(/^::ffff:/, "");
      if (req.method !== "GET" || !WIFI_BACKUP_ALLOW.includes(ip)) return res.status(403).json({ error: "Proibido" });
      const e = wifibackup.get(decodeURIComponent(wb[1]));
      if (!e) return res.status(404).json({ error: "Sem cópia" });
      return res.json({ source: "portal", wifi: e.wifi, at: e.at });
    }

    if (!pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).end();
      if (pathname === "/vendor/chart.umd.js") return sendFile(res, CHART_JS, 86400);
      if (pathname === "/favicon.ico") return sendFile(res, path.join(PUBLIC, "favicon.svg"), 86400);
      return serveStatic(PUBLIC, pathname, res);
    }

    // Upload de foto precisa de corpo maior que o padrão de 100 KB
    req.body = await readJson(req, /^\/api\/models\/[^/]+\/image$/.test(pathname) ? 3 * 1024 * 1024 : undefined);
    if (req.method === "POST" && pathname === "/api/login") return auth.login(req, res);
    if (req.method === "POST" && pathname === "/api/logout") return auth.logout(req, res);

    let authed = false;
    auth.requireAuth(req, res, () => (authed = true));
    if (!authed) return;

    const route = api.match(req.method, pathname);
    if (!route) return res.status(404).json({ error: "Rota não encontrada" });
    req.params = route.params;
    for (const handler of route.handlers) await handler(req, res);
  } catch (e) {
    console.error(new Date().toISOString(), req.method, req.url, e.message);
    if (!res.headersSent) res.status(e.status && e.status < 500 ? e.status : 502).json({ error: e.message });
  }
});

server.listen(env.PORT, env.HOST, () => {
  console.log(`Portal Globaltech em http://${env.HOST}:${env.PORT} (NBI ${env.NBI_URL})`);
});
