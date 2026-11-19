#!/usr/bin/env node
"use strict";
// Backup do GenieACS (e dos dados do portal) para FTP/FTPS/SFTP, com restauração.
// Roda como root no servidor do GenieACS (Node 18+, docker, curl, openssl, tar).
//
//   node genieacs-backup.js backup [manual]   faz um backup agora (usado pelo timer diário)
//   node genieacs-backup.js list              lista os backups (destino e locais)
//   node genieacs-backup.js serve             API para o portal (porta BACKUP_PORTA, token no cabeçalho)
//
// Cada backup é um arquivo genieacs-backup-AAAA-MM-DD_HHMM[-tipo].tar.enc, criptografado (AES-256)
// com a senha de /etc/genieacs-backup/senha. Conteúdo: genieacs.archive.gz (mongodump), sistema.tar.gz
// (/opt/genieacs, serviços, firewall, nginx, rede) e portal.json (dados do portal: Wi-Fi, firmwares, fotos, usuários).
// Configuração: /etc/genieacs-backup/backup.env (veja backup.env.example).

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");

const CONF_DIR = process.env.BACKUP_CONF_DIR || "/etc/genieacs-backup";
const LOCAL_DIR = "/var/lib/genieacs-backup";
const TMP_DIR = path.join(LOCAL_DIR, "tmp");
const NAME_RE = /^genieacs-backup-(\d{4}-\d{2}-\d{2})_(\d{4})(-[a-z-]+)?\.tar\.enc$/;
const SISTEMA = [
  "opt/genieacs", "etc/systemd/system", "usr/local/sbin/genieacs-firewall.sh", "etc/nginx/sites-available",
  "etc/nginx/ssl", "etc/tmpfiles.d/mongodb-thp.conf", "etc/network/interfaces", "etc/genieacs-backup/backup.env",
];
const CONFIG_COLLECTIONS = ["provisions", "presets", "virtualParameters", "config", "permissions", "users", "fs.files", "fs.chunks"];
const SERVICES = ["genieacs-cwmp", "genieacs-nbi", "genieacs-fs", "genieacs-ui"];

// ---------- configuração ----------
function loadConf() {
  const env = {};
  const file = path.join(CONF_DIR, "backup.env");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  const n = (k, d) => (env[k] === undefined || env[k] === "" ? d : Number(env[k]));
  let url = env.DESTINO_URL || "";
  if (url && !url.endsWith("/")) url += "/";
  return {
    url,
    user: env.DESTINO_USUARIO || "",
    pass: env.DESTINO_SENHA || "",
    tls: env.FTP_TLS === "1",
    key: env.DESTINO_CHAVE || "",
    diarios: n("MANTER_DIARIOS", 14),
    semanais: n("MANTER_SEMANAIS", 8),
    locais: n("MANTER_LOCAIS", 3),
    portal: (env.PORTAL_URL || "").replace(/\/+$/, ""),
    token: env.TOKEN || "",
    porta: n("BACKUP_PORTA", 7570),
    senhaFile: path.join(CONF_DIR, "senha"),
  };
}

// ---------- utilitários ----------
function run(cmd, args, { input, inputFile, outputFile, timeout = 30 * 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", outputFile ? "pipe" : "pipe", "pipe"] });
    let out = Buffer.alloc(0);
    let err = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), timeout);
    // Com arquivo de saída, só termina depois que o arquivo foi todo gravado
    const written = outputFile ? new Promise((ok, ko) => { const ws = fs.createWriteStream(outputFile, { mode: 0o600 }); ws.on("finish", ok); ws.on("error", ko); p.stdout.pipe(ws); }) : Promise.resolve();
    if (!outputFile) p.stdout.on("data", (c) => (out = Buffer.concat([out, c])));
    p.stderr.on("data", (c) => (err += c));
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) written.then(() => resolve(out.toString("utf8")), reject);
      else reject(new Error(`${path.basename(cmd)} saiu com ${code}: ${err.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`));
    });
    if (inputFile) fs.createReadStream(inputFile).pipe(p.stdin);
    else p.stdin.end(input === undefined ? "" : input);
  });
}

