"use strict";

// ---------- Utilitários ----------
const $ = (s, r = document) => r.querySelector(s);
const view = $("#view");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const enc = encodeURIComponent;
let charts = [];
let pageTimer = null;

// Comandos (POST/DELETE) mostram o quadro "carregando" no centro da tela.
// opts.loading: texto do quadro; false = não mostrar (ex.: sair, tarefas em segundo plano)
async function api(path, opts = {}) {
  const busy = opts.method && opts.method !== "GET" && opts.loading !== false;
  if (busy) showLoading(opts.loading || "Enviando comando ao equipamento…");
  try {
    const res = await fetch("/api" + path, {
      method: opts.method || "GET",
      headers: { "X-Requested-With": "portal", ...(opts.body ? { "Content-Type": "application/json" } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) {
      location.href = "/login.html";
      throw new Error("Sessão expirada");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  } finally {
    if (busy) hideLoading();
  }
}

// ---------- Quadro central: carregando / resultado ----------
let loadingCount = 0;
let loadingTimer = null;

function showLoading(msg) {
  loadingCount++;
  $("#overlay-msg").textContent = msg;
  $("#overlay-icon").className = "ov-spinner";
  clearTimeout(loadingTimer);
  const o = $("#overlay");
  o.hidden = false;
  o.classList.add("show");
}

function hideLoading() {
  loadingCount = Math.max(0, loadingCount - 1);
  if (loadingCount === 0 && $("#overlay-icon").className === "ov-spinner") closeOverlay();
}

function closeOverlay() {
  const o = $("#overlay");
  o.classList.remove("show");
  clearTimeout(loadingTimer);
  loadingTimer = setTimeout(() => (o.hidden = true), 200);
}

// Resultado no centro da tela, com ícone animado; some sozinho (clique fecha antes)
function toast(msg, isErr = false) {
  clearTimeout(loadingTimer);
  const o = $("#overlay");
  $("#overlay-msg").textContent = msg;
  $("#overlay-icon").className = isErr ? "ov-err" : "ov-ok";
  o.hidden = false;
  o.classList.add("show");
  loadingTimer = setTimeout(closeOverlay, isErr ? 4500 : 2500);
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR") : "—");

function timeAgo(iso) {
  if (!iso) return "nunca";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `há ${s}s`;
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} dias`;
}

const SIGNAL_LABEL = { good: "Bom", warn: "Atenção", bad: "Crítico", none: "Sem leitura" };
const COLORS = { good: "#14a05a", warn: "#e8890c", bad: "#e03a3a", none: "#9aa3b2" };
const PALETTE = ["#2b6bff", "#12a35b", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#64748b"];

const statusBadge = (d) =>
  d.online ? `<span class="badge good"><span class="dot"></span>Online</span>` : `<span class="badge bad"><span class="dot"></span>Offline</span>`;

// Nome do sistema de gestão de clientes (SGP, Hubsoft...), vem de /api/me. As tags continuam SGP_*/ERRO_SGP.
let SISTEMA = "SGP";

// Situação do provisionamento IPoE (tags Provisioned / ERRO_SGP)
const PROV_ICONS = {
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/></svg>',
  err: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 7v6M12 17h.01"/></svg>',
  wait: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 7v5l3 2"/></svg>',
};
const STATUS_TAGS = ["Provisioned", "ERRO_SGP"];
// Tags que o portal mostra de outra forma (ícone de provisionamento, código do cliente)
const isHiddenTag = (t) => STATUS_TAGS.includes(t) || /^SGP_(CLIENTE|CONTRATO)_/.test(t);
function provState(d) {
  if (d.tags.includes("Provisioned")) return ["ok", "Provisionado"];
  if (d.tags.includes("ERRO_SGP")) return ["err", `Erro no ${SISTEMA}`];
  return ["wait", "Aguardando"];
}
const provIcon = (d) => { const [k, label] = provState(d); return `<span class="prov ${k}" title="${label}">${PROV_ICONS[k]}</span>`; };
const provBadge = (d) => { const [k, label] = provState(d); return `<span class="prov-badge ${k}">${PROV_ICONS[k]}${label}</span>`; };

const signalBadge = (d) =>
  d.rx === null ? `<span class="muted">—</span>` : `<span class="badge ${d.signal}">${d.rx.toFixed(1)} dBm</span>`;

const tagList = (tags, removable = false) =>
  tags.map((t) => `<span class="tag ${t === "ERRO_SGP" ? "err" : ""}">${esc(t)}${removable ? `<button data-untag="${esc(t)}" title="Remover tag">×</button>` : ""}</span>`).join("");


const ICONS = {
  devices: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  online: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0M12 20h.01"/></svg>',
  offline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  faults: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>',
};

// ---------- Páginas ----------
async function pageDashboard() {
  const s = await api("/summary");
  $("#updated").textContent = "Atualizado " + new Date(s.updatedAt).toLocaleTimeString("pt-BR");
  view.innerHTML = `
    <div class="page-head"><h1>Monitoramento da rede</h1></div>
    <div class="stats">
      <a class="stat blue" href="#/devices"><div><small>Total de dispositivos</small><b>${s.total}</b></div>${ICONS.devices}</a>
      <a class="stat green" href="#/devices?f=online"><div><small>Online</small><b>${s.online}</b></div>${ICONS.online}</a>
      <a class="stat orange" href="#/devices?f=offline"><div><small>Offline</small><b>${s.offline}</b></div>${ICONS.offline}</a>
      <a class="stat red" href="#/faults"><div><small>Falhas ativas</small><b>${s.faults}</b></div>${ICONS.faults}</a>
    </div>
    <div id="regionais"></div>
    <div id="olts-painel"></div>
    <div class="card" id="olt-graf-card" style="margin-bottom:20px">
      <div class="card-head"><h2>Clientes nas OLTs (24 h)</h2><span class="muted" id="olt-graf-info"></span></div>
      <div class="chart-box tall"><canvas id="c-olt-totais"></canvas></div>
      <div class="olt-legenda" id="olt-graf-leg"></div>
    </div>
    <div class="grid-3">
      <div class="card"><h2>Novos nas últimas 24 h</h2><div class="big-number">${s.registered.day}</div><span class="muted">dispositivos registrados no ACS</span>
        ${s.registered.day ? `<div><a href="#/devices?f=novos24">ver lista ›</a></div>` : ""}</div>
      <div class="card"><h2>Novos em 7 dias</h2><div class="big-number">${s.registered.week}</div><span class="muted">dispositivos registrados no ACS</span>
        ${s.registered.week ? `<div><a href="#/devices?f=novos7">ver lista ›</a></div>` : ""}</div>
      <div class="card"><h2>Provisionamento</h2><div class="big-number">${s.tags.provisioned}<span class="muted" style="font-size:16px"> / ${s.total}</span></div>
        <a href="#/devices?f=erro_sgp">${s.tags.erroSgp} com ERRO_SGP</a></div>
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h2>Piores sinais</h2><a href="#/devices?f=signal">ver todos</a></div>
        ${s.worstSignal.length ? `<div class="table-wrap"><table><thead><tr><th>Cliente</th><th>Modelo</th><th>RX</th><th>Status</th></tr></thead><tbody>
          ${s.worstSignal.map((d) => `<tr class="click" data-dev="${esc(d.id)}"><td>${d.sgpCliente ? `<b class="client-id">${esc(d.sgpCliente)}</b> ` : ""}${esc(d.ssid || d.serial)}</td><td>${esc(d.model)}</td><td>${signalBadge(d)}</td><td>${statusBadge(d)}</td></tr>`).join("")}
        </tbody></table></div>` : `<div class="empty">Nenhuma ONU com leitura de sinal ainda.</div>`}
      </div>
      <div class="card">
        <div class="card-head"><h2>Falhas recentes</h2><a href="#/faults">ver todas</a></div>
        ${s.recentFaults.length ? `<div class="table-wrap"><table><thead><tr><th>Dispositivo</th><th>Código</th><th>Quando</th></tr></thead><tbody>
          ${s.recentFaults.map((f) => `<tr class="click" data-dev="${esc(f.device)}"><td>${esc(f.deviceName || f.device)}</td><td><span class="badge bad">${esc(f.code)}</span></td><td>${timeAgo(f.timestamp)}</td></tr>`).join("")}
        </tbody></table></div>` : `<div class="empty">Nenhuma falha ativa. 🎉</div>`}
      </div>
    </div>`;

  loadOltTotais();
  loadRegionais();
  loadOltsPainel();

  pageTimer = setInterval(() => route(true), 60000);
}

// Gráfico "Clientes nas OLTs (24 h)": soma de todas as OLTs a cada coleta (online, sem energia, sem fibra, outros)
const OLT_SERIES = [
  { i: 1, nome: "Online", cor: "#14a05a", fill: true },
  { i: 2, nome: "Sem energia", cor: "#2b6bff", dica: "Power Fail / dying gasp" },
  { i: 3, nome: "Sem fibra", cor: "#e8890c", dica: "LOS" },
  { i: 4, nome: "Outros offline", cor: "#8a93a6", dica: "N/A" },
];
async function loadOltTotais() {
  let r;
  try { r = await api("/olts/totais?horas=24"); } catch { return; }
  const canvas = $("#c-olt-totais");
  if (!canvas) return;
  if (!r.pts.length) {
    $("#olt-graf-card .chart-box").outerHTML = `<div class="empty">O gráfico começa a ser preenchido na próxima leitura das OLTs (a cada 10 min).</div>`;
    return;
  }
  const ult = r.pts[r.pts.length - 1];
  $("#olt-graf-info").textContent = `${ult[5]} OLT(s) · ${ult[1] + ult[2] + ult[3] + ult[4]} ONUs · ${timeAgo(ult[0])}`;
  $("#olt-graf-leg").innerHTML = OLT_SERIES.map((x) => `<span title="${x.dica || ""}"><i style="background:${x.cor}"></i>${x.nome} <b>${ult[x.i]}</b></span>`).join("");
  const hora = (iso) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const ctx = canvas.getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.parentNode.clientHeight || 300);
  grad.addColorStop(0, "rgba(20,160,90,.35)");
  grad.addColorStop(1, "rgba(20,160,90,.02)");
  charts.push(new Chart(canvas, {
    type: "line",
    data: {
      labels: r.pts.map((p) => hora(p[0])),
      datasets: OLT_SERIES.map((x) => ({
        label: x.nome, data: r.pts.map((p) => p[x.i]), borderColor: x.cor, backgroundColor: x.fill ? grad : x.cor,
        fill: !!x.fill, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.25,
      })),
    },
    options: {
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: (it) => { const p = r.pts[it[0].dataIndex]; return new Date(p[0]).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) + ` · ${p[5]} OLT(s)`; } } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 9, maxRotation: 0 } },
        y: { beginAtZero: true, grid: { color: "rgba(120,130,150,.15)" }, ticks: { precision: 0 } },
      },
    },
  }));
}

// Quadro "OLTs" do dashboard: estado de cada OLT pela última coleta (ONUs online/offline, tempo ligada)
const OLT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01M11 7h6M11 17h6"/></svg>';
function fmtLigada(seg) {
  const d = Math.floor(seg / 86400), h = Math.floor((seg % 86400) / 3600), m = Math.floor((seg % 3600) / 60);
  const hm = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return d ? `${d} ${d === 1 ? "dia" : "dias"}, ${hm}` : hm;
}
async function loadOltsPainel() {
  let r;
  try { r = await api("/olts"); } catch { return; }
  const box = $("#olts-painel");
  if (!box || !r.olts.length) return;
  const coleta = r.coleta || {};
  const agora = Date.now();
  const linhas = r.olts.map((o) => {
    const c = (coleta.coletas || {})[o.id];
    // Sem resposta: última coleta com erro ou parada há mais de 3 intervalos
    const intervalo = Math.max(coleta.intervaloMin || 10, (c && c.via === "telnet" && (coleta.intervaloTipo || {})[o.tipo]) || 0);
    const atrasada = c && agora - Date.parse(c.em) > 3 * intervalo * 60000;
    const ok = !!(c && c.ok && !atrasada);
    const off = ok ? c.onus - c.online : 0;
    const pct = ok && c.onus ? off / c.onus : 0;
    const nivel = !ok ? "bad" : pct >= 0.25 ? "bad" : pct >= 0.1 ? "warn" : "good";
    const st = (coleta.status || {})[o.id] || {};
    const tempNivel = ok && st.temp != null ? st.nivel || "ok" : null;
    return { o, c, st, ok, off, nivel, tempNivel, nome: o.descricao };
  }).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR", { numeric: true }));
  const online = linhas.filter((x) => x.ok).length;
  const nWarn = linhas.filter((x) => x.nivel === "warn" || x.tempNivel === "warn").length;
  const nBad = linhas.filter((x) => x.nivel === "bad" || x.tempNivel === "bad").length;
  const totOnus = linhas.reduce((t, x) => t + (x.ok ? x.c.onus : 0), 0);
  const totOn = linhas.reduce((t, x) => t + (x.ok ? x.c.online : 0), 0);
  const detalhe = (x) => {
    if (!x.c) return `<span class="muted">ainda não lida</span>`;
    if (!x.ok) return `<span class="olt-err">${x.c.ok ? `sem leitura ${timeAgo(x.c.em)}` : esc(x.c.erro || "erro na leitura")}</span>`;
    // Tempo ligada: a leitura mais recente (SNMP na coleta ou leitura de status), somando o tempo desde então
    const fontes = [[x.c.ligadoSeg, x.c.em], [x.st.ligadoSeg, x.st.em]].filter(([v, em]) => v != null && em).sort((a, b) => b[1].localeCompare(a[1]));
    const lig = fontes.length ? fmtLigada(fontes[0][0] + Math.max(0, (agora - Date.parse(fontes[0][1])) / 1000)) : null;
    const pts = (x.st.pontos || []).map((p) => `${p.nome}: ${p.temp}°C`).join(" · ");
    const temp = x.st.temp != null ? `<span class="olt-temp ${x.tempNivel}" title="Temperatura lida ${timeAgo(x.st.em)}${pts ? " — " + esc(pts) : ""}${x.st.erro ? " (última tentativa falhou: " + esc(x.st.erro) + ")" : ""}">${Math.round(x.st.temp)}°C</span>` : "";
    return `<span class="olt-onus"><b>${x.c.online}</b>/${x.c.onus} ONUs</span>
      ${x.off ? `<span class="olt-off ${x.nivel}" title="${x.c.energia} sem energia · ${x.c.fibra} sem fibra · ${x.off - x.c.energia - x.c.fibra} outros">${x.off} off</span>` : ""}
      ${lig ? `<i class="olt-up" title="Tempo ligada">${lig}</i>` : ""}${lig && temp ? '<span class="olt-sep">,</span>' : ""}${temp}`;
  };
  box.innerHTML = `<div class="card olt-card" style="margin-bottom:20px">
    <div class="card-head"><h2>OLTs <span class="olt-cnt ${online < linhas.length ? "bad" : ""}">${online}/${linhas.length} online</span>
      ${nWarn ? `<span class="badge warn" title="OLTs com 10% ou mais das ONUs offline ou temperatura perto do limite">${ICONS.faults}${nWarn}</span>` : ""}
      ${nBad ? `<span class="badge bad" title="OLT sem resposta, com 25% ou mais das ONUs offline ou temperatura no limite de alarme">${ICONS.faults}${nBad}</span>` : ""}</h2>
      <span class="muted">${totOn}/${totOnus} ONUs online · <a href="#/olts">gerenciar ›</a></span></div>
    <div class="olt-list">${linhas.map((x) => `<a class="olt-row ${x.nivel === "bad" || x.tempNivel === "bad" ? "bad" : x.nivel === "warn" || x.tempNivel === "warn" ? "warn" : "good"}" href="#/olts" title="${esc(x.o.tipoNome)} · ${esc(x.o.ip)}${x.c ? ` · lida ${timeAgo(x.c.em)}` : ""}">
      <span class="olt-ico">${OLT_ICON}</span><span class="olt-nome">${esc(x.nome)}</span><span class="olt-det">${detalhe(x)}</span></a>`).join("")}</div>
  </div>`;
}

// Quedas das últimas 24 h: só a contagem; a lista abre quando o usuário pede (o estado aberto sobrevive à atualização da página)
let quedasAbertas = false;
async function loadRegionais() {
  let r;
  try { r = await api("/eventos/recentes?horas=24"); } catch { return; }
  const box = $("#regionais");
  if (!box || r.indisponivel) return;
  const ev = r.eventos || [];
  const aparelhos = new Set(ev.map((e) => e.id)).size;
  const n = (f) => new Set(ev.filter(f).map((e) => e.id)).size;
  const religou = n((e) => e.tipo === "religou"), fibra = n((e) => e.tipo === "rede");
  const energiaOlt = n((e) => e.causaOlt === "energia"), losOlt = n((e) => e.causaOlt === "fibra");
  const regionais = r.regionais || [];
  box.innerHTML = `<div class="card" style="margin-bottom:16px">
    <div class="card-head"><h2>Quedas nas últimas 24 h</h2>
      ${ev.length ? `<button class="btn sm" id="quedas-toggle">${quedasAbertas ? "Esconder lista" : "Ver lista"}</button>` : ""}</div>
    <div class="quedas-resumo">
      <div><span class="big-number" style="font-size:34px">${aparelhos}</span> <span class="muted">aparelho(s) caíram${ev.length > aparelhos ? ` · ${ev.length} quedas` : ""}</span></div>
      ${ev.length ? `<div class="quedas-tags">
        <span class="ev-tag diag-atencao">${religou} desligaram e religaram</span>
        <span class="ev-tag diag-info">${fibra} só perderam a fibra/OLT</span>
        ${energiaOlt ? `<span class="ev-tag diag-atencao">${energiaOlt} falta de energia confirmada pela OLT</span>` : ""}
        ${losOlt ? `<span class="ev-tag diag-problema">${losOlt} perda de fibra confirmada pela OLT</span>` : ""}
      </div>` : `<div class="muted">Nenhuma queda (sem pedido do ACS) nas últimas 24 horas.</div>`}
      ${regionais.map((g) => `<div style="margin-top:6px"><span class="badge warn">Queda regional</span> ${esc(fmtDate(g.inicio))}: ${g.aparelhos} aparelhos ao mesmo tempo
        <span class="muted">(${g.religaram} religaram${g.religaram ? " — provável falta de energia na região" : ""}; ${g.soRede} só fibra/OLT)</span></div>`).join("")}
    </div>
    <div id="quedas-lista" ${quedasAbertas ? "" : "hidden"}>${ev.length ? `<div class="table-wrap" style="margin-top:10px"><table>
      <thead><tr><th>Quando</th><th>Aparelho</th><th>O que aconteceu</th><th>OLT</th><th>Sem contato</th></tr></thead>
      <tbody>${ev.map((e) => `<tr class="click" data-dev="${esc(e.id)}">
        <td>${esc(fmtDate(e.ts))}<div class="muted" style="font-size:12px">${timeAgo(e.ts)}</div></td>
        <td>${e.cliente ? `<b class="client-id">${esc(e.cliente)}</b> ` : ""}${esc(e.nome)}<div class="muted" style="font-size:12px">${esc(e.modelo || "")}</div></td>
        <td><span class="ev-tag ${e.tipo === "religou" ? "diag-atencao" : "diag-info"}">${e.tipo === "religou" ? "Desligou e religou" : "Fibra/OLT caiu e voltou"}</span></td>
        <td>${e.causaOlt ? `<span class="ev-tag ${e.causaOlt === "energia" ? "diag-atencao" : e.causaOlt === "fibra" ? "diag-problema" : "diag-info"}">${e.causaOlt === "energia" ? "falta de energia" : e.causaOlt === "fibra" ? "perda de fibra" : esc(e.motivoOlt || "outro")}</span>` : `<span class="muted">—</span>`}</td>
        <td>${e.semContatoMin != null ? durMin(e.semContatoMin) : "—"}</td></tr>`).join("")}</tbody></table></div>` : ""}</div></div>`;
  const tg = $("#quedas-toggle");
  if (tg) tg.addEventListener("click", () => {
    quedasAbertas = !quedasAbertas;
    $("#quedas-lista").hidden = !quedasAbertas;
    tg.textContent = quedasAbertas ? "Esconder lista" : "Ver lista";
  });
}

const FILTERS = {
  all: ["Todos", () => true],
  online: ["Online", (d) => d.online],
  offline: ["Offline", (d) => !d.online],
  erro_sgp: ["Com ERRO_SGP", (d) => d.tags.includes("ERRO_SGP")],
  noprov: ["Não provisionados", (d) => !d.tags.includes("Provisioned")],
  signal: ["Sinal crítico/atenção", (d) => d.signal === "bad" || d.signal === "warn"],
  novos24: ["Novos nas últimas 24 h", (d) => registradoHa(d, 86400000)],
  novos7: ["Novos em 7 dias", (d) => registradoHa(d, 7 * 86400000)],
};
// Registrado no ACS há menos de `ms` (mesmo critério dos números do Dashboard)
function registradoHa(d, ms) {
  return !!d.registered && Date.now() - new Date(d.registered).getTime() < ms;
}

async function pageDevices(params) {
  const list = await api("/devices");
  const state = { q: params.get("q") || "", f: FILTERS[params.get("f")] ? params.get("f") : "all", page: 0, size: 25, sort: "lastInform", dir: -1 };
  if (state.f.startsWith("novos")) state.sort = "registered"; // mais novos primeiro

  view.innerHTML = `
    <div class="page-head"><h1>Dispositivos</h1><span class="muted">${list.length} no total</span></div>
    <div class="card">
      <div class="toolbar">
        <input type="search" id="q" placeholder="Buscar por código do cliente, SSID, serial, MAC, IP, modelo ou tag…" value="${esc(state.q)}">
        <select id="f">${Object.entries(FILTERS).map(([k, [label]]) => `<option value="${k}" ${k === state.f ? "selected" : ""}>${label}</option>`).join("")}</select>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th data-sort="sgpCliente">Cód. cliente</th><th data-sort="ssid">Rede (SSID)</th><th data-sort="serial">Serial</th><th data-sort="model">Modelo</th>
          <th data-sort="mac">MAC</th><th data-sort="wanIp">IP WAN</th><th data-sort="rx">Sinal RX</th>
          <th data-sort="lastInform">Último inform</th><th data-sort="online">Status</th><th data-sort="prov" title="Provisionamento">Prov.</th><th>Tags</th>
        </tr></thead>
        <tbody id="rows"></tbody>
      </table></div>
      <div class="pager"><span id="count"></span><span><button class="btn sm" id="prev">‹ Anterior</button> <button class="btn sm" id="next">Próxima ›</button></span></div>
    </div>`;

  function filtered() {
    const q = state.q.toLowerCase();
    const out = list.filter(FILTERS[state.f][1]).filter((d) => !q ||
      [d.sgpCliente, d.sgpContrato, d.ssid, d.serial, d.mac, d.wanIp, d.lanIp, d.model, d.id, ...d.tags].some((v) => String(v || "").toLowerCase().includes(q)));
    out.sort((a, b) => {
      const blank = state.sort === "rx" ? -999 : "";
      const key = (o) => (state.sort === "prov" ? provState(o)[0] : o[state.sort]);
      const x = key(a) ?? blank, y = key(b) ?? blank;
      return (x > y ? 1 : x < y ? -1 : 0) * state.dir;
    });
    return out;
  }

  function render() {
    const rows = filtered();
    const pages = Math.max(1, Math.ceil(rows.length / state.size));
    state.page = Math.min(state.page, pages - 1);
    const slice = rows.slice(state.page * state.size, (state.page + 1) * state.size);
    $("#rows").innerHTML = slice.length ? slice.map((d) => `
      <tr class="click" data-dev="${esc(d.id)}">
        <td>${d.sgpCliente ? `<b class="client-id">${esc(d.sgpCliente)}</b>` : `<span class="muted">—</span>`}</td>
        <td><b>${esc(d.ssid || "—")}</b></td><td>${esc(d.serial)}</td><td>${esc(d.model)}</td>
        <td><code>${esc(d.mac)}</code></td><td>${esc(d.wanIp || "—")}</td><td>${signalBadge(d)}</td>
        <td title="${esc(fmtDate(d.lastInform))}">${timeAgo(d.lastInform)}${state.f.startsWith("novos") && d.registered
          ? `<div class="muted" style="font-size:12px" title="${esc(fmtDate(d.registered))}">registrado ${timeAgo(d.registered)}</div>` : ""}</td><td>${statusBadge(d)}</td>
        <td style="text-align:center">${provIcon(d)}</td>
        ${(() => { const t = d.tags.filter((x) => !isHiddenTag(x)); return `<td class="tags-cell" title="${esc(t.join(", "))}">${tagList(t.slice(0, 2))}${t.length > 2 ? `<span class="tag more">+${t.length - 2}</span>` : ""}</td>`; })()}
      </tr>`).join("") : `<tr><td colspan="11" class="empty">Nenhum dispositivo encontrado.</td></tr>`;
    $("#count").textContent = `${rows.length} dispositivo(s) · página ${state.page + 1} de ${pages}`;
    $("#prev").disabled = state.page === 0;
    $("#next").disabled = state.page >= pages - 1;
  }

  $("#q").addEventListener("input", (e) => { state.q = e.target.value; state.page = 0; render(); });
  $("#f").addEventListener("change", (e) => { state.f = e.target.value; state.page = 0; render(); });
  $("#prev").addEventListener("click", () => { state.page--; render(); });
  $("#next").addEventListener("click", () => { state.page++; render(); });
  view.querySelectorAll("th[data-sort]").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.sort;
    state.dir = state.sort === k ? -state.dir : 1;
    state.sort = k;
    render();
  }));
  render();
}

// ---------- Wi-Fi, LAN e interferência (detalhe do dispositivo) ----------
const autoRead = new Set();

const wifiLevel = (s) => (s === null ? "" : s >= -65 ? "good" : s >= -75 ? "warn" : "bad");
const wifiLabel = (s) => (s === null ? "" : s >= -65 ? "Bom" : s >= -75 ? "Regular" : "Fraco");
const wifiBadge = (s) => (s === null ? `<span class="muted">—</span>` : `<span class="badge ${wifiLevel(s)}">${s} dBm</span> <span class="muted">${wifiLabel(s)}</span>`);
const mbps = (kbps) => (kbps === null || kbps <= 0 ? "—" : kbps >= 1000 ? `${Math.round(kbps / 1000)} Mbps` : `${kbps} kbps`);
const LEVEL_CLASS = { Livre: "good", Baixa: "good", Média: "warn", Alta: "bad" };

function lanSection(lan, online) {
  const off = online ? "" : "disabled title=\"Equipamento offline\"";
  const radios = lan.radios.map((r) => `<span class="tag">${esc(r.band)} · canal ${esc(r.channel)}${r.bandwidth ? " · " + esc(r.bandwidth) : ""}${r.autoChannel === true ? " · auto" : r.autoChannel === false ? " · fixo" : ""}</span>` +
    (r.ref && r.autoChannel === false ? `<button class="btn sm" style="margin:0 10px 4px 0" data-set-channel="auto" data-radio="${esc(r.ref)}" data-band="${esc(r.band)}" data-current="${esc(r.channel)}" ${online ? "" : "disabled"}>Canal automático</button>` : "")).join("");

  const clients = lan.clients.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Dispositivo</th><th>MAC</th><th>Rede</th><th>Sinal</th><th>Velocidade</th></tr></thead>
      <tbody>${lan.clients.sort((a, b) => (b.signal ?? -999) - (a.signal ?? -999)).map((c) => `<tr>
        <td><b>${esc(c.name || "Sem nome")}</b><br><span class="muted">${esc(c.ip || "")}</span></td>
        <td><code>${esc(c.mac)}</code></td>
        <td>${esc(c.band)}<br><span class="muted">${esc(c.ssid)}</span></td>
        <td>${wifiBadge(c.signal)}</td>
        <td>${mbps(c.down)}${c.standard ? `<br><span class="muted">802.11${esc(c.standard)}</span>` : ""}</td></tr>`).join("")}</tbody>
    </table></div>` : `<div class="empty">Nenhum cliente Wi-Fi conectado${lan.readAt ? "" : " (ainda não lido)"}.</div>`;

  const ports = lan.ports.length ? `<div class="ports">${lan.ports.map((p) => {
    const up = String(p.status).toLowerCase() === "up";
    return `<div class="port ${up ? "up" : ""}">
      <b>${esc(p.name)}${p.wan ? " (WAN)" : ""}</b>
      <span class="badge ${up ? "good" : ""}"><span class="dot"></span>${up ? "Conectada" : p.enabled === false ? "Desativada" : "Desconectada"}</span>
      ${up && p.speed > 0 ? `<small class="muted">${p.speed} Mbps ${esc(p.duplex)}</small>` : ""}
    </div>`;
  }).join("")}</div>` : `<div class="empty">Sem informação das portas.</div>`;

  const hosts = lan.hosts.length ? `<label class="muted" style="display:block;margin-bottom:8px"><input type="checkbox" id="hosts-all"> mostrar também os inativos</label>
    <div class="table-wrap"><table>
      <thead><tr><th>Nome</th><th>IP</th><th>MAC</th><th>Conexão</th><th>Status</th></tr></thead>
      <tbody>${lan.hosts.map((h) => `<tr ${h.active === false ? "data-inactive hidden" : ""}>
        <td><b>${esc(h.name && h.name !== "Unknown" ? h.name : "Sem nome")}</b></td>
        <td>${esc(h.ip)}</td><td><code>${esc(h.mac)}</code></td>
        <td>${esc(h.type || "—")}</td>
        <td>${h.active === false ? `<span class="badge">Inativo</span>` : `<span class="badge good"><span class="dot"></span>Ativo</span>`}</td></tr>`).join("")}</tbody>
    </table></div>` : `<div class="empty">Nenhum host conhecido${lan.readAt ? "" : " (ainda não lido)"}.</div>`;

  const n = lan.neighbors;
  let interference;
  if (!n.supported) {
    interference = `<div class="empty">Este modelo não permite varredura de redes vizinhas pelo ACS.</div>`;
  } else if (!n.results.length) {
    interference = `<div class="empty">Nenhuma varredura feita ainda. Clique em "Verificar interferência".</div>`;
  } else {
    const myChannels = new Map(lan.radios.map((r) => [r.band, r.channel]));
    interference = `
      <div class="grid-2" style="margin-bottom:14px">${lan.interference.map((a) => `
        <div class="card" style="box-shadow:none">
          <div class="card-head"><h2>${esc(a.band)} · canal ${esc(a.channel)}</h2><span class="badge ${LEVEL_CLASS[a.level]}">Interferência ${a.level.toLowerCase()}</span></div>
          <div class="muted">${a.networks} rede(s) vizinha(s) nesta faixa · ${a.overlapping} no mesmo canal ou em canal sobreposto</div>
          ${a.suggestion ? `<div style="margin-top:8px">💡 Sugestão: usar o <b>canal ${a.suggestion}</b>${a.autoChannel === true ? " (hoje o canal está no automático)" : ""}.</div>
            ${a.radio ? `<button class="btn sm primary" style="margin-top:10px" data-set-channel="${a.suggestion}" data-radio="${esc(a.radio)}" data-band="${esc(a.band)}" data-current="${esc(a.channel)}" ${online ? "" : "disabled"}>Aplicar canal ${a.suggestion}</button>` : ""}`
            : `<div style="margin-top:8px">✅ O canal atual já é a melhor opção encontrada.</div>`}
          ${a.radio && a.autoChannel === false ? `<div style="margin-top:10px"><span class="muted">Canal fixo.</span>
            <button class="btn sm" data-set-channel="auto" data-radio="${esc(a.radio)}" data-band="${esc(a.band)}" data-current="${esc(a.channel)}" ${online ? "" : "disabled"}>Voltar para canal automático</button></div>` : ""}
        </div>`).join("")}</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Rede (SSID)</th><th>Faixa</th><th>Canal</th><th>Sinal</th><th>Segurança</th></tr></thead>
        <tbody>${n.results.slice().sort((a, b) => (b.signal ?? -999) - (a.signal ?? -999)).map((r) => {
          const same = myChannels.get(r.band) === r.channel;
          return `<tr><td><b>${esc(r.ssid || "(oculta)")}</b><br><span class="muted"><code>${esc(r.bssid)}</code></span></td>
            <td>${esc(r.band)}</td>
            <td>${esc(r.channel)} ${same ? `<span class="badge bad">mesmo canal</span>` : ""}<br><span class="muted">${esc(r.bandwidth)}</span></td>
            <td>${wifiBadge(r.signal)}</td><td>${esc(r.security)}</td></tr>`;
        }).join("")}</tbody>
      </table></div>`;
  }

  return `
    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h2>Wi-Fi · ${lan.clients.length} cliente(s)</h2>
        <span class="muted">${lan.readAt ? "lido " + timeAgo(lan.readAt) : "ainda não lido"}
          ${lan.wifiEditavel || lan.radios.some((r) => r.ref) ? `<button class="btn sm" id="wifi-edit" ${off}>Alterar Wi-Fi</button>` : ""}
          <button class="btn sm" data-act="read-lan" ${off}>Ler Wi-Fi e LAN agora</button></span></div>
      <form id="wifi-form" class="photo-form" style="margin-bottom:12px" hidden></form>
      <div style="margin-bottom:10px">${radios}</div>
      ${clients}
    </div>
    <div class="grid-2">
      <div class="card"><h2>Portas de rede</h2>${ports}</div>
      <div class="card"><h2>Dispositivos conectados</h2>${hosts}</div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Interferência Wi-Fi</h2>
        <span class="muted">${n.at ? "varredura " + timeAgo(n.at) : ""} ${n.supported ? `<button class="btn sm" data-act="wifi-scan" ${off}>Verificar interferência</button>` : ""}</span></div>
      ${interference}
    </div>`;
}

// ---------- Teste de velocidade ----------
function speedBox(label, r) {
  if (!r || !r.supported) return `<div class="speed"><small>${label}</small><b class="muted">—</b><span class="muted">não suportado</span></div>`;
  return `<div class="speed"><small>${label}</small>
    <b>${r.mbps !== null ? r.mbps.toLocaleString("pt-BR") + " <span>Mbps</span>" : "—"}</b>
    <span class="muted">${r.mbps !== null ? `${(r.bytes / 1048576).toFixed(0)} MB em ${r.seconds}s · ${timeAgo(r.at)}` : r.state && r.state !== "None" ? esc(r.state) : "nunca testado"}</span></div>`;
}

function speedSection(st, online) {
  const busy = !!st.running;
  const off = !online || busy ? "disabled" : "";
  return `<div class="card" id="speed-card" style="margin-bottom:16px">
    <div class="card-head"><h2>Teste de velocidade</h2>
      <span class="muted">
        <button class="btn sm" data-speed="download" ${off} ${st.download.supported ? "" : "hidden"}>Testar download</button>
        <button class="btn sm" data-speed="upload" ${off} ${st.upload.supported ? "" : "hidden"}>Testar upload</button>
      </span></div>
    <div class="speeds">${speedBox("⬇ Download", st.download)}${speedBox("⬆ Upload", st.upload)}</div>
    <div id="speed-status" class="muted" style="margin-top:10px">${busy ? "⏳ " + esc(st.running.message) : "O teste é feito pelo próprio roteador do cliente, direto do servidor da Globaltech."}</div>
  </div>`;
}

// Teste em andamento: o quadro central fica aberto com o andamento até o resultado.
// Guarda o id fora da página: se a página for redesenhada no meio do teste, continua acompanhando.
let speedJob = null;
const SPEED_LABEL = { download: "Teste de download", upload: "Teste de upload" };

function finishSpeedOverlay() {
  if (!speedJob) return;
  speedJob = null;
  hideLoading();
}

function watchSpeedtest(jobId, type) {
  clearInterval(pageTimer);
  view.querySelectorAll("[data-speed]").forEach((b) => (b.disabled = true));
  if (!speedJob) {
    speedJob = { id: jobId, type };
    showLoading(`${SPEED_LABEL[type] || "Teste de velocidade"}: preparando…`);
  }
  const tick = async () => {
    try {
      const job = await api("/speedtest/" + jobId);
      const label = SPEED_LABEL[job.type] || "Teste de velocidade";
      const s = $("#speed-status");
      if (s) s.textContent = (job.state === "done" ? "✅ " : job.state === "error" ? "⚠️ " : "⏳ ") + job.message;
      if (job.state === "done" || job.state === "error") {
        clearInterval(pageTimer);
        finishSpeedOverlay();
        toast(job.state === "done" ? `${label} concluído — ${job.message.replace(/^\w+: /, "")}` : `${label}: ${job.message}`, job.state === "error");
        setTimeout(() => route(true), 1200);
      } else if ($("#overlay-icon").className === "ov-spinner") {
        $("#overlay-msg").textContent = `${label}: ${job.message}`;
      }
    } catch (e) {
      clearInterval(pageTimer);
      finishSpeedOverlay();
      toast(e.message, true);
    }
  };
  pageTimer = setInterval(tick, 3000);
  tick();
}

// ---------- Visão geral: tempo ligado e medidores de sinal ----------
function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}min`;
  return `${m}min ${s % 60}s`;
}

// Faixas: GPON classe B+ (RX -27 a -8 dBm; TX da ONU 0,5 a 5 dBm)
const RX_GAUGE = { min: -32, max: -5, zones: [[-32, -27, "bad"], [-27, -24, "warn"], [-24, -8, "good"], [-8, -5, "bad"]] };
const TX_GAUGE = { min: -2, max: 8, zones: [[-2, 0.5, "bad"], [0.5, 5, "good"], [5, 8, "warn"]] };

function gauge(label, value, g) {
  const pct = (v) => ((Math.min(g.max, Math.max(g.min, v)) - g.min) / (g.max - g.min)) * 100;
  const zone = value === null ? "none" : (g.zones.find(([a, b]) => value >= a && value <= b) || [0, 0, "bad"])[2];
  return `<div class="gauge">
    <small>${label}</small>
    <b class="${zone}">${value === null ? "—" : value.toFixed(2)} <span>dBm</span></b>
    <div class="gauge-bar">
      ${g.zones.map(([a, b, z]) => `<i class="${z}" style="left:${pct(a)}%;width:${pct(b) - pct(a)}%"></i>`).join("")}
      ${value === null ? "" : `<em style="left:${pct(value)}%"></em>`}
    </div>
  </div>`;
}

// ---------- Alterar Wi-Fi (guarda cópia para restaurar após reset de fábrica) ----------
function bindWifiEdit(id) {
  const btn = $("#wifi-edit");
  const form = $("#wifi-form");
  if (!btn || !form) return;
  btn.addEventListener("click", async () => {
    if (!form.hidden) { form.hidden = true; return; }
    btn.disabled = true;
    try {
      const w = await api(`/devices/${enc(id)}/wifi`);
      if (!w.supported) return toast("Este modelo não permite alterar o Wi-Fi pelo portal.", true);
      const bk = w.backup;
      form.innerHTML = `
        <b>Alterar Wi-Fi principal</b>
        <span class="muted">O roteador não informa a senha atual ao ACS. Deixe a senha em branco para mantê-la.
          ${bk ? `Cópia guardada: ${Object.entries(bk.bands).map(([b, x]) => `${esc(b)} "${esc(x.ssid)}"${x.hasPass ? " com senha" : " sem senha"}`).join(", ")} · ${timeAgo(bk.at)} por ${esc(bk.user || "")}` : "Ainda não há cópia guardada deste equipamento."}</span>
        <div class="grid-2" style="margin:0">
          ${w.bands.map((b) => `<div class="photo-form" style="background:var(--panel)">
            <b>${esc(b.band)}</b>
            <label>Nome da rede (SSID)<input name="ssid-${esc(b.band)}" value="${esc(b.ssid)}" maxlength="32" required></label>
            <label>Nova senha<input name="pass-${esc(b.band)}" type="password" minlength="8" maxlength="63" autocomplete="new-password" placeholder="em branco = manter"></label>
          </div>`).join("")}
        </div>
        <label class="muted"><input type="checkbox" id="wifi-show"> mostrar senhas digitadas</label>
        <div class="toolbar" style="margin:0">
          <button class="btn sm primary" type="submit">Salvar no roteador</button>
          <button class="btn sm" type="button" id="wifi-cancel">Cancelar</button>
        </div>`;
      form.hidden = false;
      $("#wifi-cancel").addEventListener("click", () => (form.hidden = true));
      $("#wifi-show").addEventListener("change", (e) => form.querySelectorAll('input[name^="pass-"]').forEach((i) => (i.type = e.target.checked ? "text" : "password")));
      form.onsubmit = async (e) => {
        e.preventDefault();
        const bands = {};
        for (const b of w.bands) {
          bands[b.band] = { ssid: form.elements["ssid-" + b.band].value.trim(), pass: form.elements["pass-" + b.band].value };
        }
        if (!confirm("Gravar o Wi-Fi no roteador?\n\nOs aparelhos do cliente vão desconectar e precisam da nova senha (se ela foi alterada).")) return;
        const sub = form.querySelector('button[type="submit"]');
        sub.disabled = true;
        sub.textContent = "Gravando…";
        try {
          const r = await api(`/devices/${enc(id)}/wifi`, { method: "POST", body: { bands }, loading: "Gravando Wi-Fi no roteador…" });
          const hub = r.hubsoft ? (r.hubsoft.ok ? ` ${SISTEMA}: ${r.hubsoft.msg}.` : ` Não gravou no ${SISTEMA}: ${r.hubsoft.msg}.`) : "";
          toast((r.done ? "Wi-Fi gravado no roteador e cópia guardada." : "Equipamento não respondeu agora; a alteração fica na fila. Cópia guardada.") + hub,
            !!(r.hubsoft && !r.hubsoft.ok));
          form.hidden = true;
          setTimeout(() => route(true), 1500);
        } catch (ex) {
          toast(ex.message, true);
          sub.disabled = false;
          sub.textContent = "Salvar no roteador";
        }
      };
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------- Foto do modelo ----------
function modelPhoto(model, url) {
  return `<div class="model-photo">
    ${url ? `<img src="${esc(url)}" alt="${esc(model)}" referrerpolicy="no-referrer">` : `<div class="model-photo-empty">sem foto do ${esc(model)}</div>`}
    <button class="btn sm photo-btn" id="photo-edit" type="button" title="${url ? "Alterar foto" : "Adicionar foto"}">${url ? "✎ Foto" : "+ Foto"}</button>
  </div>
  <form id="photo-form" class="photo-form" hidden>
    <b>Foto do modelo ${esc(model)}</b>
    <span class="muted">Vale para todos os equipamentos ${esc(model)}.</span>
    <label>Enviar arquivo (PNG, JPG ou WEBP)<input type="file" id="photo-file" accept="image/png,image/jpeg,image/webp"></label>
    <label>ou usar uma URL<input type="url" id="photo-url" placeholder="https://…/foto.png"></label>
    <div class="toolbar" style="margin:0">
      <button class="btn sm primary" type="submit">Salvar</button>
      ${url ? `<button class="btn sm danger" type="button" id="photo-remove">Remover foto</button>` : ""}
      <button class="btn sm" type="button" id="photo-cancel">Cancelar</button>
    </div>
  </form>`;
}

// Reduz a imagem no navegador (máx. 400 px) para não guardar arquivos grandes
function shrinkImage(file, max = 400) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      // PNG mantém o fundo transparente das fotos de produto
      resolve(c.toDataURL(file.type === "image/png" ? "image/png" : "image/jpeg", 0.88));
    };
    img.onerror = () => reject(new Error("Não consegui abrir essa imagem."));
    img.src = URL.createObjectURL(file);
  });
}

function bindModelPhoto(model) {
  const form = $("#photo-form");
  const path = `/models/${enc(model)}/image`;
  $("#photo-edit").addEventListener("click", () => (form.hidden = !form.hidden));
  $("#photo-cancel").addEventListener("click", () => (form.hidden = true));
  const rm = $("#photo-remove");
  if (rm) rm.addEventListener("click", async () => {
    if (!confirm(`Remover a foto do modelo ${model}?`)) return;
    try { await api(path, { method: "DELETE", loading: "Removendo foto…" }); toast("Foto removida."); route(true); } catch (e) { toast(e.message, true); }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = $("#photo-file").files[0];
    const url = $("#photo-url").value.trim();
    if (!file && !url) return toast("Escolha um arquivo ou informe uma URL.", true);
    try {
      const body = file ? { dataUrl: await shrinkImage(file) } : { url };
      await api(path, { method: "POST", body, loading: "Salvando foto…" });
      toast(`Foto do modelo ${model} salva.`);
      route(true);
    } catch (ex) { toast(ex.message, true); }
  });
}

async function pageDevice(id) {
  const { device: d, lan, speedtest: st, root, modelImage, firmwareJob: fj } = await api("/devices/" + enc(id));
  $("#page-title").textContent = d.ssid || d.serial;
  view.innerHTML = `
    <div class="page-head">
      <div><a href="#/devices">‹ Dispositivos</a><h1>${esc(d.ssid || d.serial)}</h1></div>
      <div class="toolbar" style="margin:0">
        <button class="btn" data-act="refresh">Atualizar agora</button>
        <button class="btn" data-act="reprovision">Reprovisionar</button>
        <button class="btn danger" data-act="reboot" ${fj.lockMinutes ? `disabled title="Atualização de firmware em andamento: aguarde ${fj.lockMinutes} min"` : ""}>Reiniciar</button>
      </div>
    </div>
    <div class="card device-main">
      <div class="overview">
        ${modelPhoto(d.model, modelImage)}
        <div class="status-box">
          <div class="status-line">${statusBadge(d)}
            <span class="muted">${d.online ? (d.uptime !== null ? "ligado há " + fmtUptime(d.uptime) : "") : "último contato " + timeAgo(d.lastInform)}</span>
            ${provBadge(d)}</div>
          ${!d.hasOptical
            ? `<div class="muted">Este equipamento é um roteador sem fibra (sem interface óptica); o sinal óptico fica na ONU/ONT que está antes dele.</div>`
            : `<div class="gauges">
            ${gauge("ONU Rx 1490nm", d.rx, RX_GAUGE)}
            ${gauge("ONU Tx 1310nm", d.tx, TX_GAUGE)}
          </div>`}
        </div>
        <div class="tags-box">
          <h2>Tags</h2>
          <div id="tags">${tagList(d.tags.filter((x) => !isHiddenTag(x)), true) || `<span class="muted">Sem tags</span>`}</div>
          <form id="tag-form" class="toolbar" style="margin:10px 0 0">
            <input id="new-tag" placeholder="Nova tag" pattern="[A-Za-z0-9_.\\-]{1,64}" required>
            <button class="btn sm" type="submit">Adicionar</button>
          </form>
        </div>
      </div>
      <div class="device-info"><h2>Informações</h2><dl class="kv">
        <dt>Cliente ${esc(SISTEMA)}</dt><dd>${d.sgpCliente ? `${sgpClienteLink(d.sgpCliente)}${d.sgpContrato ? ` <span class="muted">· contrato ${esc(d.sgpContrato)}</span>` : ""}` : `<span class="muted">não vinculado</span>`}</dd>
        <dt>Serial</dt><dd>${esc(d.serial)}</dd>
        <dt>Fabricante / modelo</dt><dd>${esc(d.manufacturer)} ${esc(d.model)}</dd>
        ${d.hasOptical ? `<dt>OLT / ONU</dt><dd id="olt-info"><span class="muted">carregando…</span></dd>` : ""}
        <dt>Hardware</dt><dd>${esc(d.hardware || "—")}</dd>
        <dt>Firmware</dt><dd>${esc(d.software || "—")}
          ${d.online ? `<button class="btn sm" id="fw-upgrade" style="margin-left:8px">Atualizar firmware</button>`
            : `<button class="btn sm" disabled style="margin-left:8px;opacity:.5;cursor:not-allowed" title="Equipamento offline: reinicie a ONT e aguarde ela voltar a se comunicar com o ACS para atualizar o firmware.">Atualizar firmware</button>
               <div class="muted" style="margin-top:4px">Atualização disponível só com o equipamento online.</div>`}
          ${fwJobLine(fj)}</dd>
        <dt>MAC</dt><dd><code>${esc(d.mac || "—")}</code></dd>
        <dt>IP WAN</dt><dd>${esc(d.wanIp || "—")}</dd>
        <dt>IP LAN</dt><dd>${esc(d.lanIp || "—")}</dd>
        <dt>Último inform</dt><dd>${fmtDate(d.lastInform)} (${timeAgo(d.lastInform)})</dd>
        <dt>Registrado em</dt><dd>${fmtDate(d.registered)}</dd>
        <dt>Modelo de dados</dt><dd>${esc(root)}</dd>
        <dt>ID no ACS</dt><dd><code>${esc(d.id)}</code></dd>
      </dl></div>
    </div>
    <div class="card diag-card" id="diag-card"><div class="card-head"><h2>Diagnóstico e assistente</h2><span class="muted">analisando…</span></div></div>
    <div class="card diag-card" id="ev-card"><div class="card-head"><h2>Quedas e reinícios</h2><span class="muted">carregando…</span></div></div>
    <div class="card diag-card" id="sinal-card"><div class="card-head"><h2>Tráfego e sinal</h2><span class="muted">carregando…</span></div></div>
    ${speedSection(st, d.online)}
    ${lanSection(lan, d.online)}`;
  loadDiagnostico(id);
  loadEventos(id);
  loadSinal(id);

  // Teste em andamento (inclusive se a página foi redesenhada no meio dele)
  if (st.running) watchSpeedtest(st.running.id, st.running.type);
  else if (speedJob) watchSpeedtest(speedJob.id, speedJob.type);
  view.querySelectorAll("[data-speed]").forEach((b) => b.addEventListener("click", async () => {
    const type = b.dataset.speed;
    const what = type === "download"
      ? "Testar a velocidade de DOWNLOAD?\n\nO roteador baixa um arquivo de 100 MB do servidor da Globaltech. A internet do cliente fica mais lenta por alguns segundos."
      : "Testar a velocidade de UPLOAD?\n\nO roteador envia 100 MB para o servidor da Globaltech. A internet do cliente fica mais lenta por alguns segundos.";
    if (!confirm(what)) return;
    try {
      const job = await api(`/devices/${enc(id)}/speedtest`, { method: "POST", body: { type }, loading: false });
      $("#speed-status").textContent = "⏳ " + job.message;
      watchSpeedtest(job.id, type);
    } catch (e) { toast(e.message, true); }
  }));

  const CONFIRM = {
    reboot: "Reiniciar este equipamento? O cliente fica sem internet por alguns minutos.",
    reprovision: "Reprovisionar? A tag Provisioned será removida e o provisionamento IPoE roda de novo.",
    "wifi-scan": "Verificar interferência? O rádio Wi-Fi faz uma varredura de canais por alguns segundos; a conexão dos clientes pode oscilar rapidamente.",
  };
  const BUSY = {
    refresh: "Atualizando dados do equipamento…",
    reprovision: "Reprovisionando…",
    reboot: "Enviando reinício ao equipamento…",
    "read-lan": "Lendo Wi-Fi e LAN do equipamento…",
    "wifi-scan": "Varrendo redes vizinhas (até 40 s)…",
  };

  // Lê automaticamente se os dados de Wi-Fi/LAN estiverem velhos (> 10 min) e o equipamento online
  const stale = !lan.readAt || Date.now() - new Date(lan.readAt).getTime() > 600000;
  if (d.online && stale && !autoRead.has(id)) {
    autoRead.add(id);
    setTimeout(() => { const b = view.querySelector('[data-act="read-lan"]'); if (b) { b.dataset.auto = "1"; b.click(); } }, 300);
  }
  view.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", async () => {
    const act = b.dataset.act;
    // Leitura automática ao abrir a página: sem quadro central, só o texto no botão
    const auto = b.dataset.auto === "1";
    delete b.dataset.auto;
    if (!auto && CONFIRM[act] && !confirm(CONFIRM[act])) return;
    b.disabled = true;
    const label = b.textContent;
    if (auto) b.textContent = "Lendo…";
    try {
      const r = await api(`/devices/${enc(id)}/${act}`, { method: "POST", loading: auto ? false : BUSY[act] });
      if (!auto) toast(r.done ? "Comando executado no equipamento." : "Equipamento não respondeu agora; comando fica na fila até o próximo inform.");
      b.textContent = label;
      if (act !== "reboot") setTimeout(() => route(true), 1500);
    } catch (e) {
      toast(e.message, true);
      b.textContent = label;
    } finally {
      b.disabled = false;
    }
  }));

  view.querySelectorAll("[data-set-channel]").forEach((b) => b.addEventListener("click", async () => {
    const { setChannel: ch, radio, band, current } = b.dataset;
    const auto = ch === "auto";
    const question = auto
      ? `Voltar o Wi-Fi ${band} para o canal AUTOMÁTICO?\n\n• O roteador escolhe o canal sozinho (hoje está fixo no ${current}).\n• Os clientes dessa faixa podem cair e reconectar em alguns segundos.`
      : `Trocar o Wi-Fi ${band} do canal ${current} para o canal ${ch}?\n\n• O canal passa a ser FIXO (o canal automático será desligado).\n• Os clientes conectados nessa faixa caem e reconectam em alguns segundos.`;
    if (!confirm(question)) return;
    const label = b.textContent;
    b.disabled = true;
    b.textContent = "Aplicando…";
    try {
      const r = await api(`/devices/${enc(id)}/set-channel`, { method: "POST", body: { radio, channel: auto ? "auto" : Number(ch) }, loading: "Trocando o canal do Wi-Fi…" });
      const ok = auto ? `Wi-Fi ${band} voltou para o canal automático.` : `Canal ${band} alterado para ${ch}.`;
      toast(r.done ? ok : "Equipamento não respondeu agora; a troca fica na fila até o próximo inform.");
      setTimeout(() => route(true), 1500);
    } catch (e) {
      toast(e.message, true);
      b.disabled = false;
      b.textContent = label;
    }
  }));

  bindModelPhoto(d.model);
  bindWifiEdit(id);
  bindFirmwareUpgrade(id, d);

  const showAll = $("#hosts-all");
  if (showAll) showAll.addEventListener("change", () => {
    view.querySelectorAll("tr[data-inactive]").forEach((tr) => (tr.hidden = !showAll.checked));
  });

  $("#tag-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api(`/devices/${enc(id)}/tags/${enc($("#new-tag").value.trim())}`, { method: "POST", loading: "Adicionando tag…" });
      toast("Tag adicionada.");
      route(true);
    } catch (ex) { toast(ex.message, true); }
  });
  $("#tags").addEventListener("click", async (e) => {
    const t = e.target.dataset.untag;
    if (!t || !confirm(`Remover a tag ${t}?`)) return;
    try {
      await api(`/devices/${enc(id)}/tags/${enc(t)}`, { method: "DELETE", loading: "Removendo tag…" });
      toast("Tag removida.");
      route(true);
    } catch (ex) { toast(ex.message, true); }
  });
}

// ---------- Diagnóstico (regras) e assistente (IA) na página do equipamento ----------
const chats = new Map(); // conversa por equipamento (sobrevive ao redesenho da página)
const DIAG_ICON = { problema: "✕", atencao: "!", info: "i", ok: "✓" };
const ACAO_TXT = {
  refresh: "Atualizar dados", "read-lan": "Ler Wi-Fi e LAN", "wifi-scan": "Verificar interferência",
  "speedtest-download": "Teste de download", "speedtest-upload": "Teste de upload",
};
const SUGESTOES = ["Cliente diz que a internet está lenta", "A internet cai várias vezes ao dia", "Wi-Fi não alcança alguns cômodos", "Cliente está sem internet", "Explique o diagnóstico em linguagem simples para passar ao cliente"];

// Ação segura: usa o mesmo botão da página (com as mesmas confirmações)
function runAcao(acao) {
  const sel = acao.startsWith("speedtest-") ? `[data-speed="${acao.slice(10)}"]` : `[data-act="${acao}"]`;
  const b = view.querySelector(sel);
  if (!b) return toast("Ação indisponível agora (equipamento offline ou recurso não suportado).", true);
  b.scrollIntoView({ behavior: "smooth", block: "center" });
  b.click();
}

// Texto da IA: escapa HTML; **negrito** e quebras de linha
const iaHtml = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");

async function loadDiagnostico(id) {
  const card = $("#diag-card");
  if (!card) return;
  let r;
  try { r = await api(`/devices/${enc(id)}/diagnostico`); } catch (e) {
    card.innerHTML = `<div class="card-head"><h2>Diagnóstico e assistente</h2></div><div class="muted">Não foi possível analisar: ${esc(e.message)}</div>`;
    return;
  }
  if (!$("#diag-card")) return; // saiu da página
  const hist = chats.get(id) || [];
  chats.set(id, hist);
  card.innerHTML = `
    <div class="card-head"><h2>Diagnóstico e assistente</h2><span class="muted">${esc(r.resumo)}</span></div>
    <div class="diag-grid">
      <ul class="diag-list">${r.achados.map((a) => `
        <li class="diag-${a.nivel}"><span class="diag-ico">${DIAG_ICON[a.nivel]}</span>
          <div><b>${esc(a.titulo)}</b> <span class="diag-area">${esc(a.area)}</span>
          ${a.detalhe ? `<div class="muted">${esc(a.detalhe)}</div>` : ""}
          ${a.acao ? `<button class="btn sm" data-diag-acao="${esc(a.acao)}">${esc(ACAO_TXT[a.acao] || a.acao)}</button>` : ""}</div></li>`).join("")}
      </ul>
      <div class="chat">
        ${r.assistente ? `
        <div class="chat-msgs" id="chat-msgs"></div>
        <div class="chat-sug" id="chat-sug">${SUGESTOES.map((s) => `<button class="btn sm" data-sug="${esc(s)}">${esc(s)}</button>`).join("")}</div>
        <form class="chat-form" id="chat-form">
          <input id="chat-in" placeholder="Descreva o problema do cliente…" autocomplete="off" maxlength="1500">
          <button class="btn primary" type="submit">Perguntar</button>
        </form>
        <div class="muted chat-nota">Assistente com IA gratuita: confira antes de agir. Não digite nome, CPF, telefone ou senhas do cliente.</div>`
        : `<div class="muted" style="padding:12px">Assistente com IA não configurado. O diagnóstico ao lado funciona sem ele.</div>`}
      </div>
    </div>`;

  card.querySelectorAll("[data-diag-acao]").forEach((b) => b.addEventListener("click", () => runAcao(b.dataset.diagAcao)));
  if (!r.assistente) return;

  const box = $("#chat-msgs");
  const render = () => {
    box.innerHTML = hist.length ? hist.map((m) => `
      <div class="msg msg-${m.role}">${m.role === "assistant" ? iaHtml(m.content) : esc(m.content)}
        ${(m.acoes || []).map((a) => `<button class="btn sm" data-chat-acao="${esc(a)}">${esc(ACAO_TXT[a] || a)}</button>`).join("")}
        ${m.via ? `<div class="msg-via">via ${esc(m.via)}</div>` : ""}</div>`).join("")
      : `<div class="muted" style="padding:8px">Descreva o que o cliente relata. O assistente já conhece os dados deste equipamento.</div>`;
    box.querySelectorAll("[data-chat-acao]").forEach((b) => b.addEventListener("click", () => runAcao(b.dataset.chatAcao)));
    box.scrollTop = box.scrollHeight;
    $("#chat-sug").hidden = hist.length > 0;
  };
  render();

  const enviar = async (texto) => {
    texto = texto.trim();
    if (!texto) return;
    hist.push({ role: "user", content: texto });
    hist.push({ role: "assistant", content: "Pensando…", pendente: true });
    render();
    try {
      const resp = await api(`/devices/${enc(id)}/assistente`, {
        method: "POST", loading: false,
        body: { mensagens: hist.filter((m) => !m.pendente).map((m) => ({ role: m.role, content: m.content })) },
      });
      hist.splice(-1, 1, { role: "assistant", content: resp.texto, acoes: resp.acoes, via: resp.provedor });
    } catch (e) {
      hist.splice(-2, 2);
      toast(e.message, true);
    }
    if ($("#chat-msgs") === box) render();
  };
  $("#chat-form").addEventListener("submit", (e) => { e.preventDefault(); const i = $("#chat-in"); const t = i.value; i.value = ""; enviar(t); });
  card.querySelectorAll("[data-sug]").forEach((b) => b.addEventListener("click", () => enviar(b.dataset.sug)));
}

// ---------- Quedas e reinícios (histórico vindo do log do ACS) ----------
const EV_TIPO = {
  religou: ["Desligou e religou", "diag-atencao", "Sem pedido do ACS: falta de energia, tomada, botão ou travamento."],
  rede: ["Fibra/OLT caiu e voltou", "diag-info", "O equipamento continuou ligado; a conexão GPON se refez (ou reset/troca de ACS)."],
  acs: ["Reinício pedido pelo ACS", "diag-ok", "Portal ou reboot periódico da madrugada."],
  firmware: ["Reinício da atualização de firmware", "diag-ok", "Reiniciou depois de um comando de firmware."],
};
const durMin = (m) => (m == null ? "—" : m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} dias`);

async function loadEventos(id) {
  const card = $("#ev-card");
  if (!card) return;
  let r;
  try { r = await api(`/devices/${enc(id)}/eventos`); } catch (e) { r = { eventos: [], indisponivel: true }; }
  if (!$("#ev-card")) return;
  const ev = r.eventos || [];
  const sem7 = ev.filter((e) => Date.now() - Date.parse(e.ts) < 7 * 86400000);
  const n = (t) => sem7.filter((e) => e.tipo === t).length;
  const onu = r.onu;
  const CAUSA = { energia: ["Falta de energia (dying gasp)", "diag-atencao"], fibra: ["Perda de fibra (LOS)", "diag-problema"], outro: ["Outro motivo", "diag-info"] };
  const oltQuedas = onu ? (onu.historico || []).slice(0, 10) : [];
  // OLT/ONU vai para o quadro "Informações" (a mesma leitura também alimenta este quadro)
  const oltInfo = $("#olt-info");
  if (oltInfo) oltInfo.innerHTML = onu
    ? `<b>OLT ${esc(onu.oltNome)}</b> · ONU <code>${esc(onu.index)}</code>${onu.sn ? ` · ${esc(onu.sn)}` : ""}
        <div style="margin-top:4px">${onu.online ? `<span class="badge good"><span class="dot"></span>online na OLT</span>` : `<span class="badge bad"><span class="dot"></span>${esc(onu.causa === "energia" ? "sem energia (dying gasp)" : onu.causa === "fibra" ? "sem fibra (LOS)" : onu.estadoOlt)}</span>`}
        ${onu.rx ? ` <span class="muted">· RX ${onu.rx} dBm</span>` : ""} <span class="muted">· lido ${timeAgo(onu.visto)}</span></div>`
    : `<span class="muted">${r.indisponivel ? "indisponível agora" : "não encontrada nas OLTs cadastradas"}</span>`;
  card.innerHTML = `
    <div class="card-head"><h2>Quedas e reinícios</h2>
      <span class="muted">${r.indisponivel ? "histórico indisponível agora" : `últimos 7 dias: ${n("religou")} religou · ${n("rede")} fibra/OLT · ${n("acs") + n("firmware")} pedidos pelo ACS`}</span></div>
    ${onu ? `${oltQuedas.length ? `<details style="margin:6px 0 10px"><summary>Quedas registradas pela OLT (${onu.historico.length})</summary>
        <table style="margin-top:6px"><thead><tr><th>Caiu</th><th>Voltou</th><th>Causa (OLT)</th></tr></thead><tbody>${oltQuedas.map((q) => `<tr>
          <td>${esc(fmtDate(q.caiu))}</td><td>${q.voltou ? esc(fmtDate(q.voltou)) : "—"}</td>
          <td>${q.pedidoAcs ? `<span class="ev-tag diag-ok">Reinício pedido pelo ACS${q.pedidoAcs === "firmware" ? " (firmware)" : ""}</span>` : `<span class="ev-tag ${(CAUSA[q.causa] || CAUSA.outro)[1]}">${esc((CAUSA[q.causa] || CAUSA.outro)[0])}</span>`} <span class="muted">${esc(q.motivo || "")}</span></td></tr>`).join("")}</tbody></table></details>` : ""}`
      : `<div class="muted" style="font-size:12.5px;margin-bottom:8px">ONU não encontrada nas OLTs cadastradas (cadastre a OLT em Configuração → OLTs).</div>`}
    ${ev.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Quando</th><th>O que aconteceu</th><th>Sem contato antes</th><th>Eventos recebidos</th></tr></thead>
      <tbody>${ev.map((e) => {
        const [txt, cls, dica] = EV_TIPO[e.tipo] || [e.tipo, "", ""];
        return `<tr><td title="${esc(fmtDate(e.ts))}">${esc(fmtDate(e.ts))}<div class="muted" style="font-size:12px">${timeAgo(e.ts)}</div></td>
          <td><span class="ev-tag ${cls}">${esc(txt)}</span>${e.causaOlt ? ` <span class="ev-tag ${e.causaOlt === "energia" ? "diag-atencao" : e.causaOlt === "fibra" ? "diag-problema" : "diag-info"}">OLT: ${esc(e.causaOlt === "energia" ? "falta de energia" : e.causaOlt === "fibra" ? "perda de fibra" : e.motivoOlt || "outro")}</span>` : ""}
            <div class="muted" style="font-size:12px">${esc(e.causaOlt === "energia" ? "Confirmado pela OLT (dying gasp): a ONU ficou sem energia." : e.causaOlt === "fibra" ? "Confirmado pela OLT (LOS): a ONU perdeu o sinal da fibra." : dica)}</div></td>
          <td>${e.semContatoMin != null && e.semContatoMin > 10 ? `<b>${durMin(e.semContatoMin)}</b>` : durMin(e.semContatoMin)}</td>
          <td><code style="font-size:12px">${esc(e.eventos)}</code></td></tr>`;
      }).join("")}</tbody></table></div>`
      : `<div class="empty">${r.indisponivel ? "Não foi possível consultar o histórico no servidor do ACS." : "Nenhum reinício registrado (histórico desde 17/11/2026, guarda 45 dias)."}</div>`}
    <p class="muted" style="font-size:12px;margin:10px 0 0">A causa "OLT" vem do dying gasp/LOS lido nas OLTs cadastradas (a cada 10 min). Sem ela, o ACS sozinho não diferencia falta de energia de tirar da tomada.</p>`;
}

// ---------- Sinal e tráfego da ONU (lidos na OLT a cada coleta) ----------
let sinalHoras = 24;
const fmtBps = (b) => (b == null ? "—" : b >= 1e6 ? `${(b / 1e6).toFixed(b >= 1e7 ? 0 : 1)} Mbps` : b >= 1e3 ? `${Math.round(b / 1e3)} kbps` : `${Math.round(b)} bps`);
const fmtDbm = (v) => (v == null ? "—" : `${v.toFixed(2)} dBm`);
const ST_COR = { on: "var(--good)", energia: "#2f6fd6", fibra: "var(--bad)", off: "var(--none)", outro: "var(--none)" };
const ST_NOME = { on: "Online", energia: "Sem energia", fibra: "Sem fibra", off: "Offline", outro: "Offline" };

// Gráfico de linhas em SVG (sem bibliotecas). series: [{ key, nome, cor }]; os buracos (sem leitura) quebram a linha.
function graficoSvg(pts, series, { ini, fim, fmt, zero = false, passoMs }) {
  const W = 640, H = 170, L = 62, R = 10, T = 10, B = 24;
  const vals = pts.flatMap((p) => series.map((s) => p[s.key])).filter((v) => v != null);
  if (!vals.length) return `<div class="graf-vazio">Sem leituras neste período.</div>`;
  let min = Math.min(...vals), max = Math.max(...vals);
  if (zero) min = 0;
  if (max - min < 1e-9) { max += zero ? 1 : 0.5; if (!zero) min -= 0.5; }
  if (zero) {
    // escala "redonda" (1, 2, 2,5 ou 5 × 10^n por divisão)
    const bruto = (max * 1.05) / 4, e = Math.pow(10, Math.floor(Math.log10(bruto))), f = bruto / e;
    max = 4 * e * (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10);
  } else { const pad = (max - min) * 0.1; max += pad; min -= pad; }
  const x = (t) => L + ((Date.parse(t) - ini) / (fim - ini)) * (W - L - R);
  const y = (v) => T + (1 - (v - min) / (max - min)) * (H - T - B);
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const v = min + ((max - min) * i) / 4, yy = y(v);
    g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" class="graf-grade"/><text x="${L - 6}" y="${yy + 4}" text-anchor="end" class="graf-txt">${esc(fmt(v))}</text>`;
  }
  const passoH = fim - ini > 2 * 86400000 ? 24 : fim - ini > 12 * 3600000 ? 4 : 2;
  const d0 = new Date(ini); d0.setMinutes(0, 0, 0);
  for (let t = d0.getTime() + 3600000; t < fim; t += 3600000) {
    const d = new Date(t);
    if (d.getHours() % passoH) continue;
    const xx = L + ((t - ini) / (fim - ini)) * (W - L - R);
    if (xx < L + 18 || xx > W - R - 18) continue; // rótulo cortado na borda
    const rot = passoH === 24 ? d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : `${String(d.getHours()).padStart(2, "0")}:00`;
    g += `<line x1="${xx}" x2="${xx}" y1="${T}" y2="${H - B}" class="graf-grade"/><text x="${xx}" y="${H - 6}" text-anchor="middle" class="graf-txt">${rot}</text>`;
  }
  for (const s of series) {
    let d = "", ant = null;
    for (const p of pts) {
      const v = p[s.key];
      if (v == null) { ant = null; continue; }
      const salto = !ant || Date.parse(p.t) - Date.parse(ant.t) > passoMs * 2.5;
      d += `${salto ? "M" : "L"}${x(p.t).toFixed(1)},${y(v).toFixed(1)}`;
      ant = p;
    }
    // ponto isolado: desenha um círculo para aparecer
    g += `<path d="${d}" fill="none" stroke="${s.cor}" stroke-width="1.8" stroke-linejoin="round"/>`;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], v = p[s.key];
      if (v == null) continue;
      const a = pts[i - 1], b = pts[i + 1];
      const sozinho = (!a || a[s.key] == null || Date.parse(p.t) - Date.parse(a.t) > passoMs * 2.5) && (!b || b[s.key] == null || Date.parse(b.t) - Date.parse(p.t) > passoMs * 2.5);
      if (sozinho) g += `<circle cx="${x(p.t).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.2" fill="${s.cor}"/>`;
    }
  }
  return `<svg viewBox="0 0 ${W} ${H}" class="graf-svg" data-ini="${ini}" data-fim="${fim}" data-l="${L}" data-r="${R}" data-w="${W}">${g}
    <line class="graf-cursor" x1="0" x2="0" y1="${T}" y2="${H - B}" style="display:none"/></svg>`;
}

