"use strict";
// Cliente Telnet mínimo para ler OLTs (login + comandos de leitura), sem dependências.
// Recusa todas as opções Telnet negociadas, trata paginação (--More--) e espera o prompt.
const net = require("net");

const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const LOGIN_RE = /(user ?name|login|usuario|user)\s*:\s*$/i;
const PASS_RE = /pass ?word\s*:\s*$/i;
const PROMPT_RE = /[\w\-.:()\/@\[\] ]{1,60}[>#$%]\s*$/;
const MORE_RE = /(-+ ?more ?-+|--more--|press any key|<--- more --->|\[more\]|---- more ----)[^\n]*$/i;
const FALHA_RE = /(login incorrect|authentication failed|invalid (user|password|login)|access denied|bad password|login failed|% ?authentication)/i;

class Sessao {
  constructor(host, port, timeout = 15000) {
    this.host = host; this.port = port; this.timeout = timeout;
    this.buf = ""; this.waiters = [];
  }
  conectar() {
    return new Promise((resolve, reject) => {
      this.sock = net.createConnection({ host: this.host, port: this.port, timeout: this.timeout }, resolve);
      this.sock.on("timeout", () => this.sock.destroy(new Error(`Telnet sem resposta de ${this.host}:${this.port}`)));
      this.sock.on("error", (e) => { reject(e); this._acordar(e); });
      this.sock.on("close", () => this._acordar(new Error("conexão Telnet fechada pela OLT")));
      this.sock.on("data", (d) => this._dados(d));
    });
  }
  _dados(d) {
    const out = [];
    for (let i = 0; i < d.length; i++) {
      if (d[i] !== IAC) { out.push(d[i]); continue; }
      const cmd = d[i + 1];
      if (cmd === IAC) { out.push(IAC); i++; continue; }
      if (cmd === DO || cmd === DONT || cmd === WILL || cmd === WONT) {
        const opt = d[i + 2];
        // Aceita só eco e supressão de go-ahead do lado da OLT; recusa o resto
        if (cmd === DO) this.sock.write(Buffer.from([IAC, WONT, opt]));
        else if (cmd === WILL) this.sock.write(Buffer.from([IAC, opt === 1 || opt === 3 ? DO : DONT, opt]));
        i += 2; continue;
      }
      if (cmd === SB) { while (i < d.length && !(d[i] === IAC && d[i + 1] === SE)) i++; i++; continue; }
      i++;
    }
    this.buf += Buffer.from(out).toString("latin1").replace(/\r/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    if (MORE_RE.test(this.buf.slice(-120))) { this.buf = this.buf.replace(MORE_RE, ""); this.sock.write(" "); }
    this._acordar();
  }
  _acordar(err) {
    for (const w of this.waiters.splice(0)) w(err);
  }
  // Espera o texto acumulado casar com a regex; devolve tudo o que chegou
  esperar(re, ms = this.timeout) {
    return new Promise((resolve, reject) => {
      const fim = Date.now() + ms;
      const checar = (err) => {
        if (re.test(this.buf)) { const t = this.buf; this.buf = ""; return resolve(t); }
        if (err) return reject(err);
        if (Date.now() > fim) return reject(new Error(`tempo esgotado esperando resposta da OLT (último texto: "${this.buf.slice(-80).trim()}")`));
        this.waiters.push(checar);
        setTimeout(() => this._acordar(), Math.min(1000, fim - Date.now() + 10));
      };
      checar();
    });
  }
  enviar(txt) { this.sock.write(txt + "\r\n"); }
  fechar() { try { this.sock.end(); this.sock.destroy(); } catch {} }
}

// Faz login; devolve a sessão aberta e o prompt
async function login(host, port, usuario, senha, timeout = 15000) {
  const s = new Sessao(host, port, timeout);
  await s.conectar();
  const banner = await s.esperar(new RegExp(`${LOGIN_RE.source}|${PASS_RE.source}`, "i"));
  if (!PASS_RE.test(banner)) {
    s.enviar(usuario);
    await s.esperar(PASS_RE);
  }
  s.enviar(senha);
  let t;
  try {
    t = await s.esperar(new RegExp(`${PROMPT_RE.source}|${FALHA_RE.source}|${LOGIN_RE.source}`, "i"));
  } catch (e) { s.fechar(); throw e; }
  if (FALHA_RE.test(t) || LOGIN_RE.test(t.trim().split("\n").pop())) { s.fechar(); throw new Error("usuário ou senha recusados pela OLT"); }
  const prompt = t.trim().split("\n").pop().trim();
  // Nome da OLT no prompt (ex.: "ZXAN#", "OLT(config)#", "typ:isadmin>#"): base para reconhecer o fim das respostas
  const base = prompt.replace(/[>#$%]+\s*$/, "").replace(/\(.*$/, "");
  s.promptRe = new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[^\\n]{0,40}[>#$%]\\s*$");
  return { sessao: s, prompt, banner: banner.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join(" ") };
}

// Executa comandos e devolve a saída de cada um (sem o eco do comando e sem o prompt final)
async function executar(sessao, comandos, ms = 30000) {
  const saidas = [];
  for (const c of comandos) {
    sessao.enviar(c);
    const t = await sessao.esperar(sessao.promptRe || PROMPT_RE, ms);
    const linhas = t.split("\n");
    if (linhas.length && linhas[0].includes(c.trim())) linhas.shift();
    linhas.pop();
    saidas.push({ comando: c, saida: linhas.join("\n") });
  }
  return saidas;
}

module.exports = { login, executar };
