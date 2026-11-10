"use strict";
// Arquivos de firmware guardados no armazenamento de arquivos do GenieACS (GridFS),
// organizados em "pastas" pelo modelo: o nome do arquivo é "<modelo>/<arquivo>" e o
// metadado productClass é o modelo. O roteador baixa pela porta 7567 (genieacs-fs).
const http = require("http");
const { NBI_URL } = require("./env");
const nbi = require("./nbi");

const FIRMWARE_TYPE = "1 Firmware Upgrade Image";
const MAX_BYTES = Number(process.env.FIRMWARE_MAX_MB || 300) * 1024 * 1024;

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const safe = (s) => String(s || "").trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 80);

async function list() {
  const files = await nbi.list("files");
  return files
    .filter((f) => (f.metadata || {}).fileType === FIRMWARE_TYPE)
    .map((f) => ({
      name: f._id,
      model: (f.metadata || {}).productClass || "",
      version: (f.metadata || {}).version || "",
      oui: (f.metadata || {}).oui || "",
      size: f.length || 0,
      uploadedAt: f.uploadDate || null,
    }))
    .sort((a, b) => a.model.localeCompare(b.model) || String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
}

// Recebe o arquivo direto da requisição do navegador (corpo binário) e repassa ao GenieACS sem gravar em disco aqui
function upload(req, { model, version, filename }) {
  const m = safe(model);
  const f = safe(filename);
  if (!m) throw bad("Informe o modelo (pasta).");
  if (!f || !/\.(bin|img|w|fw|tar|gz|zip)$/i.test(f)) throw bad("Nome de arquivo inválido. Use o arquivo de firmware (.bin, .img, .w…).");
  const declared = Number(req.headers["content-length"] || 0);
  if (!declared) throw bad("Arquivo vazio.");
  if (declared > MAX_BYTES) throw bad(`Arquivo muito grande (máximo ${MAX_BYTES / 1048576} MB).`, 413);
  const name = `${m}/${f}`;

  return new Promise((resolve, reject) => {
    const url = new URL(`${NBI_URL}/files/${encodeURIComponent(name)}`);
    const out = http.request(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": declared,
        filetype: FIRMWARE_TYPE,
        productclass: m,
        version: String(version || "").trim().slice(0, 80),
        oui: "",
      },
      timeout: 30 * 60000,
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => (res.statusCode < 300 ? resolve({ name, size: declared }) : reject(bad(`GenieACS respondeu ${res.statusCode}: ${body.slice(0, 200)}`, 502))));
    });
    out.on("timeout", () => out.destroy(new Error("Tempo esgotado enviando ao GenieACS")));
    out.on("error", (e) => reject(bad(e.message, 502)));
    req.on("error", (e) => out.destroy(e));
    req.pipe(out);
  });
}

async function remove(name) {
  const files = await list();
  if (!files.some((f) => f.name === name)) throw bad("Arquivo não encontrado.", 404);
  await nbi.deleteFile(name);
}

// Monta a tarefa de atualização, conferindo que o arquivo é da pasta do mesmo modelo do equipamento
async function upgradeTask(device, fileName) {
  const f = (await list()).find((x) => x.name === fileName);
  if (!f) throw bad("Arquivo de firmware não encontrado.", 404);
  if (f.model !== device.model) throw bad(`Este arquivo é da pasta ${f.model} e o equipamento é ${device.model}.`);
  return { file: f, task: { name: "download", fileType: FIRMWARE_TYPE, fileName: f.name } };
}

// ---------- Histórico e proteção contra repetição automática ----------
// Quando o roteador recusa o firmware (ex.: 9010), o GenieACS guarda uma fault no canal da
// tarefa e REPETE o download sozinho mais tarde. Isso já atualizou um aparelho sem ninguém
// confirmar; por isso o portal apaga essas faults assim que aparecem e registra o resultado.
const fs = require("fs");
const path = require("path");
const { USERS_FILE } = require("./env");

const HISTORY = path.join(path.dirname(USERS_FILE), "firmware-history.json");
const LOCK_MINUTES = 10;

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY, "utf8")); } catch { return {}; }
}
function saveHistory(h) {
  const tmp = HISTORY + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(h, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, HISTORY);
}

function record(deviceId, data) {
  const h = loadHistory();
  h[deviceId] = { ...(h[deviceId] || {}), ...data, updatedAt: new Date().toISOString() };
  saveHistory(h);
  return h[deviceId];
}

function history(deviceId) {
  return loadHistory()[deviceId] || null;
}

// Minutos que ainda faltam para liberar o "Reiniciar" depois de um comando de firmware (0 = liberado)
function lockMinutes(deviceId) {
  const j = history(deviceId);
  if (!j || j.status !== "enviado") return 0;
  const left = LOCK_MINUTES - (Date.now() - Date.parse(j.at)) / 60000;
  return left > 0 ? Math.ceil(left) : 0;
}

let watching = false;
async function watch() {
  if (watching) return;
  watching = true;
  try {
    // 1) Firmware recusado: apaga a fault (impede a repetição) e registra
    for (const f of await nbi.list("faults")) {
      if (!String(f.provisions || "").includes(FIRMWARE_TYPE)) continue;
      await nbi.deleteFault(f._id).catch(() => {});
      record(f.device, { status: "recusado", code: f.code, message: f.message || "", failedAt: f.timestamp });
      console.log(new Date().toISOString(), `firmware recusado por ${f.device} (${f.code}); repetição automática cancelada`);
    }
    // 2) Atualização concluída: a versão do equipamento mudou
    const pend = Object.entries(loadHistory()).filter(([, j]) => j.status === "enviado");
    if (pend.length) {
      const docs = await nbi.devices({ _id: { $in: pend.map(([id]) => id) } }, "_id,Device.DeviceInfo.SoftwareVersion,InternetGatewayDevice.DeviceInfo.SoftwareVersion");
      for (const d of docs) {
        const v = ((((d.Device || {}).DeviceInfo || {}).SoftwareVersion) || (((d.InternetGatewayDevice || {}).DeviceInfo || {}).SoftwareVersion) || {})._value;
        const j = loadHistory()[d._id];
        if (v && j && v !== j.from) record(d._id, { status: "concluido", result: v });
      }
    }
  } catch (e) {
    console.error(new Date().toISOString(), "verificação de firmware:", e.message);
  } finally {
    watching = false;
  }
}
setInterval(watch, 20000).unref();

module.exports = { list, upload, remove, upgradeTask, record, history, lockMinutes, watch, MAX_BYTES };