// Faixa de estado (online / sem energia / sem fibra / offline); sem leitura = listrado
function faixaEstado(pts, ini, fim, passoMs) {
  const W = 640, L = 62, R = 10;
  const x = (t) => L + ((t - ini) / (fim - ini)) * (W - L - R);
  let g = `<rect x="${L}" y="0" width="${W - L - R}" height="12" fill="url(#hach)"/>`;
  for (let i = 0; i < pts.length; i++) {
    const t = Date.parse(pts[i].t), prox = pts[i + 1] ? Date.parse(pts[i + 1].t) : Math.min(t + passoMs, Date.now());
    const ate = Math.min(prox, t + passoMs * 1.5);
    g += `<rect x="${x(t).toFixed(1)}" y="0" width="${(Math.max(x(ate) - x(t), 1) + 0.6).toFixed(1)}" height="12" fill="${ST_COR[pts[i].st] || ST_COR.off}"/>`;
  }
  return `<svg viewBox="0 0 ${W} 12" class="graf-faixa"><defs><pattern id="hach" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#eef1f6"/><line x1="0" y1="0" x2="0" y2="6" stroke="#c9cfda" stroke-width="2"/></pattern></defs>${g}</svg>`;
}

async function loadSinal(id) {
  const card = $("#sinal-card");
  if (!card) return;
  let r;
  try { r = await api(`/devices/${enc(id)}/sinal?horas=${sinalHoras}`); } catch (e) { r = { erro: e.message, pontos: [] }; }
  if (!$("#sinal-card")) return;
  const pts = r.pontos || [];
  const fim = Date.now(), ini = fim - sinalHoras * 3600000, passoMs = (r.intervaloMin || 10) * 60000;
  const ult = (k) => { for (let i = pts.length - 1; i >= 0; i--) if (pts[i][k] != null) return pts[i][k]; return null; };
  const maxDe = (k) => { const v = pts.map((p) => p[k]).filter((x) => x != null); return v.length ? Math.max(...v) : null; };
  const minDe = (k) => { const v = pts.map((p) => p[k]).filter((x) => x != null); return v.length ? Math.min(...v) : null; };
  const ladoTxt = r.lado === "onu" ? "Sinal recebido pela ONU (RX 1490 nm)" : "Sinal da ONU recebido na OLT (RX 1310 nm)";
  const periodo = `<div class="graf-periodo">${[24, 72, 168].map((h) => `<button class="btn sm${h === sinalHoras ? " primary" : ""}" data-horas="${h}">${h === 168 ? "7 dias" : h === 72 ? "3 dias" : "24 h"}</button>`).join("")}</div>`;
  if (!r.onu) {
    card.innerHTML = `<div class="card-head"><h2>Tráfego e sinal</h2></div>
      <div class="muted" style="font-size:12.5px">${r.erro ? esc(r.erro) : "ONU não encontrada nas OLTs cadastradas: sem gráfico de sinal e tráfego."}</div>`;
    return;
  }
  const trafego = r.temTrafego ? `
    <div class="graf-box"><div class="graf-titulo">Tráfego</div>
      ${graficoSvg(pts, [{ key: "down", nome: "Download", cor: "#2f6fd6" }, { key: "up", nome: "Upload", cor: "#e8890c" }], { ini, fim, fmt: fmtBps, zero: true, passoMs })}
      <div class="graf-leg"><span><i style="background:#2f6fd6"></i>Download · atual <b>${fmtBps(ult("down"))}</b> · máximo ${fmtBps(maxDe("down"))}</span>
        <span><i style="background:#e8890c"></i>Upload · atual <b>${fmtBps(ult("up"))}</b> · máximo ${fmtBps(maxDe("up"))}</span></div></div>`
    : `<div class="graf-box"><div class="graf-titulo">Tráfego</div><div class="graf-vazio">A OLT ${esc(r.onu.tipoNome || "")} não informa o tráfego por ONU.</div></div>`;
  card.innerHTML = `
    <div class="card-head"><h2>Tráfego e sinal</h2><span class="muted">OLT ${esc(r.onu.olt)} · ONU <code>${esc(r.onu.index)}</code> · leitura a cada ${r.intervaloMin || 10} min</span>${periodo}</div>
    <div class="graf-grid">
      ${trafego}
      <div class="graf-box"><div class="graf-titulo">Sinal e estado</div>
        ${graficoSvg(pts, [{ key: "rx", nome: "RX", cor: "#7a4fd6" }], { ini, fim, fmt: (v) => v.toFixed(1).replace("-", "−"), passoMs })}
        ${faixaEstado(pts, ini, fim, passoMs)}
        <div class="graf-leg"><span><i style="background:#7a4fd6"></i>${ladoTxt} · atual <b>${fmtDbm(ult("rx"))}</b> · melhor ${fmtDbm(maxDe("rx"))} · pior ${fmtDbm(minDe("rx"))}</span></div>
        <div class="graf-leg">${["on", "energia", "fibra", "off"].map((k) => `<span><i style="background:${ST_COR[k]}"></i>${ST_NOME[k]}</span>`).join("")}<span><i class="hach"></i>Sem leitura</span></div>
      </div>
    </div>
    <p class="muted" style="font-size:12px;margin:10px 0 0">${pts.length ? "Tráfego = média de cada intervalo de 10 min (picos curtos ficam menores que o real)." : "O histórico começa a ser gravado agora: o primeiro ponto aparece na próxima leitura da OLT (até 10 min)."} Guardado por 7 dias.</p>`;
  card.querySelectorAll("[data-horas]").forEach((b) => b.addEventListener("click", () => { sinalHoras = Number(b.dataset.horas); loadSinal(id); }));
  // Cursor: mostra os valores do ponto mais perto
  card.querySelectorAll(".graf-svg").forEach((svg) => {
    const box = svg.parentElement;
    const dica = document.createElement("div"); dica.className = "graf-dica"; box.appendChild(dica);
    const cur = svg.querySelector(".graf-cursor");
    svg.addEventListener("mousemove", (ev) => {
      const rc = svg.getBoundingClientRect(), W = 640, L = 62, R = 10;
      const px = ((ev.clientX - rc.left) / rc.width) * W;
      const t = ini + ((px - L) / (W - L - R)) * (fim - ini);
      let best = null;
      for (const p of pts) if (!best || Math.abs(Date.parse(p.t) - t) < Math.abs(Date.parse(best.t) - t)) best = p;
      if (!best || Math.abs(Date.parse(best.t) - t) > passoMs * 1.5) { dica.style.display = "none"; cur.style.display = "none"; return; }
      const bx = L + ((Date.parse(best.t) - ini) / (fim - ini)) * (W - L - R);
      cur.setAttribute("x1", bx); cur.setAttribute("x2", bx); cur.style.display = "";
      dica.innerHTML = `<b>${esc(new Date(best.t).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }))}</b><br>
        ${r.temTrafego ? `Download ${fmtBps(best.down)} · Upload ${fmtBps(best.up)}<br>` : ""}RX ${fmtDbm(best.rx)} · ${ST_NOME[best.st] || best.st}`;
      dica.style.display = "block";
      const left = (bx / W) * rc.width;
      dica.style.left = `${Math.min(Math.max(left - 90, 0), rc.width - 180)}px`;
    });
    svg.addEventListener("mouseleave", () => { dica.style.display = "none"; cur.style.display = "none"; });
  });
}

