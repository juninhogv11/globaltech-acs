#!/usr/bin/env node
"use strict";
// Ajudante do atualizador: grava o estado em JSON (lido pelo portal) e consulta as versões no GitHub.
//   estado.js get <chave>                       valor de estado.json (texto)
//   estado.js set <chave> <valor-json>
//   estado.js inicio <acao> <versao> <usuario>  começa execucao.json/execucao.log
//   estado.js passo "<texto>"                   acrescenta um passo (portal mostra ao vivo)
//   estado.js fim <ok|erro|revertido> "<texto>" encerra a execução e grava no histórico
//   estado.js disponiveis                       lê as tags (stdin, uma por linha) e grava as versões mais novas, com as notas
//   estado.js compara <a> <b>                   imprime -1, 0 ou 1
//   estado.js versao-portal <url>               versão em que o portal está (GET /api/saude); vazio se não responder
//   estado.js relatar <url>                     manda o estado deste ACS para o portal (POST /internal/atualizacao/acs)
// Variáveis: VAR (pasta de estado), REPO (URL do GitHub), CANAL (versoes | teste)
const fs = require("fs");
const path = require("path");

const VAR = process.env.VAR || "/var/lib/globaltech-atualizador";
const EST = path.join(VAR, "estado.json");
const EXE = path.join(VAR, "execucao.json");
const LOG = path.join(VAR, "execucao.log");
const VERSAO_RE = /^v(\d{4})\.(\d{2})\.(\d{2})(?:-(\d{1,3}))?$/;

const ler = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
function gravar(f, obj) {
  fs.writeFileSync(f + ".tmp", JSON.stringify(obj, null, 2), { mode: 0o640 });
  fs.renameSync(f + ".tmp", f);
}
const agora = () => new Date().toISOString();