const stamp = () => {
  const d = new Date(Date.now() - 3 * 3600000); // horário de Brasília
  return d.toISOString().slice(0, 16).replace("T", "_").replace(":", "");
};
function tmpDir(prefix) {
  fs.mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(TMP_DIR, prefix));
}
const log = (...a) => console.log(new Date().toISOString(), ...a);

// curl com usuário/senha passados por stdin (-K -), para não aparecerem na lista de processos
function curlArgs(conf, extra) {
  const a = ["-sS", "--fail", "--connect-timeout", "20", "-K", "-"];
  if (conf.tls) a.push("--ssl-reqd");
  if (conf.key) a.push("--key", conf.key);
  if (conf.url.startsWith("sftp://")) a.push("--insecure"); // chave do servidor SFTP não é verificada pelo curl
  return a.concat(extra);
}
function curlConf(conf) {
  if (!conf.user) return "";
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `user = "${esc(conf.user)}:${esc(conf.pass)}"\n`;
}
const curl = (conf, extra, opts = {}) => run("curl", curlArgs(conf, extra), { input: curlConf(conf), ...opts });

async function remoteList(conf) {
  if (!conf.url) return [];
  const out = await curl(conf, ["--list-only", conf.url], { timeout: 60000 });
  return out.split(/\r?\n/).map((s) => s.trim().split("/").pop()).filter((n) => NAME_RE.test(n));
}

async function remoteDelete(conf, name) {
  if (conf.url.startsWith("sftp://")) {
    const p = new URL(conf.url).pathname;
    return curl(conf, ["-Q", `-rm ${p}${name}`, conf.url, "-o", "/dev/null"], { timeout: 60000 });
  }
  return curl(conf, ["-Q", `-DELE ${name}`, conf.url, "-o", "/dev/null"], { timeout: 60000 });
}

function localList() {
  fs.mkdirSync(LOCAL_DIR, { recursive: true, mode: 0o700 });
  return fs.readdirSync(LOCAL_DIR).filter((n) => NAME_RE.test(n));
}

// Quais apagar: mantém os N mais recentes + 1 por semana (domingo, ou o mais novo da semana) até M semanas
function toDelete(names, diarios, semanais) {
  const sorted = [...names].sort().reverse();
  const keep = new Set(sorted.slice(0, diarios));
  const weeks = new Set();
  for (const n of sorted) {
    if (weeks.size >= semanais) break;
    const d = new Date(NAME_RE.exec(n)[1] + "T12:00:00Z");
    const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
    if (!weeks.has(monday)) { weeks.add(monday); keep.add(n); }
  }
  return sorted.filter((n) => !keep.has(n));
}