// ---------- Firmware: arquivos por modelo e atualização ----------
const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB");

// Envia o arquivo com barra de progresso no quadro central
// Placa de hardware = primeira palavra do HardwareVersion (ex.: "XX530vV2 v2.0 00000000" -> "XX530vV2")
const hwBoard = (hw) => String(hw || "").trim().split(/\s+/)[0] || "";

function uploadFirmware(file, model, hardware, version) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const qs = new URLSearchParams({ model, hardware, version, filename: file.name });
    xhr.open("POST", "/api/firmware/upload?" + qs);
    xhr.setRequestHeader("X-Requested-With", "portal");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    showLoading("Enviando firmware… 0%");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) $("#overlay-msg").textContent = `Enviando firmware… ${Math.round((e.loaded / e.total) * 100)}%`;
    };
    xhr.onload = () => {
      hideLoading();
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 401) { location.href = "/login.html"; return; }
      xhr.status < 300 ? resolve(data) : reject(new Error(data.error || "Falha no envio (HTTP " + xhr.status + ")"));
    };
    xhr.onerror = () => { hideLoading(); reject(new Error("Falha de conexão no envio")); };
    xhr.send(file);
  });
}

async function pageFirmware() {
  const { files, models, hardware, maxMb } = await api("/firmware");
  const folders = {};
  for (const m of models) folders[m] = [];
  for (const f of files) (folders[f.model] = folders[f.model] || []).push(f);
  const boards = [...new Set(hardware.map((h) => h.hardware).filter((h) => h !== "?"))].sort();
  const boardsOf = (m) => hardware.filter((h) => h.model === m);
  view.innerHTML = `
    <div class="page-head"><h1>Firmware</h1><span class="muted">${files.length} arquivo(s) no servidor do GenieACS</span></div>
    <div class="card" style="margin-bottom:16px">
      <h2>Enviar firmware</h2>
      <form id="fw-form" class="fw-form">
        <label>Modelo (pasta)
          <input id="fw-model" list="fw-models" required placeholder="ex.: XX530v" value="${esc(models[0] || "")}">
          <datalist id="fw-models">${models.map((m) => `<option value="${esc(m)}">`).join("")}</datalist></label>
        <label>Hardware(s) aceito(s)
          <input id="fw-hw" list="fw-hws" required placeholder="ex.: XX530vV2, XX530v" pattern="[A-Za-z0-9._\\-]{1,40}( *[,;] *[A-Za-z0-9._\\-]{1,40})*">
          <datalist id="fw-hws">${boards.map((h) => `<option value="${esc(h)}">`).join("")}</datalist></label>
        <label>Versão<input id="fw-version" required placeholder="ex.: 0.5.0 Build 251104"></label>
        <label>Arquivo (até ${maxMb} MB)<input id="fw-file" type="file" required accept=".bin,.img,.w,.fw,.tar,.gz,.zip"></label>
        <button class="btn primary" type="submit">Enviar</button>
      </form>
      <p class="muted" style="margin:10px 0 0">Use só o firmware oficial do fabricante. Informe os hardwares (primeira palavra do campo
        "Hardware" do equipamento) que aceitam o arquivo, separados por vírgula. O portal só oferece o arquivo a esses equipamentos.
        O texto do hardware vem do firmware: o XX530v no 0.2.0 informa <b>XX530v</b> e passa a informar <b>XX530vV2</b> depois de
        atualizado, então os arquivos XX530vV2v2 valem para <b>XX530vV2, XX530v</b>.</p>
    </div>
    ${Object.keys(folders).sort().map((m) => `
      <div class="card" style="margin-bottom:12px">
        <div class="card-head"><h2>📁 ${esc(m)}</h2><span class="muted">${folders[m].length} arquivo(s)</span></div>
        ${boardsOf(m).length ? `<p class="muted" style="margin:0 0 10px">Equipamentos por hardware: ${boardsOf(m).map((h) =>
          `<b>${esc(h.hardware)}</b> ${h.count} (${Object.entries(h.versions).sort((a, b) => b[1] - a[1]).map(([v, n]) => `${esc(v.split(" ")[0])}: ${n}`).join(", ")})`).join(" · ")}</p>` : ""}
        ${folders[m].length ? `<div class="table-wrap"><table>
          <thead><tr><th>Arquivo</th><th>Hardware</th><th>Versão</th><th>Tamanho</th><th>Enviado</th><th></th></tr></thead>
          <tbody>${folders[m].map((f) => `<tr>
            <td><code>${esc(f.name.replace(/^[^/]*\//, ""))}</code></td>
            <td>${f.hardware.length ? esc(f.hardware.join(", ")) : `<span style="color:var(--bad)">não informado</span>`}</td>
            <td>${esc(f.version || "—")}</td>
            <td>${fmtSize(f.size)}</td><td title="${esc(fmtDate(f.uploadedAt))}">${timeAgo(f.uploadedAt)}</td>
            <td style="white-space:nowrap"><button class="btn sm" data-fw-meta="${esc(f.name)}">Hardware / versão</button>
              <button class="btn sm danger" data-fw-del="${esc(f.name)}">Apagar</button></td></tr>`).join("")}</tbody>
        </table></div>` : `<div class="empty">Nenhum firmware para este modelo.</div>`}
      </div>`).join("")}`;

  $("#fw-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = $("#fw-file").files[0];
    if (!file) return;
    if (file.size > maxMb * 1048576) return toast(`Arquivo maior que ${maxMb} MB.`, true);
    try {
      await uploadFirmware(file, $("#fw-model").value.trim(), $("#fw-hw").value.trim(), $("#fw-version").value.trim());
      toast("Firmware enviado ao servidor.");
      route(true);
    } catch (ex) { toast(ex.message, true); }
  });
  view.querySelectorAll("[data-fw-meta]").forEach((b) => b.addEventListener("click", async () => {
    const f = files.find((x) => x.name === b.dataset.fwMeta);
    if (!f) return;
    const opts = boardsOf(f.model).map((h) => h.hardware).filter((h) => h !== "?").join(", ");
    const hw = prompt(`Hardwares que aceitam este firmware, separados por vírgula:\n${f.name}\n\nHardwares do modelo ${f.model}: ${opts || "—"}`, f.hardware.join(", "));
    if (hw === null) return;
    const version = prompt("Versão do firmware (como aparece no equipamento depois de atualizado):", f.version || "");
    if (version === null) return;
    try {
      await api("/firmware/meta", { method: "POST", body: { name: f.name, hardware: hw.trim(), version: version.trim() }, loading: "Salvando…" });
      toast("Firmware atualizado.");
      route(true);
    } catch (e) { toast(e.message, true); }
  }));
  view.querySelectorAll("[data-fw-del]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm(`Apagar o firmware ${b.dataset.fwDel} do servidor?`)) return;
    try {
      await api("/firmware/" + enc(b.dataset.fwDel), { method: "DELETE", loading: "Apagando firmware…" });
      toast("Firmware apagado.");
      route(true);
    } catch (e) { toast(e.message, true); }
  }));
}