function chave(v) {
  const m = String(v).match(VERSAO_RE);
  return m ? [+m[1], +m[2], +m[3], +(m[4] || 1)] : null;
}
function compara(a, b) {
  const x = chave(a), y = chave(b);
  if (!x && !y) return 0;
  if (!x) return -1; // "dev"/"main" contam como mais antigas que qualquer versão marcada
  if (!y) return 1;
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// NOVIDADES.md da versão: seções "## vAAAA.MM.DD ..." mais novas que a instalada
function notasEntre(texto, instalada, alvo) {
  const out = [];
  let atual = null;
  for (const linha of String(texto).split(/\r?\n/)) {
    const m = linha.match(/^##\s+(v\d{4}\.\d{2}\.\d{2}(?:-\d{1,3})?)\b(.*)$/);
    if (m) {
      atual = compara(m[1], instalada) > 0 && compara(m[1], alvo) <= 0 ? { versao: m[1], titulo: m[2].replace(/^\s*[—-]\s*/, "").trim(), linhas: [] } : null;
      if (atual) out.push(atual);
      continue;
    }
    if (atual) atual.linhas.push(linha);
  }
  return out.map((s) => ({ versao: s.versao, titulo: s.titulo, texto: s.linhas.join("\n").trim().slice(0, 4000) }));
}

async function disponiveis() {
  const e = ler(EST, {});
  const instalada = e.instalada || "dev";
  const tags = fs.readFileSync(0, "utf8").split(/\s+/).map((s) => s.trim()).filter((t) => VERSAO_RE.test(t));
  const novas = tags.filter((t) => compara(t, instalada) > 0).sort(compara).reverse().slice(0, 10);
  const lista = novas.map((v) => ({ versao: v }));
  // Notas da versão mais nova (cobre as intermediárias também)
  const m = String(process.env.REPO || "").match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (m && novas.length) {
    try {
      const r = await fetch(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${novas[0]}/NOVIDADES.md`, { signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        const notas = notasEntre(await r.text(), instalada, novas[0]);
        for (const d of lista) d.notas = notas.find((n) => n.versao === d.versao) || null;
      }
    } catch {}
  }
  if (process.env.CANAL === "teste") lista.push({ versao: "main", notas: { versao: "main", titulo: "Desenvolvimento (só servidor de teste)", texto: "Última versão do branch main, ainda não marcada." } });
  e.disponiveis = lista;
  e.verificadoEm = agora();
  e.erroVerificacao = null;
  e.canal = process.env.CANAL || "versoes";
  gravar(EST, e);
  console.log(novas.length ? `Versões novas: ${novas.join(", ")}` : `Nenhuma versão mais nova que ${instalada}.`);
}

function logar(texto) {
  fs.appendFileSync(LOG, `${agora().slice(0, 19).replace("T", " ")}  ${texto}\n`, { mode: 0o640 });
}

(async () => {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === "get") {
    const v = ler(EST, {})[a];
    process.stdout.write(v == null ? "" : typeof v === "string" ? v : JSON.stringify(v));
  } else if (cmd === "set") {
    const e = ler(EST, {});
    e[a] = JSON.parse(b);
    gravar(EST, e);
  } else if (cmd === "inicio") {
    fs.writeFileSync(LOG, "", { mode: 0o640 });
    gravar(EXE, { estado: "rodando", acao: a, versao: b, de: ler(EST, {}).instalada || "dev", usuario: c || "", inicio: agora(), passos: [] });
    logar(`Início: ${a} ${b || ""} (pedido por ${c || "?"})`);
  } else if (cmd === "passo") {
    const x = ler(EXE, { passos: [] });
    x.passos.push({ em: agora(), texto: a });
    gravar(EXE, x);
    logar(a);
  } else if (cmd === "fim") {
    const x = ler(EXE, {});
    Object.assign(x, { estado: a, fim: agora(), mensagem: b || "" });
    gravar(EXE, x);
    logar(`Fim: ${a}${b ? " — " + b : ""}`);
    const e = ler(EST, {});
    e.historico = [...(e.historico || []), { em: x.fim, acao: x.acao, de: x.de, para: x.versao, usuario: x.usuario, resultado: a, mensagem: b || "" }].slice(-50);
    gravar(EST, e);
  } else if (cmd === "disponiveis") {
    await disponiveis();
  } else if (cmd === "erro-verificacao") {
    const e = ler(EST, {});
    e.erroVerificacao = a;
    e.verificadoEm = agora();
    gravar(EST, e);
  } else if (cmd === "compara") {
    console.log(compara(a, b));
  } else if (cmd === "versao-portal") {
    // Versão em que o portal (outro servidor) está: GET <url>/api/saude
    try {
      const r = await fetch(a.replace(/\/+$/, "") + "/api/saude", { signal: AbortSignal.timeout(10000) });
      const j = r.ok ? await r.json() : {};
      if (VERSAO_RE.test(String(j.versao || ""))) console.log(j.versao);
    } catch {}
  } else if (cmd === "relatar") {
    // ACS em servidor separado: manda o estado para o portal mostrar na página Atualizações
    const e = ler(EST, {}), x = ler(EXE, null);
    const corpo = {
      instalada: e.instalada || "dev", anterior: e.anterior || null, seguirFalhou: e.seguirFalhou || null,
      historico: (e.historico || []).slice(-10),
      execucao: x && { estado: x.estado, acao: x.acao, versao: x.versao, de: x.de, usuario: x.usuario, inicio: x.inicio, fim: x.fim || null,
        mensagem: x.mensagem || "", passos: (x.passos || []).slice(-40) },
    };
    try {
      const r = await fetch(a.replace(/\/+$/, "") + "/internal/atualizacao/acs", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) console.error(`portal respondeu ${r.status} ao relatar (o IP deste servidor está no WIFI_BACKUP_ALLOW do portal?)`);
    } catch (err) { console.error(`não consegui relatar ao portal: ${err.message}`); }
  } else {
    console.error("uso: estado.js get|set|inicio|passo|fim|disponiveis|erro-verificacao|compara|versao-portal|relatar");
    process.exit(2);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
