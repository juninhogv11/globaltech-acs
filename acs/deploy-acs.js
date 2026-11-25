#!/usr/bin/env node
"use strict";
// Publica provisions, presets e virtual parameters no GenieACS pela API NBI,
// preenchendo os {{VARIAVEIS}} com os valores de acs.env (que não vai para o Git).
//
//   node deploy-acs.js --dry-run            mostra o que mudaria, não grava nada
//   node deploy-acs.js                      faz backup do servidor e publica
//   node deploy-acs.js --only provisions    só um tipo (provisions | presets | virtual_parameters)
//   node deploy-acs.js --install-ext        também copia as extensões para GENIEACS_EXT_DIR (rodar no servidor do ACS, como root)
//   node deploy-acs.js --backup-dir <pasta> a cópia de segurança vai para <pasta>/<data> (padrão: acs/backups)
//   node deploy-acs.js --restaurar <pasta>  volta provisions, presets e virtual parameters ao que está na cópia <pasta>
//                                           (usado pelo atualizador quando uma atualização falha no meio)
//
// Requer Node.js 18+.

const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const ONLY = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const INSTALL_EXT = args.includes("--install-ext");
const arg = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const BACKUP_DIR = arg("--backup-dir") || path.join(DIR, "backups");
const RESTAURAR = arg("--restaurar");

function loadEnv(file) {
  if (!fs.existsSync(file)) {
    console.error(`Falta ${file}. Copie acs.env.example para acs.env e preencha.`);
    process.exit(1);
  }
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

// Restaurar não precisa do acs.env: a cópia já tem as variáveis preenchidas (NBI_URL vem do ambiente ou o padrão)
const env = RESTAURAR ? { NBI_URL: process.env.NBI_URL } : loadEnv(path.join(DIR, "acs.env"));
const NBI = (env.NBI_URL || "http://127.0.0.1:7557").replace(/\/+$/, "");

// Substitui {{VAR}}; para se faltar alguma variável (evita publicar provision com "{{CR_PASS}}")
function fill(text, name) {
  return text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, k) => {
    if (env[k] === undefined || env[k] === "") {
      console.error(`Variável ${k} usada em ${name} não está definida em acs.env`);
      process.exit(1);
    }
    // Vai dentro de string JS entre aspas duplas
    return env[k].replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  });
}

async function nbi(method, p, body, type) {
  const r = await fetch(NBI + p, { method, body, headers: body !== undefined ? { "Content-Type": type } : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p}: HTTP ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

function items(kind) {
  const d = path.join(DIR, kind);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => !f.startsWith(".")).sort().map((f) => {
    let text = fs.readFileSync(path.join(d, f), "utf8").replace(/\r\n/g, "\n");
    let id = f.replace(/\.(js|json)$/, "");
    // Virtual parameters com espaço no nome guardam o _id real na primeira linha
    const m = text.match(/^\/\/ _id: (.+)\n/);
    if (m) {
      id = m[1].trim();
      text = text.slice(m[0].length);
    }
    return { id, file: f, text };
  });
}

// Volta ao conteúdo de uma cópia de segurança: regrava só o que mudou (itens criados depois da cópia ficam)
async function restaurar(bdir) {
  let n = 0;
  for (const k of ["provisions", "virtual_parameters", "presets"]) {
    const f = path.join(bdir, `${k}.json`);
    if (!fs.existsSync(f)) continue;
    const atual = new Map(((await nbi("GET", `/${k}/`)) || []).map((x) => [x._id, x]));
    for (const it of JSON.parse(fs.readFileSync(f, "utf8"))) {
      const { _id, ...resto } = it;
      const old = atual.get(_id);
      const body = k === "presets" ? JSON.stringify(resto) : it.script;
      const same = old && (k === "presets"
        ? JSON.stringify(Object.fromEntries(Object.keys(resto).map((x) => [x, old[x]]))) === body
        : old.script === it.script);
      if (same) continue;
      console.log(`restaurar  ${k}/${_id}`);
      if (!DRY) await nbi("PUT", `/${k}/${encodeURIComponent(_id)}`, body, k === "presets" ? "application/json" : "text/plain; charset=utf-8");
      n++;
    }
  }
  console.log(n ? `${n} item(ns) ${DRY ? "seriam restaurados" : "restaurados"} de ${bdir}.` : "Nada a restaurar: o servidor já está igual à cópia.");
}

(async () => {
  if (RESTAURAR) return restaurar(RESTAURAR);
  const kinds = ["provisions", "virtual_parameters", "presets"].filter((k) => !ONLY || ONLY === k);
  console.log(`NBI: ${NBI}${DRY ? "  (simulação, nada será gravado)" : ""}`);

  // Backup do que está no servidor antes de qualquer alteração
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bdir = path.join(BACKUP_DIR, stamp);
  const current = {};
  for (const k of kinds) current[k] = await nbi("GET", `/${k}/`);
  if (!DRY) {
    fs.mkdirSync(bdir, { recursive: true, mode: 0o700 });
    for (const k of kinds) fs.writeFileSync(path.join(bdir, `${k}.json`), JSON.stringify(current[k], null, 2), { mode: 0o600 });
    console.log(`Backup do servidor: ${bdir}`);
  }

  let changed = 0;
  for (const k of kinds) {
    const byId = new Map((current[k] || []).map((x) => [x._id, x]));
    for (const it of items(k)) {
      const body = fill(it.text, `${k}/${it.file}`);
      const old = byId.get(it.id);
      let same;
      if (k === "presets") {
        const want = JSON.parse(body);
        const have = old ? Object.fromEntries(Object.keys(want).map((x) => [x, old[x]])) : null;
        same = have && JSON.stringify(have) === JSON.stringify(want);
      } else {
        same = old && String(old.script).replace(/\r\n/g, "\n").trim() === body.trim();
      }
      if (same) continue;
      changed++;
      console.log(`${old ? "atualizar" : "criar   "}  ${k}/${it.id}`);
      if (!DRY) {
        await nbi("PUT", `/${k}/${encodeURIComponent(it.id)}`, body, k === "presets" ? "application/json" : "text/plain; charset=utf-8");
      }
    }
  }
  console.log(changed ? `${changed} item(ns) ${DRY ? "seriam alterados" : "publicados"}.` : "Nada mudou: o servidor já está igual ao repositório.");

  if (INSTALL_EXT) {
    const extDir = env.GENIEACS_EXT_DIR || "/opt/genieacs/ext";
    for (const f of fs.readdirSync(path.join(DIR, "ext"))) {
      const dst = path.join(extDir, f);
      const src = fs.readFileSync(path.join(DIR, "ext", f), "utf8").replace(/\r\n/g, "\n");
      if (fs.existsSync(dst) && fs.readFileSync(dst, "utf8") === src) continue;
      console.log(`extensão ${DRY ? "seria copiada" : "copiada"}: ${dst}`);
      if (!DRY) {
        if (fs.existsSync(dst)) fs.copyFileSync(dst, `${dst}.bak-${stamp}`);
        fs.writeFileSync(dst, src, { mode: 0o644 });
      }
    }
    if (!DRY) console.log("Ajuste o dono (chown genieacs:genieacs) e reinicie: systemctl restart genieacs-cwmp");
  }
})().catch((e) => {
  console.error("ERRO:", e.message);
  process.exit(1);
});