// "0.6.0 3.1.10 v60dc.0 Build 251231 Rel.46203n" -> { ver: [0,6,0], line: "3.1.10", build: "251231" }
function fwParse(v) {
  const s = String(v || "").replace(/^V\d+\s+/i, "");
  const p = s.split(/\s+/);
  return {
    ver: (p[0] || "").split(".").map(Number),
    line: /^\d+\.\d+\.\d+$/.test(p[1] || "") ? p[1] : "",
    build: (s.match(/Build\s+(\d+)/i) || [])[1] || "",
  };
}
const fwCmp = (a, b) => { for (let i = 0; i < 3; i++) { const x = (a[i] || 0) - (b[i] || 0); if (x) return x; } return 0; };

// Janela de escolha do firmware (lista com versão, linha, tamanho e avisos). Resolve com o arquivo ou null.
function pickFirmware(d, files) {
  const cur = fwParse(d.software);
  const items = files
    .map((f) => ({ f, p: fwParse(f.version) }))
    .sort((a, b) => fwCmp(b.p.ver, a.p.ver));
  const newest = items.length ? items[0].f : null;
  const info = (it) => {
    const same = it.p.build && it.p.build === cur.build && fwCmp(it.p.ver, cur.ver) === 0;
    const older = !same && fwCmp(it.p.ver, cur.ver) < 0;
    const otherLine = !same && cur.line && it.p.line && it.p.line !== cur.line;
    return { same, older, otherLine };
  };
  // Sugestão: a mais nova da mesma linha do equipamento; senão a mais nova
  const sameLine = items.find((it) => { const i = info(it); return !i.same && !i.older && !i.otherLine; });
  const suggested = (sameLine || items.find((it) => !info(it).same) || {}).f;

  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "fw-dialog";
    dlg.innerHTML = `
      <form method="dialog">
        <h2>Atualizar firmware</h2>
        <p class="muted" style="margin:0 0 14px">${esc(d.ssid || d.serial)} · ${esc(d.model)}</p>
        <dl class="kv fw-cur">
          <dt>Firmware atual</dt><dd><b>${esc(d.software || "?")}</b></dd>
          <dt>Hardware</dt><dd>${esc(d.hardware || "?")}</dd>
        </dl>
        <div class="fw-list" role="radiogroup" aria-label="Firmware">
          ${items.map((it, i) => {
            const n = info(it);
            const tags = [
              n.same ? `<span class="fw-tag">instalada</span>` : "",
              it.f === newest && !n.same ? `<span class="fw-tag good">mais nova</span>` : "",
              it.f === suggested ? `<span class="fw-tag brand">sugerida</span>` : "",
              n.older ? `<span class="fw-tag warn">mais antiga</span>` : "",
              n.otherLine ? `<span class="fw-tag warn">outra linha (${esc(it.p.line)})</span>` : "",
            ].join("");
            return `<label class="fw-item${n.same ? " disabled" : ""}">
              <input type="radio" name="fw" value="${i}" ${n.same ? "disabled" : ""} ${it.f === suggested ? "checked" : ""}>
              <span class="fw-body">
                <span class="fw-ver">${esc(it.f.version || "?")}</span>
                <span class="fw-tags">${tags}</span>
                <span class="fw-file">${esc(it.f.name.replace(/^[^/]*\//, ""))} <span class="fw-size">· ${fmtSize(it.f.size)}</span></span>
                ${n.otherLine ? `<span class="fw-note">Saltos para outra linha podem ser recusados (a 0.2.0 recusou a 0.8.0 3.2.2 e aceitou a 0.6.0 3.1.10). Se recusar, atualize antes para a mais nova da linha ${esc(cur.line)}.</span>` : ""}
              </span>
            </label>`;
          }).join("")}
        </div>
        <ul class="fw-warn">
          <li>O roteador baixa o arquivo, grava e reinicia: o cliente fica alguns minutos sem internet.</li>
          <li>Não desligue nem reinicie durante a atualização (o Reiniciar fica bloqueado por 10 min).</li>
          <li>Confira depois se o login IPoE no ${esc(SISTEMA)}/BNG continua funcionando (a atualização pode trocar o MAC).</li>
          <li>Se o roteador recusar o arquivo, o portal não repete sozinho.</li>
        </ul>
        <div class="fw-actions">
          <button class="btn" value="cancel" type="submit">Cancelar</button>
          <button class="btn primary" value="ok" type="submit" id="fw-ok">Atualizar</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
    const okBtn = dlg.querySelector("#fw-ok");
    const sync = () => { okBtn.disabled = !dlg.querySelector("input[name=fw]:checked"); };
    dlg.addEventListener("change", sync);
    sync();
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close("cancel"); });
    dlg.addEventListener("close", () => {
      const sel = dlg.querySelector("input[name=fw]:checked");
      const f = dlg.returnValue === "ok" && sel ? items[Number(sel.value)].f : null;
      dlg.remove();
      resolve(f);
    });
    dlg.showModal();
  });
}

// Botão "Atualizar firmware" na página do dispositivo
function bindFirmwareUpgrade(id, d) {
  const btn = $("#fw-upgrade");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    let all;
    try { all = (await api("/firmware")).files.filter((f) => f.model === d.model); } catch (e) { return toast(e.message, true); }
    if (!all.length) return toast(`Não há firmware na pasta ${d.model}. Envie em Firmware.`, true);
    const board = hwBoard(d.hardware);
    if (!board) return toast("Não foi possível ler o hardware deste equipamento. Clique em \"Atualizar agora\" e tente de novo.", true);
    // Só arquivos que aceitam este hardware: firmware de outra linha o roteador recusa (9010)
    const files = all.filter((f) => f.hardware.includes(board));
    if (!files.length) {
      const outros = [...new Set(all.flatMap((f) => (f.hardware.length ? f.hardware : ["não informado"])))].join(", ");
      return toast(`Não há firmware para o hardware ${board} (${d.hardware}). Os arquivos da pasta ${d.model} são do hardware: ${outros}. Envie o firmware certo em Firmware.`, true);
    }
    const f = await pickFirmware(d, files);
    if (!f) return;
    try {
      const r = await api(`/devices/${enc(id)}/firmware`, { method: "POST", body: { file: f.name }, loading: "Enviando comando de atualização…" });
      toast(r.done ? "Atualização iniciada: o roteador vai baixar o firmware e reiniciar. Acompanhe o resultado ao lado da versão."
        : "Equipamento não respondeu agora; a atualização fica na fila até o próximo inform.");
      setTimeout(() => route(true), 2500);
    } catch (e) { toast(e.message, true); }
  });
}

// Linha com o resultado da última atualização de firmware (ao lado da versão)
function fwJobLine(j) {
  if (!j || !j.status) return "";
  const quando = timeAgo(j.updatedAt || j.at);
  if (j.status === "enviado") return `<div class="muted" style="margin-top:4px">⏳ Atualização para ${esc(j.to || "?")} enviada ${timeAgo(j.at)} por ${esc(j.user || "")}</div>`;
  if (j.status === "concluido") return `<div style="margin-top:4px;color:var(--good)">✅ Atualizado de ${esc(j.from || "?")} para ${esc(j.result || j.to || "?")} (${quando})</div>`;
  if (j.status === "recusado") return `<div style="margin-top:4px;color:var(--bad)">✕ O roteador recusou o firmware ${esc(j.to || "")} (${esc(j.code || "")}${j.message ? " " + esc(j.message) : ""}, ${quando}). Não será repetido automaticamente.</div>`;
  return "";
}

async function pageFaults() {
  const faults = await api("/faults");
  view.innerHTML = `
    <div class="page-head"><h1>Falhas</h1><span class="muted">${faults.length} ativa(s)</span></div>
    <div class="card">${faults.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Dispositivo</th><th>Canal</th><th>Código</th><th>Mensagem</th><th>Tentativas</th><th>Quando</th><th></th></tr></thead>
      <tbody>${faults.map((f) => `<tr>
        <td><a href="#/device/${enc(f.device)}">${esc(f.deviceName || f.device)}</a></td>
        <td>${esc(f.channel)}</td><td><span class="badge bad">${esc(f.code)}</span></td>
        <td class="wrap">${esc(f.message)}</td><td>${esc(f.retries)}</td>
        <td title="${esc(fmtDate(f.timestamp))}">${timeAgo(f.timestamp)}</td>
        <td><button class="btn sm" data-fault="${esc(f._id)}">Limpar</button></td></tr>`).join("")}</tbody>
    </table></div>` : `<div class="empty">Nenhuma falha ativa. 🎉</div>`}</div>`;
  view.querySelectorAll("[data-fault]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Limpar esta falha? O GenieACS tenta executar de novo no próximo inform.")) return;
    try {
      await api("/faults/" + enc(b.dataset.fault), { method: "DELETE", loading: "Limpando falha…" });
      toast("Falha limpa.");
      route(true);
    } catch (e) { toast(e.message, true); }
  }));
}

