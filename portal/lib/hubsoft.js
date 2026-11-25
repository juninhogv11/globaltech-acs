"use strict";
// Grava o Wi-Fi alterado pelo portal na "Documentação de Senhas" do serviço do cliente no Hubsoft,
// no mesmo formato que a extensão do ACS lê para restaurar após reset:
//   descrição "Wi-Fi" (2,4 GHz) e "Wi-Fi 5G" (5 GHz); usuário = nome da rede; senha = senha da rede.
// Se já existir uma linha de Wi-Fi da mesma faixa, ela é editada (não cria outra).
// Ativo quando HUBSOFT_URL, HUBSOFT_CLIENT_ID, HUBSOFT_CLIENT_SECRET, HUBSOFT_USUARIO e HUBSOFT_SENHA estão no .env.
// API: https://docs.hubsoft.com.br (oAuth password grant; token de 30 dias, guardado só em memória).
require("./env"); // carrega o .env em process.env

const TIMEOUT_MS = 8000;
const API = "/api/v1/integracao";

function conf() {
  return {
    url: String(process.env.HUBSOFT_URL || "").replace(/\/+$/, ""),
    client_id: process.env.HUBSOFT_CLIENT_ID || "",
    client_secret: process.env.HUBSOFT_CLIENT_SECRET || "",
    username: process.env.HUBSOFT_USUARIO || "",
    password: process.env.HUBSOFT_SENHA || "",
  };
}

function ativo() {
  const c = conf();
  return !!(c.url && c.client_id && c.client_secret && c.username && c.password);
}

async function req(method, caminho, body, token) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  let r;
  try {
    r = await fetch(conf().url + caminho, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(e.name === "TimeoutError" ? `Hubsoft não respondeu em ${TIMEOUT_MS / 1000} s` : `Hubsoft: ${e.message}`);
  }
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* resposta não JSON */ }
  return { status: r.status, json, text };
}

let cache = null; // { token, exp }
async function token(forcar) {
  if (!forcar && cache && cache.exp > Date.now() + 3600000) return cache.token;
  const c = conf();
  const r = await req("POST", "/oauth/token", {
    client_id: c.client_id, client_secret: c.client_secret, username: c.username, password: c.password, grant_type: "password",
  });
  if (r.status !== 200 || !r.json || !r.json.access_token) {
    throw new Error(`Hubsoft: login da API falhou (${(r.json && (r.json.message || r.json.error)) || "HTTP " + r.status})`);
  }
  cache = { token: r.json.access_token, exp: Date.now() + Number(r.json.expires_in || 86400) * 1000 };
  return cache.token;
}

async function api(method, caminho, body) {
  let r = await req(method, caminho, body, await token(false));
  if (r.status === 401) r = await req(method, caminho, body, await token(true));
  if (r.status < 200 || r.status >= 300 || (r.json && r.json.status === "error")) {
    const msg = (r.json && (r.json.msg || r.json.message)) || String(r.text || "").slice(0, 150);
    throw new Error(`Hubsoft HTTP ${r.status}: ${msg}`);
  }
  return r.json || {};
}

// Mesmo critério da extensão do ACS (acs/ext/hubsoft)
const ehWifi = (d) => /wi-?fi|ssid|wireless|wlan/i.test(d);
const eh5 = (d) => /5\s*g/i.test(d);

// wifi: { "2.4GHz": { ssid, pass }, "5GHz": { ssid, pass } } (como na cópia do portal)
// Devolve o que foi feito por faixa, ex.: ["Wi-Fi atualizado", "Wi-Fi 5G cadastrado"]. Nunca devolve senhas.
async function gravarWifi(idServico, wifi) {
  const id = String(idServico || "").trim();
  if (!/^\d+$/.test(id)) throw new Error("serviço do Hubsoft inválido");
  const j = await api("GET", `${API}/cliente/cliente_servico/${id}/senhas`);
  const atuais = Array.isArray(j.cliente_servico_senha) ? j.cliente_servico_senha : [];
  const feito = [];
  for (const [band, w] of Object.entries(wifi || {})) {
    if (!w || !w.ssid) continue;
    const cinco = band === "5GHz";
    const descricao = cinco ? "Wi-Fi 5G" : "Wi-Fi";
    if (!w.pass) { feito.push(`${descricao}: sem senha conhecida, não gravado`); continue; }
    const ex = atuais.find((s) => ehWifi(String(s.descricao || "")) && eh5(String(s.descricao || "")) === cinco);
    if (ex) {
      if (ex.usuario === w.ssid && ex.senha === w.pass) { feito.push(`${descricao} já estava igual`); continue; }
      await api("PUT", `${API}/cliente/cliente_servico/senhas/${encodeURIComponent(ex.id_cliente_servico_senha)}`, { usuario: w.ssid, senha: w.pass });
      feito.push(`${descricao} atualizado`);
    } else {
      await api("POST", `${API}/cliente/cliente_servico/senhas`, { id_cliente_servico: Number(id), descricao, usuario: w.ssid, senha: w.pass });
      feito.push(`${descricao} cadastrado`);
    }
  }
  return feito;
}

module.exports = { ativo, gravarWifi };
