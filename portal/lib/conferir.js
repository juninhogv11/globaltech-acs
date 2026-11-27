"use strict";
// Conferir instalação (como o "validate" do LibreNMS): lista o que está certo e o que precisa de atenção neste servidor.
// Só LÊ: não muda nada. Roda como o usuário "portal" (sem root), então confere o que dá para ver daqui.
// Cada item: { grupo, nome, nivel: ok | warn | bad | info, detalhe, dica }
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const env = require("./env");
const nbi = require("./nbi");
const backup = require("./backup");
const olts = require("./olts");
const oltcoleta = require("./oltcoleta");
const atualizacao = require("./atualizacao");

const DATA = path.dirname(env.USERS_FILE);
const sh = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 5000 }, (err, out) => resolve(err && !out ? null : String(out || "").trim()));
});
const idade = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 60000 : Infinity); // minutos
const txtIdade = (min) => (min === Infinity ? "nunca" : min < 60 ? `há ${Math.round(min)} min` : min < 2880 ? `há ${Math.round(min / 60)} h` : `há ${Math.round(min / 1440)} dias`);

// Debian: fim do suporte de segurança (o Node e o GenieACS usam os pacotes do Debian)
const DEBIAN = {
  11: ["bad", "sem atualizações de segurança desde ago/2026", "Planeje a migração do servidor para o Debian 13."],
  12: ["warn", "em suporte de longo prazo (LTS) até jun/2028", "Funciona; planeje a migração para o Debian 13 com calma."],
  13: ["ok", "em suporte", ""],
};

async function servidor(out) {
  const g = "Servidor";
  const node = Number(process.versions.node.split(".")[0]);
  out.push({ grupo: g, nome: "Node.js", nivel: node >= 18 ? "ok" : "bad", detalhe: process.version,
    dica: node >= 18 ? "" : "O portal precisa do Node 18 ou mais novo." });
  try {
    const v = fs.readFileSync("/etc/debian_version", "utf8").trim();
    const d = DEBIAN[Number(v.split(".")[0])];
    out.push({ grupo: g, nome: "Sistema", nivel: d ? d[0] : "info", detalhe: `Debian ${v}${d ? ` — ${d[1]}` : ""}`, dica: d ? d[2] : "" });
  } catch {
    out.push({ grupo: g, nome: "Sistema", nivel: "info", detalhe: `${os.type()} ${os.release()}`, dica: "" });
  }
  try {
    const s = fs.statfsSync(DATA);
    const livreGb = (s.bavail * s.bsize) / 1e9;
    out.push({ grupo: g, nome: "Espaço em disco", nivel: livreGb < 1 ? "bad" : livreGb < 5 ? "warn" : "ok",
      detalhe: `${livreGb.toFixed(1)} GB livres`, dica: livreGb < 5 ? "Pouco espaço: libere disco (logs, backups antigos) antes que o portal pare de gravar." : "" });
  } catch {}
  try {
    const m = fs.readFileSync("/proc/meminfo", "utf8");
    const kb = (k) => Number((m.match(new RegExp(`^${k}:\\s+(\\d+)`, "m")) || [])[1] || 0);
    const disp = kb("MemAvailable") / 1024, total = kb("MemTotal") / 1024;
    out.push({ grupo: g, nome: "Memória", nivel: disp < 150 ? "bad" : disp < 400 ? "warn" : "ok",
      detalhe: `${Math.round(disp)} MB disponíveis de ${Math.round(total)} MB`, dica: disp < 400 ? "Pouca memória livre: o servidor pode ficar lento." : "" });
  } catch {}
  const ntp = await sh("timedatectl", ["show", "-p", "NTPSynchronized", "--value"]);
  if (ntp) out.push({ grupo: g, nome: "Relógio sincronizado (NTP)", nivel: ntp === "yes" ? "ok" : "warn", detalhe: ntp === "yes" ? "sim" : "não",
    dica: ntp === "yes" ? "" : "Sem NTP, as horas das quedas e das sessões ficam erradas. Confira com: timedatectl" });
  try {
    const f = path.join(DATA, `.conferir-${process.pid}`);
    fs.writeFileSync(f, "x"); fs.unlinkSync(f);
    out.push({ grupo: g, nome: "Pasta de dados", nivel: "ok", detalhe: `${DATA} (gravável)`, dica: "" });
  } catch (e) {
    out.push({ grupo: g, nome: "Pasta de dados", nivel: "bad", detalhe: `${DATA}: ${e.code || e.message}`, dica: "O portal não consegue gravar: confira dono e permissões (usuário portal)." });
  }
  try {
    const modo = fs.statSync(env.USERS_FILE).mode & 0o077;
    out.push({ grupo: g, nome: "Permissão do arquivo de usuários", nivel: modo ? "warn" : "ok", detalhe: modo ? "outros usuários do servidor podem ler" : "só o portal lê",
      dica: modo ? `chmod 600 ${env.USERS_FILE}` : "" });
  } catch {}
}

