"use strict";
// Cliente da API NBI do GenieACS (porta 7557)
const { NBI_URL } = require("./env");

async function request(path, { method = "GET", body, timeout = 15000 } = {}) {
  const res = await fetch(NBI_URL + path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`GenieACS respondeu ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  // 200 = tarefa executada; 202 = tarefa enfileirada (dispositivo não respondeu ao connection request)
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

const enc = encodeURIComponent;
let faultCache = { at: 0, list: null };

module.exports = {
  async devices(query = {}, projection) {
    let qs = "?query=" + enc(JSON.stringify(query));
    if (projection) qs += "&projection=" + enc(projection);
    return (await request("/devices/" + qs, { timeout: 30000 })).data || [];
  },
  async device(id) {
    const list = await this.devices({ _id: id });
    if (!list.length) {
      const err = new Error("Dispositivo não encontrado");
      err.status = 404;
      throw err;
    }
    return list[0];
  },
  // Cria uma tarefa e pede ao CPE para conectar agora (connection request)
  async task(id, task, timeout = 5000) {
    return request(`/devices/${enc(id)}/tasks?connection_request&timeout=${timeout}`, {
      method: "POST",
      body: task,
      timeout: timeout + 10000,
    });
  },
  async addTag(id, tag) {
    return request(`/devices/${enc(id)}/tags/${enc(tag)}`, { method: "POST" });
  },
  async removeTag(id, tag) {
    return request(`/devices/${enc(id)}/tags/${enc(tag)}`, { method: "DELETE" });
  },
  // Cache curto: o dashboard de cada operador pede as falhas a cada 60 s
  async faults() {
    if (faultCache.list && Date.now() - faultCache.at < 15000) return faultCache.list;
    const list = (await request("/faults/")).data || [];
    faultCache = { at: Date.now(), list };
    return list;
  },
  invalidateFaults() {
    faultCache.at = 0;
  },
  async deleteFault(id) {
    faultCache.at = 0;
    return request(`/faults/${enc(id)}`, { method: "DELETE" });
  },
  async list(collection) {
    return (await request(`/${collection}/`)).data || [];
  },
  async deleteFile(name) {
    return request(`/files/${enc(name)}`, { method: "DELETE" });
  },
};
