"use strict";
// Arquivos de firmware guardados no armazenamento de arquivos do GenieACS (GridFS),
// organizados em "pastas" pelo modelo: o nome do arquivo é "<modelo>/<arquivo>" e o
// metadado productClass é o modelo. O roteador baixa pela porta 7567 (genieacs-fs).
const http = require("http");
const fs = require("fs");
const path = require("path");
const { NBI_URL, USERS_FILE } = require("./env");
const nbi = require("./nbi");

const FIRMWARE_TYPE = "1 Firmware Upgrade Image";
const MAX_BYTES = Number(process.env.FIRMWARE_MAX_MB || 300) * 1024 * 1024;

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const safe = (s) => String(s || "").trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 80);

// ---------- Hardwares aceitos por cada arquivo ----------
// O mesmo modelo (ProductClass) pode ter linhas de firmware que não aceitam uma a outra (ex.: o
// "XX530vv1" 0.9.0 foi recusado com 9010). O "hardware" é a primeira palavra do HardwareVersion.
// ATENÇÃO: esse texto vem do firmware, não da placa. O XX530v no 0.2.0 informa "XX530v v2.0" e,
// depois de atualizado para o 0.6.0 (arquivo XX530vV2v2), passa a informar "XX530vV2 v2.0".
// Por isso cada arquivo tem uma LISTA de hardwares aceitos (ex.: XX530vV2, XX530v).
// O GenieACS não guarda campos extras no arquivo, então a lista (e a versão corrigida) ficam
// num arquivo do portal, pelo nome do arquivo.
const META = path.join(path.dirname(USERS_FILE), "firmware-meta.json");

const board = (hw) => String(hw || "").trim().split(/\s+/)[0] || "";
// "XX530vV2, XX530v" -> ["XX530vV2", "XX530v"]; também aceita lista antiga (texto único)
const boards = (v) => [...new Set((Array.isArray(v) ? v : String(v || "").split(/[,;]/)).map((s) => board(s)).filter(Boolean))];
const validBoards = (list) => list.length > 0 && list.length <= 10 && list.every((h) => /^[A-Za-z0-9._-]{1,40}$/.test(h));

function loadMeta() {
  try { return JSON.parse(fs.readFileSync(META, "utf8")); } catch { return {}; }
}
function saveMeta(m) {
  fs.mkdirSync(path.dirname(META), { recursive: true });
  const tmp = META + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, META);
}

async function list() {
  const files = await nbi.list("files");
  const meta = loadMeta();
  return files
    .filter((f) => (f.metadata || {}).fileType === FIRMWARE_TYPE)
    .map((f) => {
      const m = meta[f._id] || {};
      return {
        name: f._id,
        model: (f.metadata || {}).productClass || "",
        hardware: boards(m.hardware),
        version: m.version || (f.metadata || {}).version || "",
        oui: (f.metadata || {}).oui || "",
        size: f.length || 0,
        uploadedAt: f.uploadDate || null,
      };
    })
    .sort((a, b) => a.model.localeCompare(b.model) || String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
}

// Grava hardware e versão de um arquivo que já está no GenieACS
async function setMeta(name, { hardware, version }) {
  const f = (await list()).find((x) => x.name === name);
  if (!f) throw bad("Arquivo de firmware não encontrado.", 404);
  const hw = boards(hardware);
  if (!validBoards(hw)) throw bad("Informe o(s) hardware(s) aceito(s), separados por vírgula. Ex.: XX530vV2, XX530v");
  const v = String(version || "").trim().slice(0, 80);
  const meta = loadMeta();
  meta[name] = { ...(meta[name] || {}), hardware: hw, ...(v ? { version: v } : {}), updatedAt: new Date().toISOString() };
  saveMeta(meta);
  return { ...f, hardware: hw, version: v || f.version };
}

function dropMeta(name) {
  const meta = loadMeta();
  if (meta[name]) { delete meta[name]; saveMeta(meta); }
}

// Recebe o arquivo direto da requisição do navegador (corpo binário) e repassa ao GenieACS sem gravar em disco aqui
function upload(req, { model, hardware, version, filename }) {
  const m = safe(model);
  const f = safe(filename);
  const hw = boards(hardware);
  if (!m) throw bad("Informe o modelo (pasta).");
  if (!validBoards(hw)) throw bad("Informe o(s) hardware(s) que aceitam este firmware, separados por vírgula. Ex.: XX530vV2, XX530v");
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
      res.on("end", () => {
        if (res.statusCode >= 300) return reject(bad(`GenieACS respondeu ${res.statusCode}: ${body.slice(0, 200)}`, 502));
        const meta = loadMeta();
        meta[name] = { hardware: hw, version: String(version || "").trim().slice(0, 80), updatedAt: new Date().toISOString() };
        saveMeta(meta);
        resolve({ name, size: declared, hardware: hw.join(", ") });
      });
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
  dropMeta(name);
}

// Firmware serve para o equipamento? (mesmo modelo e mesma placa de hardware)
function compatible(f, device) {
  if (f.model !== device.model) return `Este arquivo é da pasta ${f.model} e o equipamento é ${device.model}.`;
  if (!f.hardware.length) return `O arquivo ${f.name} não tem o hardware informado. Informe na página Firmware (botão "Hardware / versão") antes de usar.`;
  if (!device.hardware) return "Não foi possível ler o hardware do equipamento. Clique em \"Atualizar agora\" e tente de novo.";
  if (!f.hardware.includes(board(device.hardware))) return `Este firmware é para o hardware ${f.hardware.join(", ")} e o equipamento informa ${board(device.hardware)} (${device.hardware}). O roteador recusaria o arquivo.`;
  return "";
}

// Monta a tarefa de atualização, conferindo modelo e hardware
async function upgradeTask(device, fileName) {
  const f = (await list()).find((x) => x.name === fileName);
  if (!f) throw bad("Arquivo de firmware não encontrado.", 404);
  const why = compatible(f, device);
  if (why) throw bad(why);
  return { file: f, task: { name: "download", fileType: FIRMWARE_TYPE, fileName: f.name } };
}

// ---------- Histórico e proteção contra repetição automática ----------
// Quando o roteador recusa o firmware (ex.: 9010), o GenieACS guarda uma fault no canal da
// tarefa e REPETE o download sozinho mais tarde. Isso já atualizou um aparelho sem ninguém
// confirmar; por isso o portal apaga essas faults assim que aparecem e registra o resultado.
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

module.exports = { list, upload, remove, setMeta, compatible, board, upgradeTask, record, history, lockMinutes, watch, MAX_BYTES };