async function genieacs(out) {
  const g = "GenieACS";
  const t0 = Date.now();
  try {
    await nbi.devices({}, "_id");
    const ms = Date.now() - t0;
    out.push({ grupo: g, nome: "API NBI", nivel: ms > 5000 ? "warn" : "ok", detalhe: `${env.NBI_URL} respondeu em ${ms} ms`,
      dica: ms > 5000 ? "NBI lenta: confira o banco (MongoDB) e a carga do servidor do ACS." : "" });
  } catch (e) {
    out.push({ grupo: g, nome: "API NBI", nivel: "bad", detalhe: `${env.NBI_URL}: ${e.message}`,
      dica: "O portal não fala com o GenieACS: confira o serviço genieacs-nbi e o firewall (porta 7557)." });
  }
  // Serviços do GenieACS neste servidor (só quando instalados aqui)
  for (const s of ["genieacs-cwmp", "genieacs-nbi", "genieacs-fs", "mongod"]) {
    const load = await sh("systemctl", ["show", "-p", "LoadState", "--value", s]);
    if (!load || load === "not-found") continue;
    const ativo = await sh("systemctl", ["is-active", s]);
    out.push({ grupo: g, nome: `Serviço ${s}`, nivel: ativo === "active" ? "ok" : "bad", detalhe: ativo || "?",
      dica: ativo === "active" ? "" : `Veja o motivo com: journalctl -u ${s} -n 50` });
  }
}

async function atualizador(out) {
  const g = "Atualizações";
  const e = atualizacao.estado("");
  if (!e.instalado) {
    out.push({ grupo: g, nome: "Atualizador", nivel: "warn", detalhe: "não instalado",
      dica: "No servidor, como root, dentro da pasta do projeto: bash atualizador/instalar-atualizador.sh" });
    return;
  }
  out.push({ grupo: g, nome: "Versão instalada", nivel: "info", detalhe: `${e.versao}${e.canal === "teste" ? " (servidor de teste)" : ""}`, dica: "" });
  const novas = (e.disponiveis || []).filter((d) => d.versao !== "main");
  out.push({ grupo: g, nome: "Versão nova", nivel: novas.length ? "warn" : "ok", detalhe: novas.length ? `${novas[0].versao} disponível` : "está na mais nova",
    dica: novas.length ? "Atualize em Configuração → Atualizações." : "" });
  const min = idade(e.verificadoEm);
  out.push({ grupo: g, nome: "Consulta ao GitHub", nivel: e.erroVerificacao ? "bad" : min > 2 * 1440 ? "warn" : "ok",
    detalhe: e.erroVerificacao ? e.erroVerificacao : `última ${txtIdade(min)}`,
    dica: e.erroVerificacao ? "O servidor precisa de acesso à internet (github.com) para ver versões novas." : min > 2 * 1440 ? "A consulta diária não está rodando: systemctl status globaltech-atualizador-verificar.timer" : "" });
  const x = e.execucao;
  if (x && x.estado !== "ok" && x.estado !== "rodando") out.push({ grupo: g, nome: "Última atualização", nivel: "warn",
    detalhe: `${x.versao || ""}: ${x.estado === "revertido" ? "falhou e foi desfeita" : "falhou"}${x.mensagem ? ` — ${x.mensagem}` : ""}`, dica: "Veja o registro na página Atualizações." });
  for (const u of ["globaltech-atualizador.path", "globaltech-atualizador-verificar.timer"]) {
    const ativo = await sh("systemctl", ["is-active", u]);
    if (ativo !== null) out.push({ grupo: g, nome: `Serviço ${u}`, nivel: ativo === "active" ? "ok" : "warn", detalhe: ativo,
      dica: ativo === "active" ? "" : `Como root: systemctl enable --now ${u}` });
  }
  const a = e.automatico;
  out.push({ grupo: g, nome: "Atualização automática", nivel: "info",
    detalhe: a && a.ativo ? `ligada, às ${String(a.hora).padStart(2, "0")}h` : "desligada (só pelo botão)", dica: "" });
  const acs = e.acsSeparado;
  if (acs) {
    const m = idade(acs.recebidoEm);
    const igual = acs.instalada === e.versao;
    out.push({ grupo: g, nome: `ACS separado (${acs.ip || "?"})`, nivel: m > 10 ? "bad" : !igual ? "warn" : "ok",
      detalhe: `${acs.instalada}, último contato ${txtIdade(m)}${acs.seguirFalhou ? ` — falhou ao instalar ${acs.seguirFalhou}` : ""}`,
      dica: m > 10 ? "O ACS não está mandando notícias: no ACS, systemctl status globaltech-atualizador-seguir.timer" : !igual ? "O ACS ainda não está na versão do portal (ele atualiza em até 2 min)." : "" });
  }
}