async function pageProvisions() {
  const list = await api("/provisions");
  view.innerHTML = `<div class="page-head"><h1>Provisions</h1><span class="muted">somente leitura</span></div>
    ${list.map((p) => `<div class="card" style="margin-bottom:12px"><details><summary>${esc(p._id)}</summary><pre class="script">${esc(p.script)}</pre></details></div>`).join("")}`;
}

async function pageVirtualParameters() {
  const list = await api("/virtual_parameters");
  view.innerHTML = `<div class="page-head"><h1>Virtual Parameters</h1><span class="muted">somente leitura</span></div>
    ${list.map((p) => `<div class="card" style="margin-bottom:12px"><details><summary>${esc(p._id)}</summary><pre class="script">${esc(p.script)}</pre></details></div>`).join("")}`;
}

async function pagePresets() {
  const list = await api("/presets");
  view.innerHTML = `<div class="page-head"><h1>Presets</h1><span class="muted">somente leitura</span></div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Nome</th><th>Canal</th><th>Eventos</th><th>Condição</th><th>Provisions</th></tr></thead>
      <tbody>${list.map((p) => `<tr>
        <td><b>${esc(p._id)}</b></td><td>${esc(p.channel || "")}</td>
        <td>${esc(Object.keys(p.events || {}).join(", ") || "todos")}</td>
        <td class="wrap"><code>${esc(p.precondition || "—")}</code></td>
        <td>${esc((p.configurations || []).map((c) => c.name).join(", "))}</td></tr>`).join("")}</tbody>
    </table></div></div>`;
}