async function portalData(conf) {
  if (!conf.portal || !conf.token) return null;
  const r = await fetch(`${conf.portal}/internal/backup/portal-data`, { headers: { "X-Backup-Token": conf.token }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`portal respondeu HTTP ${r.status}`);
  return r.json();
}

let busy = null;
async function exclusive(what, fn) {
  if (busy) throw Object.assign(new Error(`Aguarde: ${busy} em andamento.`), { status: 409 });
  busy = what;
  try { return await fn(); } finally { busy = null; }
}

// ---------- backup ----------
async function backup(tipo = "") {
  const conf = loadConf();
  if (!fs.existsSync(conf.senhaFile)) throw new Error(`falta a senha de criptografia em ${conf.senhaFile}`);
  const name = `genieacs-backup-${stamp()}${tipo ? "-" + tipo : ""}.tar.enc`;
  const work = tmpDir("b-");
  const avisos = [];
  try {
    await run("docker", ["exec", "mongodb", "mongodump", "--quiet", "--db", "genieacs", "--gzip", "--archive"], { outputFile: path.join(work, "genieacs.archive.gz") });
    const exist = SISTEMA.filter((p) => fs.existsSync("/" + p));
    await run("tar", ["czf", path.join(work, "sistema.tar.gz"), "-C", "/", ...exist]);
    try {
      const pd = await portalData(conf);
      if (pd) fs.writeFileSync(path.join(work, "portal.json"), JSON.stringify(pd), { mode: 0o600 });
      else avisos.push("dados do portal não incluídos (PORTAL_URL/TOKEN não configurados)");
    } catch (e) { avisos.push(`dados do portal não incluídos: ${e.message}`); }
    const counts = await run("docker", ["exec", "mongodb", "mongo", "--quiet", "genieacs", "--eval",
      "print(JSON.stringify({devices:db.devices.countDocuments({}),provisions:db.provisions.countDocuments({}),presets:db.presets.countDocuments({}),files:db['fs.files'].countDocuments({})}))"]);
    fs.writeFileSync(path.join(work, "manifest.json"), JSON.stringify({
      criado: new Date().toISOString(), tipo: tipo || "diario", host: os.hostname(), contagem: JSON.parse(counts.trim()), avisos,
    }, null, 1));

    const tarFile = path.join(work, "backup.tar");
    await run("tar", ["cf", tarFile, "-C", work, ...fs.readdirSync(work).filter((f) => f !== "backup.tar")]);
    const out = path.join(LOCAL_DIR, name);
    await run("openssl", ["enc", "-aes-256-cbc", "-pbkdf2", "-iter", "200000", "-salt", "-in", tarFile, "-out", out, "-pass", `file:${conf.senhaFile}`]);
    fs.chmodSync(out, 0o600);
    const size = fs.statSync(out).size;
    log(`backup ${name} criado (${(size / 1048576).toFixed(1)} MB)`);

    let enviado = false;
    if (conf.url) {
      try {
        await curl(conf, ["--ftp-create-dirs", "-T", out, conf.url + name], { timeout: 30 * 60000 });
        enviado = true;
        log(`enviado para ${conf.url.replace(/\/\/[^/@]*@/, "//")}`);
        const apagar = toDelete(await remoteList(conf), conf.diarios, conf.semanais);
        for (const n of apagar) { await remoteDelete(conf, n).catch((e) => avisos.push(`não apagou ${n}: ${e.message}`)); log(`destino: apagado antigo ${n}`); }
      } catch (e) { avisos.push(`envio falhou: ${e.message}`); log(`ERRO no envio: ${e.message}`); }
    } else avisos.push("DESTINO_URL não configurado: backup ficou só neste servidor");

    for (const n of localList().sort().reverse().slice(conf.locais)) fs.unlinkSync(path.join(LOCAL_DIR, n));
    for (const a of avisos) log(`AVISO: ${a}`);
    return { name, size, enviado, avisos };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function list() {
  const conf = loadConf();
  const local = localList();
  let remoto = [];
  let erro = "";
  try { remoto = await remoteList(conf); } catch (e) { erro = e.message; }
  const all = [...new Set([...local, ...remoto])].sort().reverse();
  return {
    destino: conf.url ? conf.url.replace(/\/\/[^/@]*@/, "//") : "",
    erroDestino: erro,
    backups: all.map((n) => {
      const m = NAME_RE.exec(n);
      return {
        name: n, data: `${m[1]} ${m[2].slice(0, 2)}:${m[2].slice(2)}`, tipo: (m[3] || "-diario").slice(1),
        local: local.includes(n), remoto: remoto.includes(n),
        size: local.includes(n) ? fs.statSync(path.join(LOCAL_DIR, n)).size : null,
      };
    }),
  };
}

// ---------- restauração ----------
async function fetchAndOpen(conf, name, work) {
  if (!NAME_RE.test(name)) throw Object.assign(new Error("nome de backup inválido"), { status: 400 });
  let enc = path.join(LOCAL_DIR, name);
  if (!fs.existsSync(enc)) {
    if (!conf.url) throw Object.assign(new Error("backup não encontrado"), { status: 404 });
    enc = path.join(work, name);
    await curl(conf, ["-o", enc, conf.url + name], { timeout: 30 * 60000 });
  }
  const tarFile = path.join(work, "backup.tar");
  await run("openssl", ["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "200000", "-in", enc, "-out", tarFile, "-pass", `file:${conf.senhaFile}`]);
  await run("tar", ["xf", tarFile, "-C", work]);
  return work;
}

const mongorestore = (archive, args) =>
  run("docker", ["exec", "-i", "mongodb", "mongorestore", "--quiet", "--gzip", "--archive", ...args], { inputFile: archive });

async function restore({ name, escopo, aparelho }) {
  const conf = loadConf();
  const work = tmpDir("r-");
  try {
    await fetchAndOpen(conf, name, work);
    const manifest = JSON.parse(fs.readFileSync(path.join(work, "manifest.json"), "utf8"));
    const archive = path.join(work, "genieacs.archive.gz");

    if (escopo === "portal") {
      const f = path.join(work, "portal.json");
      if (!fs.existsSync(f)) throw new Error("este backup não tem os dados do portal");
      log(`restauração: dados do portal entregues de ${name}`);
      return { escopo, manifest, portal: JSON.parse(fs.readFileSync(f, "utf8")) };
    }

    // Antes de mexer no banco, guarda o estado atual
    const antes = await backup("pre-restauracao");

    if (escopo === "aparelho") {
      const id = String(aparelho || "").trim();
      if (!id) throw Object.assign(new Error("informe o aparelho"), { status: 400 });
      await mongorestore(archive, ["--nsInclude", "genieacs.devices", "--nsFrom", "genieacs.*", "--nsTo", "restauracao_tmp.*", "--drop"]);
      const r = await run("docker", ["exec", "mongodb", "mongo", "--quiet", "--eval", `
        const d = db.getSiblingDB("restauracao_tmp").devices.findOne({_id: ${JSON.stringify(id)}});
        if (d) db.getSiblingDB("genieacs").devices.replaceOne({_id: d._id}, d, {upsert: true});
        db.getSiblingDB("restauracao_tmp").dropDatabase();
        print(d ? "ok" : "nao-achou");`]);
      if (r.trim() !== "ok") throw Object.assign(new Error(`o aparelho ${id} não está nesse backup`), { status: 404 });
      log(`restauração: aparelho ${id} de ${name}`);
      return { escopo, aparelho: id, manifest, antes: antes.name };
    }

    if (escopo === "config") {
      await mongorestore(archive, ["--drop", ...CONFIG_COLLECTIONS.flatMap((c) => ["--nsInclude", `genieacs.${c}`])]);
    } else if (escopo === "tudo") {
      await mongorestore(archive, ["--drop", "--nsInclude", "genieacs.*"]);
    } else {
      throw Object.assign(new Error("escopo inválido"), { status: 400 });
    }
    await run("systemctl", ["restart", ...SERVICES]);
    log(`restauração: ${escopo} de ${name}; serviços reiniciados`);
    return { escopo, manifest, antes: antes.name };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ---------- Histórico de quedas e reinícios (lido do log do GenieACS) ----------
// Para cada Inform com "1 BOOT" ou "0 BOOTSTRAP" guarda: quando, eventos, quanto tempo ficou sem contato e o tipo:
//   acs     = reinício pedido pelo ACS ("M Reboot": portal ou reboot periódico)
//   religou = o equipamento desligou e religou (falta de energia, tomada, botão ou travamento)
//   rede    = só "0 BOOTSTRAP": continuou ligado, mas a fibra/OLT caiu e voltou (ou reset/troca de ACS)
const ACCESS_LOG = process.env.CWMP_ACCESS_LOG || "/var/log/genieacs/genieacs-cwmp-access.log";
const EV_DIR = "/var/lib/genieacs-eventos";
const EV_FILE = path.join(EV_DIR, "eventos.json");
const EV_DIAS = 45;
const INFORM_RE = /^(\S+) \[\w+\] \S+ (\S+): Inform; cpeRequestId="[^"]*" informEvent="([^"]*)"/;
let ev = null;

function evLoad() {
  if (ev) return ev;
  try { ev = JSON.parse(fs.readFileSync(EV_FILE, "utf8")); } catch { ev = { ino: 0, offset: 0, ultimo: {}, eventos: {} }; }
  return ev;
}
function evSave() {
  fs.mkdirSync(EV_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(EV_FILE + ".tmp", JSON.stringify(ev));
  fs.renameSync(EV_FILE + ".tmp", EV_FILE);
}
function tipoEvento(e) {
  if (/M Reboot/.test(e)) return "acs";
  if (/1 BOOT/.test(e)) return "religou";
  return "rede";
}

// Lê só o que foi acrescentado ao log desde a última vez (aguenta rotação por cópia/truncamento)
function coletarEventos() {
  evLoad();
  let st;
  try { st = fs.statSync(ACCESS_LOG); } catch { return 0; }
  if (st.ino !== ev.ino || st.size < ev.offset) { ev.ino = st.ino; ev.offset = 0; }
  if (st.size === ev.offset) return 0;
  const fd = fs.openSync(ACCESS_LOG, "r");
  let novos = 0;
  try {
    const CH = 4 * 1024 * 1024;
    let resto = "";
    let pos = ev.offset;
    while (pos < st.size) {
      const buf = Buffer.alloc(Math.min(CH, st.size - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      pos += n;
      const txt = resto + buf.toString("utf8", 0, n);
      const linhas = txt.split("\n");
      resto = linhas.pop(); // linha incompleta: fica para a próxima leitura
      for (const l of linhas) {
        const m = INFORM_RE.exec(l);
        if (!m) continue;
        const [, ts, id, eventos] = m;
        if (/1 BOOT|0 BOOTSTRAP/.test(eventos)) {
          const lista = (ev.eventos[id] = ev.eventos[id] || []);
          const tipo = tipoEvento(eventos);
          const ult = lista[lista.length - 1];
          // O equipamento repete o Inform de boot se a sessão falhar: conta uma vez só (janela de 10 min)
          if (!(ult && ult.tipo === tipo && Date.parse(ts) - Date.parse(ult.ts) < 600000)) {
            const antes = ev.ultimo[id];
            lista.push({ ts, eventos, tipo, semContatoMin: antes ? Math.round((Date.parse(ts) - Date.parse(antes)) / 60000) : null });
            novos++;
          }
        }
        ev.ultimo[id] = ts;
      }
    }
    ev.offset = pos - Buffer.byteLength(resto);
  } finally {
    fs.closeSync(fd);
  }
  const limite = Date.now() - EV_DIAS * 86400000;
  for (const id of Object.keys(ev.eventos)) {
    ev.eventos[id] = ev.eventos[id].filter((x) => Date.parse(x.ts) >= limite);
    if (!ev.eventos[id].length) delete ev.eventos[id];
  }
  evSave();
  return novos;
}

// Vários equipamentos voltando quase juntos = evento regional (energia do bairro, OLT, fibra)
function eventosRegionais(dias = 7, janelaMin = 10, minimo = 3) {
  evLoad();
  const desde = Date.now() - dias * 86400000;
  const todos = [];
  for (const [id, lista] of Object.entries(ev.eventos)) {
    for (const x of lista) if (x.tipo !== "acs" && Date.parse(x.ts) >= desde) todos.push({ id, ...x, t: Date.parse(x.ts) });
  }
  todos.sort((a, b) => a.t - b.t);
  const grupos = [];
  for (const x of todos) {
    const g = grupos[grupos.length - 1];
    if (g && x.t - g.fim <= janelaMin * 60000) { g.itens.push(x); g.fim = x.t; } else grupos.push({ inicio: x.t, fim: x.t, itens: [x] });
  }
  return grupos.filter((g) => new Set(g.itens.map((x) => x.id)).size >= minimo).map((g) => ({
    inicio: new Date(g.inicio).toISOString(), fim: new Date(g.fim).toISOString(),
    aparelhos: new Set(g.itens.map((x) => x.id)).size,
    religaram: new Set(g.itens.filter((x) => x.tipo === "religou").map((x) => x.id)).size,
    soRede: new Set(g.itens.filter((x) => x.tipo === "rede").map((x) => x.id)).size,
    ids: [...new Set(g.itens.map((x) => x.id))],
  })).reverse();
}

// ---------- API para o portal ----------
function serve() {
  // Coletor de eventos: lê o log agora e a cada minuto
  try { log(`eventos: ${coletarEventos()} novo(s) no log`); } catch (e) { log(`eventos: ERRO ${e.message}`); }
  setInterval(() => { try { coletarEventos(); } catch (e) { log(`eventos: ERRO ${e.message}`); } }, 60000);
  const conf = loadConf();
  if (!conf.token || conf.token.length < 32) throw new Error("TOKEN ausente ou curto em backup.env");
  const tokenBuf = Buffer.from(conf.token);
  const send = (res, status, obj) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
  http.createServer(async (req, res) => {
    try {
      const t = Buffer.from(String(req.headers["x-backup-token"] || ""));
      if (t.length !== tokenBuf.length || !crypto.timingSafeEqual(t, tokenBuf)) return send(res, 401, { error: "não autorizado" });
      let body = "";
      for await (const c of req) { body += c; if (body.length > 10000) return send(res, 413, { error: "corpo grande" }); }
      const data = body ? JSON.parse(body) : {};
      const { pathname } = new URL(req.url, "http://x");
      if (req.method === "GET" && pathname === "/backups") return send(res, 200, { ...(await list()), ocupado: busy });
      if (req.method === "POST" && pathname === "/backups") return send(res, 200, await exclusive("backup", () => backup("manual")));
      if (req.method === "POST" && pathname === "/restaurar") return send(res, 200, await exclusive("restauração", () => restore(data)));
      if (req.method === "GET" && pathname === "/eventos/regionais") {
        const q = new URL(req.url, "http://x").searchParams;
        return send(res, 200, { regionais: eventosRegionais(Number(q.get("dias")) || 7) });
      }
      const me = pathname.match(/^\/eventos\/(.+)$/);
      if (req.method === "GET" && me) {
        const id = decodeURIComponent(me[1]);
        return send(res, 200, { id, eventos: (evLoad().eventos[id] || []).slice().reverse(), desde: EV_DIAS });
      }
      send(res, 404, { error: "rota não encontrada" });
    } catch (e) {
      log(`ERRO API: ${e.message}`);
      send(res, e.status || 500, { error: e.message });
    }
  }).listen(conf.porta, () => log(`API de backup na porta ${conf.porta}`));
}

// ---------- linha de comando ----------
const [cmd, arg] = process.argv.slice(2);
(async () => {
  if (cmd === "backup") {
    const r = await exclusive("backup", () => backup(arg === "manual" ? "manual" : ""));
    if (r.avisos.length) process.exitCode = r.enviado ? 0 : 2;
  } else if (cmd === "list") {
    const l = await list();
    console.log(`destino: ${l.destino || "(não configurado)"}${l.erroDestino ? "  ERRO: " + l.erroDestino : ""}`);
    for (const b of l.backups) console.log(`${b.data}  ${b.tipo.padEnd(16)} ${b.local ? "local " : "      "}${b.remoto ? "destino" : ""}  ${b.name}`);
  } else if (cmd === "serve") {
    serve();
  } else {
    console.log("uso: genieacs-backup.js backup [manual] | list | serve");
    process.exitCode = 1;
  }
})().catch((e) => { console.error(new Date().toISOString(), "ERRO:", e.message); process.exit(1); });