async function integracoes(out) {
  const g = "Integrações";
  if (backup.configured()) {
    try {
      const l = await backup.agent("GET", "/backups", undefined, 15000);
      const ult = (l.backups || []).map((b) => b.data).sort().pop();
      const min = ult ? idade(ult.replace(" ", "T") + ":00-03:00") : Infinity;
      out.push({ grupo: g, nome: "Backup do ACS", nivel: l.erroDestino ? "bad" : min > 36 * 60 ? "warn" : "ok",
        detalhe: l.erroDestino ? `destino com erro: ${l.erroDestino}` : `último ${txtIdade(min)}${l.destino ? ` → ${l.destino}` : ""}`,
        dica: l.erroDestino ? "Confira o destino (FTP/SFTP) em /etc/genieacs-backup/backup.env no servidor do ACS." : min > 36 * 60 ? "O backup diário não rodou: no ACS, systemctl status genieacs-backup.timer" : "" });
    } catch (e) {
      out.push({ grupo: g, nome: "Backup do ACS", nivel: "bad", detalhe: e.message, dica: "A API de backup (porta 7570) não respondeu: confira o serviço genieacs-backup-api e o firewall." });
    }
  } else out.push({ grupo: g, nome: "Backup do ACS", nivel: "info", detalhe: "não configurado no portal", dica: "" });
  if (!process.env.WIFI_BACKUP_ALLOW) out.push({ grupo: g, nome: "IP do ACS liberado (WIFI_BACKUP_ALLOW)", nivel: "warn", detalhe: "não definido no .env",
    dica: "Sem ele, o ACS não busca a cópia do Wi-Fi nem avisa as atualizações: WIFI_BACKUP_ALLOW=<IP do ACS> no .env do portal." });
  const lista = olts.listar().filter((o) => o.ativo); // consulta desligada não conta
  if (lista.length) {
    const r = oltcoleta.resumo();
    const ruins = lista.filter((o) => { const c = r.coletas[o.id]; return !c || !c.ok || idade(c.em) > Math.max(30, (r.intervaloTipo[o.tipo] || o.intervaloMin || r.intervaloMin) * 3); });
    out.push({ grupo: g, nome: "Coleta das OLTs", nivel: ruins.length ? "warn" : "ok",
      detalhe: ruins.length ? `${ruins.length} de ${lista.length} sem leitura recente: ${ruins.map((o) => o.descricao).join(", ")}` : `${lista.length} OLT(s) lidas, ${r.onus} ONUs`,
      dica: ruins.length ? "Veja o erro de cada uma na página OLTs (botão Testar)." : "" });
  }
}

async function conferir() {
  const out = [];
  for (const f of [servidor, genieacs, atualizador, integracoes]) {
    try { await f(out); } catch (e) { out.push({ grupo: "Conferência", nome: f.name, nivel: "warn", detalhe: `não consegui conferir: ${e.message}`, dica: "" }); }
  }
  const conta = { ok: 0, warn: 0, bad: 0, info: 0 };
  for (const i of out) conta[i.nivel]++;
  return { em: new Date().toISOString(), itens: out, conta };
}

module.exports = { conferir };