// ---------- Backups ----------
const BK_TIPOS = { diario: "Diário", manual: "Manual", "pre-restauracao": "Antes de restaurar" };

async function pageBackups() {
  const r = await api("/backups");
  if (!r.configurado) {
    view.innerHTML = `<div class="page-head"><h1>Backups</h1></div>
      <div class="card"><div class="empty">Backup não configurado no portal: faltam <code>BACKUP_AGENT_URL</code> e <code>BACKUP_TOKEN</code> no <code>.env</code>.</div></div>`;
    return;
  }
  const list = r.backups || [];
  view.innerHTML = `
    <div class="page-head"><h1>Backups</h1><span class="muted">${list.length} backup(s)</span>
      <button class="btn primary" id="bk-now" style="margin-left:auto" ${r.ocupado ? "disabled" : ""}>Fazer backup agora</button></div>
    <div class="card" style="margin-bottom:16px">
      <p style="margin:0">Backup automático todo dia às 02:00: banco do GenieACS (aparelhos, provisions, presets, firmwares),
        configuração do servidor e dados do portal (Wi-Fi guardado, firmwares, fotos). Os arquivos são criptografados.</p>
      <p class="muted" style="margin:8px 0 0">Destino: <b>${esc(r.destino || "não configurado (só cópia local no servidor do ACS)")}</b>
        ${r.erroDestino ? `<br><span style="color:var(--bad)">Erro ao listar o destino: ${esc(r.erroDestino)}</span>` : ""}
        ${r.ocupado ? `<br><b>Em andamento: ${esc(r.ocupado)}…</b>` : ""}</p>
    </div>
    <div class="card">${list.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Data</th><th>Tipo</th><th>Onde</th><th>Tamanho</th><th></th></tr></thead>
      <tbody>${list.map((b) => `<tr>
        <td>${esc(b.data)}</td><td>${esc(BK_TIPOS[b.tipo] || b.tipo)}</td>
        <td>${[b.remoto ? "FTP" : "", b.local ? "servidor do ACS" : ""].filter(Boolean).join(" + ")}</td>
        <td>${b.size ? fmtSize(b.size) : "—"}</td>
        <td><button class="btn sm" data-bk-restore="${esc(b.name)}">Restaurar…</button></td></tr>`).join("")}</tbody>
    </table></div>` : `<div class="empty">Nenhum backup ainda.</div>`}</div>`;

  $("#bk-now").addEventListener("click", async () => {
    try {
      const b = await api("/backups", { method: "POST", loading: "Fazendo backup… (pode levar alguns minutos)" });
      toast(b.enviado ? `Backup feito e enviado ao FTP (${fmtSize(b.size)}).` : `Backup feito só no servidor do ACS. ${(b.avisos || []).join(" ")}`, !b.enviado);
      route(true);
    } catch (e) { toast(e.message, true); }
  });
  view.querySelectorAll("[data-bk-restore]").forEach((btn) => btn.addEventListener("click", () => restoreDialog(list.find((b) => b.name === btn.dataset.bkRestore))));
}

async function restoreDialog(b) {
  let devs = [];
  try { devs = await api("/devices"); } catch {}
  const dlg = document.createElement("dialog");
  dlg.className = "fw-dialog";
  const opt = (v, titulo, texto, checked = false) => `<label class="fw-item"><input type="radio" name="esc" value="${v}" ${checked ? "checked" : ""}>
    <span class="fw-body"><span class="fw-ver">${titulo}</span><span class="muted" style="font-size:13px">${texto}</span></span></label>`;
  dlg.innerHTML = `<form method="dialog">
    <h2>Restaurar backup</h2>
    <p class="muted" style="margin:0 0 14px">${esc(b.data)} · ${esc(BK_TIPOS[b.tipo] || b.tipo)}</p>
    <div class="fw-list">
      ${opt("aparelho", "Um aparelho", "Volta os dados de um aparelho no ACS (ex.: removido por engano). Não mexe no roteador.", true)}
      ${opt("config", "Configuração do ACS", "Provisions, presets, virtual parameters, firmwares e usuários do painel do GenieACS. Aparelhos não mudam.")}
      ${opt("portal", "Dados do portal", "Wi-Fi guardado, histórico e hardwares dos firmwares, fotos dos modelos. O portal reinicia.")}
      ${opt("tudo", "Tudo do ACS", "Substitui o banco inteiro do GenieACS pelo do backup. Mudanças feitas depois do backup se perdem.")}
    </div>
    <div id="rs-dev" style="margin-top:12px">
      <label style="display:flex;flex-direction:column;gap:4px;font-size:13px">ID do aparelho no ACS
        <input id="rs-id" list="rs-ids" placeholder="ex.: 0CEF15-XX530v-V256010000721" style="width:100%"></label>
      <datalist id="rs-ids">${devs.map((d) => `<option value="${esc(d.id)}">${esc(d.ssid || d.serial)}</option>`).join("")}</datalist>
    </div>
    <label id="rs-users" style="display:none;margin-top:12px;font-size:13px"><input type="checkbox" id="rs-users-cb"> Restaurar também os usuários e senhas do portal</label>
    <p class="muted" style="font-size:12.5px;margin:14px 0 6px">Antes de restaurar no ACS é feito um backup automático do estado atual ("Antes de restaurar").</p>
    <label style="display:flex;flex-direction:column;gap:4px;font-size:13px">Digite <b>RESTAURAR</b> para confirmar
      <input id="rs-conf" autocomplete="off" style="width:100%"></label>
    <div class="fw-actions">
      <button class="btn" value="cancel" type="submit">Cancelar</button>
      <button class="btn primary" value="ok" type="submit" id="rs-ok" disabled>Restaurar</button>
    </div></form>`;
  document.body.appendChild(dlg);
  const esc_ = () => dlg.querySelector("input[name=esc]:checked").value;
  const sync = () => {
    const e = esc_();
    dlg.querySelector("#rs-dev").style.display = e === "aparelho" ? "" : "none";
    dlg.querySelector("#rs-users").style.display = e === "portal" ? "block" : "none";
    dlg.querySelector("#rs-ok").disabled = dlg.querySelector("#rs-conf").value.trim().toUpperCase() !== "RESTAURAR"
      || (e === "aparelho" && !dlg.querySelector("#rs-id").value.trim());
  };
  dlg.addEventListener("input", sync);
  dlg.addEventListener("change", sync);
  sync();
  dlg.addEventListener("close", async () => {
    const body = {
      name: b.name, escopo: esc_(), aparelho: dlg.querySelector("#rs-id").value.trim(),
      incluirUsuarios: dlg.querySelector("#rs-users-cb").checked, confirmacao: dlg.querySelector("#rs-conf").value,
    };
    const ok = dlg.returnValue === "ok";
    dlg.remove();
    if (!ok) return;
    try {
      const r = await api("/backups/restore", { method: "POST", body, loading: "Restaurando… (pode levar alguns minutos)" });
      if (r.escopo === "portal") {
        toast(`Dados do portal restaurados (${r.gravados.length} arquivo(s)). O portal está reiniciando…`);
        setTimeout(() => location.reload(), 7000);
      } else {
        toast(r.escopo === "aparelho" ? `Aparelho ${r.aparelho} restaurado.` : "Restauração concluída. Os serviços do ACS foram reiniciados.");
        route(true);
      }
    } catch (e) { toast(e.message, true); }
  });
  dlg.showModal();
}

// ---------- OLTs: cadastro e teste de conexão ----------
async function pageOlts() {
  const { olts, tipos, coleta } = await api("/olts");
  const col = (id) => {
    const c = ((coleta || {}).coletas || {})[id];
    if (!c) return `<span class="muted">ainda não lida</span>`;
    if (!c.ok) return `<span class="badge bad">erro</span> <span class="muted">${esc(c.erro || "")}</span>`;
    return `${c.onus} ONUs · <b style="color:var(--good)">${c.online}</b> online<br><span class="muted">offline: ${c.energia} sem energia · ${c.fibra} sem fibra · ${c.onus - c.online - c.energia - c.fibra} outros</span>
      ${c.offsetMin && Math.abs(c.offsetMin) > 5 ? `<br><span style="color:var(--warn);font-size:12px">relógio da OLT ${c.offsetMin > 0 ? "adiantado" : "atrasado"} ${Math.round(Math.abs(c.offsetMin) / 60)} h (corrigido)</span>` : ""}
      <div class="muted" style="font-size:11.5px">${timeAgo(c.em)}${c.via ? ` · via ${c.via === "snmp" ? "SNMP" : "Telnet"}` : ""}${c.segundos != null ? ` em ${c.segundos} s` : ""}</div>
      ${c.snmpErro ? `<div style="color:var(--warn);font-size:11.5px">SNMP falhou, lida pelo Telnet: ${esc(c.snmpErro)}</div>` : ""}`;
  };
  const teste = (t) => !t ? `<span class="muted">não testada</span>` : `
    <div>${t.snmp && t.snmp.ok ? `<span class="badge good">SNMP ok</span> <span class="muted">${esc(t.snmp.nome || "")}</span>` : `<span class="badge bad">SNMP</span> <span class="muted">${esc((t.snmp || {}).erro || "")}</span>`}</div>
    <div style="margin-top:4px">${t.telnet && t.telnet.ok ? `<span class="badge good">Telnet ok</span> <span class="muted"><code>${esc(t.telnet.prompt)}</code></span>${t.telnet.enable ? ` <span class="badge ${t.telnet.enable === "ok" ? "good" : "bad"}">enable ${t.telnet.enable === "ok" ? "ok" : ""}</span>${t.telnet.enable !== "ok" ? ` <span class="muted">${esc(t.telnet.enable)}</span>` : ""}` : ""}` : `<span class="badge bad">Telnet</span> <span class="muted">${esc((t.telnet || {}).erro || "")}</span>`}</div>
    <div class="muted" style="font-size:11.5px">${timeAgo(t.em)}</div>`;
  view.innerHTML = `
    <div class="page-head"><h1>OLTs</h1><span class="muted">${olts.length} cadastrada(s)</span>
      <button class="btn" id="olt-coletar" style="margin-left:auto">Ler ONUs agora</button>
      <button class="btn primary" id="olt-nova">Cadastrar OLT</button></div>
    <div class="card" style="margin-bottom:16px"><p style="margin:0">As OLTs cadastradas aqui serão lidas pelo portal (SNMP e Telnet, só leitura) para trazer os alarmes de
      <b>dying gasp</b> (falta de energia na ONU) e <b>LOS</b> (perda de fibra). Senha e community ficam criptografadas no servidor e não aparecem na tela.</p></div>
    <div class="card">${olts.length ? `<div class="table-wrap"><table>
      <thead><tr><th>OLT</th><th>Tipo</th><th>IP</th><th>SNMP</th><th>Telnet</th><th>Último teste</th><th>ONUs (coleta a cada ${(coleta || {}).intervaloMin || 10} min; ZTE e Nokia por SNMP com Telnet de reserva, V-SOL por Telnet, FiberHome só por SNMP)</th><th></th></tr></thead>
      <tbody>${olts.map((o) => `<tr>
        <td><b>${esc(o.descricao)}</b></td><td>${esc(o.tipoNome)}</td><td><code>${esc(o.ip)}</code></td>
        <td>v${esc(o.snmpVersao)} · porta ${o.snmpPorta}<br><span class="muted">${o.temCommunity ? "community ••••••" : "sem community"}</span></td>
        <td>${esc(o.protocolo === "ssh" ? "SSH" : "Telnet")} · porta ${o.telnetPorta}<br><span class="muted">${esc(o.usuario || "sem usuário")} ${o.temSenha ? "· senha ••••••" : "· sem senha"}${o.temSenhaAdmin ? " · admin ••••••" : ""}</span></td>
        <td>${teste(o.ultimoTeste)}</td>
        <td>${col(o.id)}</td>
        <td style="white-space:nowrap"><button class="btn sm" data-olt-testar="${esc(o.id)}">Testar</button>
          <button class="btn sm" data-olt-editar="${esc(o.id)}">Editar</button>
          <button class="btn sm danger" data-olt-apagar="${esc(o.id)}">Apagar</button></td></tr>`).join("")}</tbody>
    </table></div>` : `<div class="empty">Nenhuma OLT cadastrada.</div>`}</div>`;

  $("#olt-nova").addEventListener("click", () => oltForm(null, tipos));
  $("#olt-coletar").addEventListener("click", async () => {
    try { await api("/olts/coletar", { method: "POST", loading: "Lendo as ONUs nas OLTs (pode levar até 1 min)…" }); toast("Leitura concluída."); route(true); } catch (e) { toast(e.message, true); }
  });
  view.querySelectorAll("[data-olt-editar]").forEach((b) => b.addEventListener("click", () => oltForm(olts.find((o) => o.id === b.dataset.oltEditar), tipos)));
  view.querySelectorAll("[data-olt-testar]").forEach((b) => b.addEventListener("click", async () => {
    try {
      const r = await api(`/olts/${enc(b.dataset.oltTestar)}/testar`, { method: "POST", loading: "Testando SNMP e Telnet na OLT…" });
      toast(`SNMP: ${r.snmp.ok ? "ok" : "falhou"} · Telnet: ${r.telnet.ok ? "ok" : "falhou"}`, !(r.snmp.ok && r.telnet.ok));
      route(true);
    } catch (e) { toast(e.message, true); }
  }));
  view.querySelectorAll("[data-olt-apagar]").forEach((b) => b.addEventListener("click", async () => {
    const o = olts.find((x) => x.id === b.dataset.oltApagar);
    if (!confirm(`Apagar a OLT ${o.descricao} (${o.ip}) do portal?\n\nIsso não mexe na OLT, só remove o cadastro.`)) return;
    try { await api(`/olts/${enc(o.id)}`, { method: "DELETE", loading: "Apagando…" }); toast("OLT removida."); route(true); } catch (e) { toast(e.message, true); }
  }));
}

function oltForm(o, tipos) {
  const dlg = document.createElement("dialog");
  dlg.className = "fw-dialog";
  const v = (k, d = "") => esc(o && o[k] != null ? o[k] : d);
  dlg.innerHTML = `<form method="dialog" class="olt-form">
    <h2>${o ? "Editar OLT" : "Cadastrar OLT"}</h2>
    <label>Descrição<input name="descricao" value="${v("descricao")}" placeholder="ex.: OLT Centro" maxlength="80"></label>
    <label>Tipo<select name="tipo" required>${Object.entries(tipos).map(([k, n]) => `<option value="${k}" ${o && o.tipo === k ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
    <label>IP<input name="ip" value="${v("ip")}" required placeholder="ex.: 10.0.0.2"></label>
    <div class="olt-2">
      <label>Usuário<input name="usuario" value="${v("usuario")}" autocomplete="off"></label>
      <label>Senha<input name="senha" type="password" autocomplete="new-password" placeholder="${o && o.temSenha ? "•••••• (vazio = manter)" : ""}"></label>
    </div>
    <label>Senha Admin <span class="muted" style="font-weight:400">(enable; se vazio, usa a senha de acesso)</span>
      <input name="senhaAdmin" type="password" autocomplete="new-password" placeholder="${o && o.temSenhaAdmin ? "•••••• (vazio = manter)" : ""}"></label>
    <div class="olt-2">
      <label>Telnet/SSH porta<input name="telnetPorta" type="number" min="1" max="65535" value="${v("telnetPorta", 23)}"></label>
      <label>Protocolo<select name="protocolo"><option value="telnet">Telnet</option><option value="ssh" ${o && o.protocolo === "ssh" ? "selected" : ""}>SSH (ainda não suportado)</option></select></label>
    </div>
    <div class="olt-2">
      <label>SNMP versão<select name="snmpVersao"><option value="2c">2c</option><option value="1" ${o && o.snmpVersao === "1" ? "selected" : ""}>1</option></select></label>
      <label>SNMP porta<input name="snmpPorta" type="number" min="1" max="65535" value="${v("snmpPorta", 161)}"></label>
    </div>
    <label>SNMP community<input name="community" type="password" autocomplete="new-password" placeholder="${o && o.temCommunity ? "•••••• (vazio = manter)" : ""}"></label>
    <p class="muted" style="font-size:12.5px;margin:4px 0 0">Prefira um usuário <b>só de leitura</b> na OLT. Senha e community são guardadas criptografadas e não voltam para a tela.
      FiberHome é lida só por SNMP (community obrigatória); ZTE C220 usa SNMP com Telnet de reserva.</p>
    <div class="fw-actions"><button class="btn" value="cancel" type="submit">Cancelar</button><button class="btn primary" value="ok" type="submit">Salvar</button></div>
  </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", async () => {
    const ok = dlg.returnValue === "ok";
    const body = Object.fromEntries(new FormData(dlg.querySelector("form")));
    dlg.remove();
    if (!ok) return;
    if (o) body.id = o.id;
    try {
      const r = await api("/olts", { method: "POST", body, loading: "Salvando…" });
      toast(`OLT ${r.descricao} salva. Use "Testar" para conferir a conexão.`);
      route(true);
    } catch (e) { toast(e.message, true); }
  });
  dlg.showModal();
}

// ---------- Atualizações do sistema (versões marcadas no GitHub; o atualizador instala como root) ----------
// Texto simples das NOVIDADES: "- item" vira lista, **negrito**, `código`
function notasHtml(t) {
  const linhas = String(t || "").split("\n");
  let html = "", lista = false;
  for (const l of linhas) {
    const item = l.match(/^\s*-\s+(.*)$/);
    const fmt = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
    if (item) { if (!lista) { html += "<ul class=\"notas\">"; lista = true; } html += `<li>${fmt(item[1])}`; }
    else if (lista && /^\s+\S/.test(l)) html += " " + fmt(l.trim());
    else { if (lista) { html += "</ul>"; lista = false; } if (l.trim()) html += `<p>${fmt(l)}</p>`; }
  }
  return html + (lista ? "</ul>" : "");
}
const ATU_RESULT = { ok: ["good", "concluída"], erro: ["bad", "falhou, nada mudou"], revertido: ["warn", "falhou, foi desfeita"], rodando: ["warn", "em andamento"] };

async function pageAtualizacoes() {
  let versaoInicial = null;
  const render = async () => {
    let r;
    try { r = await api("/atualizacao"); } catch (e) {
      // O portal reinicia no meio da atualização: segue tentando
      const st = $("#atu-status");
      if (st) st.innerHTML = `<span class="badge warn">portal reiniciando…</span>`;
      return;
    }
    if (versaoInicial === null) versaoInicial = r.versaoPortal;
    // A versão do portal mudou: recarrega para pegar as telas novas
    if (r.versaoPortal !== versaoInicial && !(r.execucao && r.execucao.estado === "rodando")) { location.reload(); return; }
    const x = r.execucao;
    const rodando = !!(x && x.estado === "rodando") || r.pedidoPendente;
    const pode = r.podeAtualizar && r.instalado && !rodando;
    const disp = r.disponiveis || [];
    // ACS em outro servidor: ele segue a versão do portal (confere a cada 2 min) e manda o estado para cá
    const a = r.acsSeparado;
    const ax = a && a.execucao;
    const acsRodando = !!(ax && ax.estado === "rodando" && Date.now() - Date.parse(ax.inicio) < 30 * 60000);
    let acsCard = "";
    if (a) {
      const sumido = Date.now() - Date.parse(a.recebidoEm) > 10 * 60000;
      const atras = /^v\d/.test(r.versao) && a.instalada !== r.versao;
      const badge = acsRodando ? `<span class="badge warn">atualizando…</span>`
        : sumido ? `<span class="badge bad">sem contato há ${esc(timeAgo(a.recebidoEm).replace(/^há /, ""))}</span>`
        : a.seguirFalhou && a.seguirFalhou === r.versao ? `<span class="badge bad">falhou ao instalar ${esc(a.seguirFalhou)}</span>`
        : atras ? `<span class="badge warn">vai se atualizar para ${esc(r.versao)} em até 2 min</span>`
        : `<span class="badge good">mesma versão do portal</span>`;
      acsCard = `<div class="card" style="margin-bottom:16px">
        <div class="card-head"><h2>ACS (servidor ${esc(a.ip || "separado")})</h2>${badge}</div>
        <p class="muted" style="margin:0 0 8px">versão instalada <b>${esc(a.instalada || "?")}</b> · último contato ${timeAgo(a.recebidoEm)}.
          O ACS segue a versão deste portal: depois de atualizar aqui, ele instala a mesma versão sozinho (só avança; para voltar o ACS,
          use <code>globaltech-atualizar voltar</code> no servidor dele).
          ${a.seguirFalhou && a.seguirFalhou === r.versao && !acsRodando ? `<br><span style="color:var(--bad)">A instalação de ${esc(a.seguirFalhou)} no ACS falhou e não será repetida sozinha (o ACS continua em ${esc(a.instalada)}).
            Veja os passos abaixo; para tentar de novo, no servidor do ACS: <code>globaltech-atualizar aplicar ${esc(a.seguirFalhou)}</code></span>` : ""}</p>
        ${ax ? `<p class="muted" style="margin:0 0 6px">Última execução no ACS: ${esc(ax.acao === "voltar" ? "voltar para" : "atualizar para")} <b>${esc(ax.versao || "")}</b>
          · <span class="badge ${(ATU_RESULT[ax.estado] || ["warn"])[0]}">${esc((ATU_RESULT[ax.estado] || [ax.estado])[1])}</span>
          · ${timeAgo(ax.inicio)}${ax.mensagem ? ` · ${esc(ax.mensagem)}` : ""}</p>
          <details${acsRodando || ax.estado === "erro" || ax.estado === "revertido" ? " open" : ""}><summary>Passos no ACS</summary>
          <ol class="atu-passos">${(ax.passos || []).map((p) => `<li>${esc(p.texto)} <span class="muted">${esc(fmtDate(p.em))}</span></li>`).join("")}</ol></details>` : ""}
      </div>`;
    }
    view.innerHTML = `
      <div class="page-head"><h1>Atualizações</h1>
        <span class="muted">versão instalada <b>${esc(r.versao)}</b>${r.canal === "teste" ? ` · <span class="badge warn">servidor de teste</span>` : ""}</span>
        ${r.instalado ? `<button class="btn" id="atu-verificar" style="margin-left:auto" ${rodando ? "disabled" : ""}>Verificar agora</button>` : ""}</div>
      ${!r.instalado ? `<div class="card"><div class="empty">O atualizador não está instalado neste servidor.<br>
          No servidor, como root, dentro da pasta do projeto: <code>bash atualizador/instalar-atualizador.sh</code></div></div>` : `
      <div class="card" style="margin-bottom:16px">
        <p style="margin:0">O sistema é atualizado a partir das versões publicadas no GitHub. Antes de trocar, o servidor confere a versão nova
          (o portal novo é ligado numa porta de teste e a publicação no ACS é simulada). Se algo falhar, volta sozinho para a versão em uso.
          O portal reinicia em cerca de 1 segundo e ninguém é desconectado.</p>
        <p class="muted" style="margin:8px 0 0">Partes neste servidor: ${[r.partes.portal ? "portal" : "", r.partes.acs ? "ACS (provisions, presets, extensões)" : ""].filter(Boolean).join(" + ") || "—"}
          · última consulta ao GitHub ${r.verificadoEm ? timeAgo(r.verificadoEm) : "nunca"}
          ${r.erroVerificacao ? `<br><span style="color:var(--bad)">${esc(r.erroVerificacao)}</span>` : ""}
          ${!r.podeAtualizar ? `<br>Seu usuário pode ver esta página, mas não atualizar (ATUALIZAR_USUARIOS no .env do portal).` : ""}</p>
      </div>
      <div id="atu-status">${x ? `<div class="card" style="margin-bottom:16px">
        <div class="card-head"><h2>Última execução: ${esc(x.acao === "voltar" ? "voltar para" : x.acao === "aplicar" ? "atualizar para" : x.acao)} ${esc(x.versao || "")}</h2>
          <span class="badge ${(ATU_RESULT[x.estado] || ["warn"])[0]}">${esc((ATU_RESULT[x.estado] || [x.estado])[1])}</span></div>
        <p class="muted" style="margin:0 0 8px">de ${esc(x.de || "?")} · pedido por ${esc(x.usuario || "?")} · ${timeAgo(x.inicio)}${x.fim ? ` · terminou ${timeAgo(x.fim)}` : ""}${x.mensagem ? ` · ${esc(x.mensagem)}` : ""}</p>
        <ol class="atu-passos">${(x.passos || []).map((p) => `<li>${esc(p.texto)} <span class="muted">${esc(fmtDate(p.em))}</span></li>`).join("")}</ol>
        ${r.log ? `<details${x.estado === "erro" || x.estado === "revertido" ? " open" : ""}><summary>Registro completo</summary><pre class="atu-log">${esc(r.log)}</pre></details>` : ""}
      </div>` : ""}${r.pedidoPendente && !(x && x.estado === "rodando") ? `<div class="card" style="margin-bottom:16px"><span class="badge warn">pedido enviado, aguardando o atualizador…</span></div>` : ""}</div>
      ${acsCard}
      <div class="card" style="margin-bottom:16px">
        <div class="card-head"><h2>Versões novas</h2></div>
        ${disp.length ? disp.map((d) => `<div class="atu-versao">
          <div class="atu-vhead"><b>${esc(d.versao)}</b> ${d.notas && d.notas.titulo ? `<span>— ${esc(d.notas.titulo)}</span>` : ""}
            ${pode ? `<button class="btn sm primary" data-atu-aplicar="${esc(d.versao)}" style="margin-left:auto">Atualizar para ${esc(d.versao)}</button>` : ""}</div>
          ${d.notas && d.notas.texto ? `<div class="atu-notas">${notasHtml(d.notas.texto)}</div>` : `<div class="muted">Sem notas para esta versão.</div>`}
        </div>`).join("") : `<div class="empty">Nenhuma versão mais nova que a instalada.</div>`}
      </div>
      <div class="card">
        <div class="card-head"><h2>Histórico</h2>
          ${r.anterior && r.anterior !== "dev" && pode ? `<button class="btn sm danger" id="atu-voltar">Voltar para ${esc(r.anterior)}</button>` : ""}</div>
        ${r.historico.length ? `<div class="table-wrap"><table><thead><tr><th>Quando</th><th>O quê</th><th>Quem</th><th>Resultado</th></tr></thead><tbody>
          ${r.historico.map((h) => `<tr><td>${esc(fmtDate(h.em))}</td><td>${esc(h.de || "?")} → <b>${esc(h.para || "")}</b>${h.acao === "voltar" ? " (volta)" : ""}</td>
            <td>${esc(h.usuario || "")}</td><td><span class="badge ${(ATU_RESULT[h.resultado] || ["warn"])[0]}">${esc((ATU_RESULT[h.resultado] || [h.resultado])[1])}</span>
            ${h.mensagem ? `<div class="muted" style="font-size:12px">${esc(h.mensagem)}</div>` : ""}</td></tr>`).join("")}
        </tbody></table></div>` : `<div class="empty">Nenhuma atualização feita por aqui ainda.</div>`}
      </div>`}`;
    const pedir = async (path, body, msg) => {
      try { await api(path, { method: "POST", body, loading: msg }); toast("Pedido enviado ao atualizador."); setTimeout(render, 1500); } catch (e) { toast(e.message, true); }
    };
    const bv = $("#atu-verificar");
    if (bv) bv.addEventListener("click", () => pedir("/atualizacao/verificar", null, "Pedindo a consulta ao GitHub…"));
    view.querySelectorAll("[data-atu-aplicar]").forEach((b) => b.addEventListener("click", () => {
      const v = b.dataset.atuAplicar;
      if (!confirm(`Atualizar o sistema para ${v}?\n\n• O servidor confere a versão nova antes de trocar.\n• O portal reinicia por ~1 segundo (ninguém é desconectado).\n• Se algo falhar, volta sozinho para ${r.versao}.${a ? "\n• Depois, o ACS (outro servidor) instala a mesma versão sozinho em até 2 minutos." : ""}`)) return;
      pedir("/atualizacao/aplicar", { versao: v }, "Pedindo a atualização…");
    }));
    const bb = $("#atu-voltar");
    if (bb) bb.addEventListener("click", () => {
      if (!confirm(`Voltar o sistema para a versão anterior (${r.anterior})?`)) return;
      pedir("/atualizacao/voltar", null, "Pedindo a volta para a versão anterior…");
    });
    // Durante a execução, acompanha ao vivo
    clearInterval(pageTimer);
    // ACS atrás do portal: confere a cada 10 s até ele terminar
    const acsAtras = a && /^v\d/.test(r.versao) && a.instalada !== r.versao && a.seguirFalhou !== r.versao;
    pageTimer = setInterval(render, rodando || acsRodando ? 3000 : acsAtras ? 10000 : 60000);
  };
  await render();
}

// ---------- Roteamento ----------
const ROUTES = {
  atualizacoes: ["atualizacoes", "Atualizações", pageAtualizacoes],
  olts: ["olts", "OLTs", pageOlts],
  backups: ["backups", "Backups", pageBackups],
  "": ["dashboard", "Dashboard", pageDashboard],
  devices: ["devices", "Dispositivos", pageDevices],
  faults: ["faults", "Falhas", pageFaults],
  firmware: ["firmware", "Firmware", pageFirmware],
  provisions: ["provisions", "Provisions", pageProvisions],
  presets: ["presets", "Presets", pagePresets],
  virtual_parameters: ["virtual_parameters", "Virtual Parameters", pageVirtualParameters],
};

async function route(silent = false) {
  clearInterval(pageTimer);
  charts.forEach((c) => c.destroy());
  charts = [];
  const [pathPart, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const params = new URLSearchParams(query);
  const [name, ...rest] = pathPart.split("/");
  let navKey, title, run;
  // Saiu da página do dispositivo no meio de um teste de velocidade: fecha o quadro (o teste segue no servidor)
  if (name !== "device" && speedJob) finishSpeedOverlay();
  if (name === "device" && rest.length) {
    [navKey, title, run] = ["devices", "Dispositivo", () => pageDevice(decodeURIComponent(rest.join("/")))];
  } else {
    [navKey, title, run] = ROUTES[name] || ROUTES[""];
  }
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === navKey));
  $("#page-title").textContent = title;
  $("#sidebar").classList.remove("open");
  if (!navKey.startsWith("dash")) $("#updated").textContent = "";
  if (!silent) view.innerHTML = `<div class="empty">Carregando…</div>`;
  try {
    await run(params);
  } catch (e) {
    view.innerHTML = `<div class="error-box">Erro ao carregar: ${esc(e.message)}</div>`;
  }
}

// Clique em linha de tabela abre o dispositivo
view.addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-dev]");
  if (tr && !e.target.closest("a,button")) location.hash = "#/device/" + enc(tr.dataset.dev);
});

$("#menu").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
// Clique fecha o quadro de resultado (o de "carregando" fica até o comando terminar)
$("#overlay").addEventListener("click", () => { if ($("#overlay-icon").className !== "ov-spinner") closeOverlay(); });
$("#logout").addEventListener("click", async () => {
  await api("/logout", { method: "POST", loading: false }).catch(() => {});
  location.href = "/login.html";
});

// Código do cliente com link para a ficha no sistema de gestão (SGP, Hubsoft...) em nova aba
let CLIENTE_URL = "";
function sgpClienteLink(id) {
  const tag = `<b class="client-id">${esc(id)}</b>`;
  if (!CLIENTE_URL || !/^\d+$/.test(String(id))) return tag;
  return `<a href="${esc(CLIENTE_URL.split("{id}").join(enc(id)))}" target="_blank" rel="noopener noreferrer" title="Abrir o cliente no ${esc(SISTEMA)}">${tag} ↗</a>`;
}

(async () => {
  const me = await api("/me");
  CLIENTE_URL = me.clienteUrl || "";
  SISTEMA = me.sistema || "SGP";
  $("#username").textContent = me.name;
  $("#avatar").textContent = (me.name || "?")[0].toUpperCase();
  window.addEventListener("hashchange", () => route());
  route();
})();
