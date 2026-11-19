"use strict";
// Cadastro de OLTs (data/olts.json). Senha Telnet e community SNMP ficam criptografadas (AES-256-GCM)
// com a chave data/.olt-key (criada na primeira vez) e NUNCA são devolvidas ao navegador.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { USERS_FILE } = require("./env");
const snmp = require("./snmp");
const telnet = require("./telnet");

const DATA = path.dirname(USERS_FILE);
const FILE = path.join(DATA, "olts.json");
const KEY_FILE = path.join(DATA, ".olt-key");
const TIPOS = {
  vsol: "V-SOL 1600D",
  zte: "ZTE C610",
  nokia: "Nokia 7362 ISAM DF-16GW",
};
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

function chave() {
  if (!fs.existsSync(KEY_FILE)) fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(KEY_FILE, "utf8").trim(), "hex");
}
function cifrar(txt) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", chave(), iv);
  const enc = Buffer.concat([c.update(String(txt), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}
function decifrar(s) {
  if (!s) return "";
  const [iv, tag, enc] = s.split(".").map((x) => Buffer.from(x, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", chave(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return []; }
}
function save(list) {
  fs.writeFileSync(FILE + ".tmp", JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(FILE + ".tmp", FILE);
}
// Versão para o navegador: sem segredos, só se estão preenchidos
const publica = (o) => {
  const { senha, community, senhaAdmin, ...resto } = o;
  return { protocolo: "telnet", snmpVersao: "2c", ...resto, temSenha: !!senha, temCommunity: !!community, temSenhaAdmin: !!senhaAdmin, tipoNome: TIPOS[o.tipo] || o.tipo };
};
const versaoSnmp = (o) => (o.snmpVersao === "1" ? 0 : 1);

function listar() {
  return load().map(publica);
}

function salvar(dados, usuarioPortal) {
  const list = load();
  const ip = String(dados.ip || "").trim();
  if (!/^[0-9a-f.:]{3,45}$/i.test(ip)) throw bad("IP inválido.");
  if (!TIPOS[dados.tipo]) throw bad("Escolha o tipo da OLT.");
  const porta = (v, d) => { const n = Number(v || d); if (!(n >= 1 && n <= 65535)) throw bad("Porta inválida."); return n; };
  let o = dados.id ? list.find((x) => x.id === dados.id) : null;
  if (dados.id && !o) throw bad("OLT não encontrada.", 404);
  if (!o) { o = { id: crypto.randomBytes(6).toString("hex"), criado: new Date().toISOString() }; list.push(o); }
  Object.assign(o, {
    descricao: String(dados.descricao || "").trim().slice(0, 80) || ip,
    tipo: dados.tipo,
    ip,
    snmpPorta: porta(dados.snmpPorta, 161),
    telnetPorta: porta(dados.telnetPorta, 23),
    usuario: String(dados.usuario || "").trim().slice(0, 64),
    protocolo: dados.protocolo === "ssh" ? "ssh" : "telnet",
    snmpVersao: dados.snmpVersao === "1" ? "1" : "2c",
    alterado: new Date().toISOString(),
    alteradoPor: usuarioPortal,
  });
  // Campo vazio = mantém o que já estava gravado
  if (dados.senha) o.senha = cifrar(dados.senha);
  if (dados.community) o.community = cifrar(dados.community);
  if (dados.senhaAdmin) o.senhaAdmin = cifrar(dados.senhaAdmin);
  save(list);
  return publica(o);
}

function remover(id) {
  const list = load();
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) throw bad("OLT não encontrada.", 404);
  list.splice(i, 1);
  save(list);
}

function buscar(id) {
  const o = load().find((x) => x.id === id);
  if (!o) throw bad("OLT não encontrada.", 404);
  return o;
}

// Testa SNMP (nome, descrição e tempo ligado) e Telnet (login). Não muda nada na OLT.
async function testar(id) {
  const o = buscar(id);
  const r = { snmp: null, telnet: null, em: new Date().toISOString() };
  if (o.community) {
    try {
      const v = await snmp.get(o.ip, o.snmpPorta, decifrar(o.community), ["1.3.6.1.2.1.1.1.0", "1.3.6.1.2.1.1.5.0", "1.3.6.1.2.1.1.3.0"], 3000, versaoSnmp(o));
      r.snmp = { ok: true, descricao: String(v[0].value || "").slice(0, 200), nome: v[1].value, ligadoDias: Math.round((v[2].value / 100 / 86400) * 10) / 10 };
    } catch (e) { r.snmp = { ok: false, erro: e.message }; }
  } else r.snmp = { ok: false, erro: "community não cadastrada" };
  if (o.protocolo === "ssh") r.telnet = { ok: false, erro: "SSH ainda não é suportado pelo portal; use Telnet" };
  else if (o.usuario && o.senha) {
    let s;
    try {
      const l = await telnet.login(o.ip, o.telnetPorta, o.usuario, decifrar(o.senha));
      s = l.sessao;
      r.telnet = { ok: true, prompt: l.prompt, banner: l.banner };
      // V-SOL (prompt ">"): confere também o modo privilegiado com a senha admin
      if (o.tipo === "vsol" && /[^#]>s*$/.test(l.prompt)) {
        try { await telnet.enable(s, o.senhaAdmin ? decifrar(o.senhaAdmin) : decifrar(o.senha)); r.telnet.enable = "ok"; }
        catch (e) { r.telnet.enable = e.message; }
      }
    } catch (e) { r.telnet = { ok: false, erro: e.message }; } finally { if (s) s.fechar(); }
  } else r.telnet = { ok: false, erro: "usuário/senha não cadastrados" };
  const list = load();
  const x = list.find((y) => y.id === id);
  if (x) { x.ultimoTeste = r; save(list); }
  return r;
}

// Comandos SOMENTE de leitura (para levantar o formato das saídas de cada fabricante)
const LEITURA_RE = /^(show|display|info)\b[^;|&`$]*$|^(enable|en|exit|end|quit|terminal length \d+|screen-length \d+( temporary)?|configure terminal|conf t|interface (gpon|epon) \S+|environment inhibit-alarms)$/i;
async function lerComandos(id, comandos) {
  const o = buscar(id);
  const lista = (Array.isArray(comandos) ? comandos : []).map((c) => String(c).trim()).filter(Boolean).slice(0, 40);
  if (!lista.length) throw bad("Informe os comandos.");
  const proibido = lista.find((c) => !LEITURA_RE.test(c));
  if (proibido) throw bad(`Comando não permitido (só leitura): ${proibido}`);
  if (!o.usuario || !o.senha) throw bad("Usuário/senha Telnet não cadastrados.");
  const l = await telnet.login(o.ip, o.telnetPorta, o.usuario, decifrar(o.senha));
  try {
    if (o.tipo === "vsol" && /[^#]>s*$/.test(l.prompt)) await telnet.enable(l.sessao, o.senhaAdmin ? decifrar(o.senhaAdmin) : decifrar(o.senha));
    return { prompt: l.prompt, saidas: await telnet.executar(l.sessao, lista, 60000) };
  } finally { l.sessao.fechar(); }
}

async function snmpWalk(id, oid, max = 300) {
  const o = buscar(id);
  if (!/^\.?\d+(\.\d+)+$/.test(String(oid || ""))) throw bad("OID inválido.");
  if (!o.community) throw bad("Community não cadastrada.");
  return snmp.walk(o.ip, o.snmpPorta, decifrar(o.community), String(oid), Math.min(Number(max) || 300, 5000), versaoSnmp(o));
}

module.exports = { TIPOS, listar, salvar, remover, testar, lerComandos, snmpWalk };
