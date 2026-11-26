"use strict";
// Atualizações do sistema pelo portal (versões marcadas no GitHub: v2026.11.25, v2026.11.25-2 ...).
// O portal NÃO instala nada: só lê o estado gravado pelo atualizador e deixa um pedido em
// <ATUALIZADOR_DIR>/pedidos/pedido.json. Quem executa é o serviço globaltech-atualizador (root), disparado pelo systemd
// assim que o arquivo aparece. Ver atualizador/LEIA-ME.md.
const fs = require("fs");
const path = require("path");
const env = require("./env");

const DIR = env.ATUALIZADOR_DIR;
const VERSAO_RE = /^v\d{4}\.\d{2}\.\d{2}(-\d{1,3})?$/;
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

function lerJson(nome) {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, nome), "utf8")); } catch { return null; }
}
function lerLog() {
  try { return fs.readFileSync(path.join(DIR, "execucao.log"), "utf8").split("\n").slice(-200).join("\n"); } catch { return ""; }
}

// ACS em servidor separado: ele segue a versão do portal e manda o estado para cá (POST /internal/atualizacao/acs,
// só dos IPs do WIFI_BACKUP_ALLOW). Guardado em data/atualizacao-acs.json, só com os campos esperados.
const ACS_FILE = path.join(path.dirname(env.USERS_FILE), "atualizacao-acs.json");
const txt = (s, n = 300) => (typeof s === "string" ? s.slice(0, n) : s == null ? null : String(s).slice(0, n));
function receberAcs(b, ip) {
  if (!b || typeof b !== "object") throw bad("corpo inválido");
  const x = b.execucao && typeof b.execucao === "object" ? b.execucao : null;
  const limpo = {
    ip, recebidoEm: new Date().toISOString(),
    instalada: txt(b.instalada, 40), anterior: txt(b.anterior, 40), seguirFalhou: txt(b.seguirFalhou, 40),
    historico: (Array.isArray(b.historico) ? b.historico.slice(-10) : []).map((h) => ({
      em: txt(h.em, 40), acao: txt(h.acao, 20), de: txt(h.de, 40), para: txt(h.para, 40), usuario: txt(h.usuario, 60), resultado: txt(h.resultado, 20), mensagem: txt(h.mensagem),
    })),
    execucao: x && {
      estado: txt(x.estado, 20), acao: txt(x.acao, 20), versao: txt(x.versao, 40), de: txt(x.de, 40), usuario: txt(x.usuario, 60),
      inicio: txt(x.inicio, 40), fim: txt(x.fim, 40), mensagem: txt(x.mensagem),
      passos: (Array.isArray(x.passos) ? x.passos.slice(-40) : []).map((p) => ({ em: txt(p.em, 40), texto: txt(p.texto) })),
    },
  };
  fs.writeFileSync(ACS_FILE + ".tmp", JSON.stringify(limpo), { mode: 0o640 });
  fs.renameSync(ACS_FILE + ".tmp", ACS_FILE);
  return { ok: true };
}
function estadoAcs() {
  try { return JSON.parse(fs.readFileSync(ACS_FILE, "utf8")); } catch { return null; }
}

function podeAtualizar(usuario) {
  return env.ATUALIZAR_USUARIOS.includes(usuario);
}

function estado(usuario) {
  const e = lerJson("estado.json");
  const x = lerJson("execucao.json");
  return {
    instalado: fs.existsSync(path.join(DIR, "estado.json")),
    versaoPortal: env.VERSAO,
    versao: (e && e.instalada) || env.VERSAO,
    anterior: (e && e.anterior) || null,
    canal: (e && e.canal) || "versoes",
    partes: (e && e.partes) || {},
    verificadoEm: (e && e.verificadoEm) || null,
    erroVerificacao: (e && e.erroVerificacao) || null,
    disponiveis: (e && e.disponiveis) || [],
    historico: ((e && e.historico) || []).slice(-15).reverse(),
    execucao: x,
    log: x ? lerLog() : "",
    pedidoPendente: fs.existsSync(path.join(DIR, "pedidos", "pedido.json")),
    podeAtualizar: podeAtualizar(usuario),
    acsSeparado: estadoAcs(),
    // Atualização automática: { ativo, hora } (gravada pelo atualizador a partir do pedido "auto"); autoFalhou = versão que falhou
    automatico: (e && e.automatico) || null,
    autoFalhou: (e && e.autoFalhou) || null,
  };
}

function pedir(p, usuario) {
  if (!podeAtualizar(usuario)) throw bad("Seu usuário não pode atualizar o sistema (ATUALIZAR_USUARIOS no .env do portal).", 403);
  const e = lerJson("estado.json");
  if (!e) throw bad("O atualizador não está instalado neste servidor (veja atualizador/LEIA-ME.md).", 409);
  const x = lerJson("execucao.json");
  if (x && x.estado === "rodando" && Date.now() - Date.parse(x.inicio) < 30 * 60000) throw bad("Já há uma atualização em andamento.", 409);
  if (fs.existsSync(path.join(DIR, "pedidos", "pedido.json"))) throw bad("Já há um pedido aguardando o atualizador.", 409);
  const pedido = { acao: p.acao, usuario, em: new Date().toISOString() };
  if (p.acao === "aplicar") {
    const v = String(p.versao || "");
    if (v !== "main" && (v === env.VERSAO || v === e.instalada)) throw bad(`A versão ${v} já está instalada. Recarregue a página.`, 409);
    const ok = (VERSAO_RE.test(v) || (v === "main" && e.canal === "teste")) && (e.disponiveis || []).some((d) => d.versao === v);
    if (!ok) throw bad("Versão inválida ou não disponível. Clique em \"Verificar agora\".");
    pedido.versao = v;
  } else if (p.acao === "voltar") {
    if (!e.anterior) throw bad("Não há versão anterior registrada para voltar.");
  } else if (p.acao === "auto") {
    const hora = Number(p.hora);
    if (!Number.isInteger(hora) || hora < 0 || hora > 23) throw bad("Escolha a hora (0 a 23).");
    if (e.partes && !e.partes.portal) throw bad("Este servidor segue o portal; a atualização automática fica no portal.");
    pedido.ativo = !!p.ativo;
    pedido.hora = hora;
  } else if (p.acao !== "verificar") {
    throw bad("Ação inválida.");
  }
  const arq = path.join(DIR, "pedidos", "pedido.json");
  try {
    fs.writeFileSync(arq + ".tmp", JSON.stringify(pedido), { mode: 0o660 });
    fs.renameSync(arq + ".tmp", arq);
  } catch (err) {
    throw bad(`Não consegui deixar o pedido para o atualizador: ${err.message}`, 500);
  }
  return { ok: true, pedido };
}

module.exports = { estado, pedir, podeAtualizar, receberAcs };
