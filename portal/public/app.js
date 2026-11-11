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
  if (d.tags.includes("ERRO_SGP")) return ["err", "Erro no SGP"];
  return ["wait", "Aguardando"];
}
const provIcon = (d) => { const [k, label] = provState(d); return `<span class="prov ${k}" title="${label}">${PROV_ICONS[k]}</span>`; };
const provBadge = (d) => { const [k, label] = provState(d); return `<span class="prov-badge ${k}">${PROV_ICONS[k]}${label}</span>`; };

const signalBadge = (d) =>
  d.rx === null ? `<span class="muted">—</span>` : `<span class="badge ${d.signal}">${d.rx.toFixed(1)} dBm</span>`;

const tagList = (tags, removable = false) =>
  tags.map((t) => `<span class="tag ${t === "ERRO_SGP" ? "err" : ""}">${esc(t)}${removable ? `<button data-untag="${esc(t)}" title="Remover tag">×</button>` : ""}</span>`).join("");

function doughnut(canvas, labels, data, colors) {
  const c = new Chart(canvas, {
    type: "doughnut",
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: "#fff" }] },
    options: {
      maintainAspectRatio: false,
      cutout: "62%",
      plugins: { legend: { position: "right", labels: { boxWidth: 12, padding: 12 } } },
    },
  });
  charts.push(c);
  return c;
}

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
  const optical = s.signal.good + s.signal.warn + s.signal.bad;
  view.innerHTML = `
    <div class="page-head"><h1>Monitoramento da rede</h1></div>
    <div class="stats">
      <a class="stat blue" href="#/devices"><div><small>Total de dispositivos</small><b>${s.total}</b></div>${ICONS.devices}</a>
      <a class="stat green" href="#/devices?f=online"><div><small>Online</small><b>${s.online}</b></div>${ICONS.online}</a>
      <a class="stat orange" href="#/devices?f=offline"><div><small>Offline</small><b>${s.offline}</b></div>${ICONS.offline}</a>
      <a class="stat red" href="#/faults"><div><small>Falhas ativas</small><b>${s.faults}</b></div>${ICONS.faults}</a>
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h2>Sinal PON (RX)</h2><span class="muted">${optical} ONUs com leitura</span></div>
        <div class="chart-box"><canvas id="c-signal"></canvas></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Modelos</h2><span class="muted">${s.manufacturers.map((m) => `${esc(m.label)} (${m.count})`).join(" · ")}</span></div>
        <div class="chart-box"><canvas id="c-models"></canvas></div>
      </div>
    </div>
    <div class="grid-3">
      <div class="card"><h2>Novos nas últimas 24 h</h2><div class="big-number">${s.registered.day}</div><span class="muted">dispositivos registrados no ACS</span></div>
      <div class="card"><h2>Novos em 7 dias</h2><div class="big-number">${s.registered.week}</div><span class="muted">dispositivos registrados no ACS</span></div>
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

  doughnut($("#c-signal"),
    ["Bom (≥ -24 dBm)", "Atenção (-24 a -27)", "Crítico (< -27 ou > -8)", "Sem leitura"],
    [s.signal.good, s.signal.warn, s.signal.bad, s.signal.none],
    [COLORS.good, COLORS.warn, COLORS.bad, COLORS.none]);
  doughnut($("#c-models"), s.models.map((m) => m.label), s.models.map((m) => m.count), PALETTE);

  pageTimer = setInterval(() => route(true), 60000);
}

const FILTERS = {
  all: ["Todos", () => true],
  online: ["Online", (d) => d.online],
  offline: ["Offline", (d) => !d.online],
  erro_sgp: ["Com ERRO_SGP", (d) => d.tags.includes("ERRO_SGP")],
  noprov: ["Não provisionados", (d) => !d.tags.includes("Provisioned")],
  signal: ["Sinal crítico/atenção", (d) => d.signal === "bad" || d.signal === "warn"],
};

async function pageDevices(params) {
  const list = await api("/devices");
  const state = { q: params.get("q") || "", f: FILTERS[params.get("f")] ? params.get("f") : "all", page: 0, size: 25, sort: "lastInform", dir: -1 };

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
        <td title="${esc(fmtDate(d.lastInform))}">${timeAgo(d.lastInform)}</td><td>${statusBadge(d)}</td>
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
          ${lan.radios.some((r) => r.ref) ? `<button class="btn sm" id="wifi-edit" ${off}>Alterar Wi-Fi</button>` : ""}
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
          toast(r.done ? "Wi-Fi gravado no roteador e cópia guardada." : "Equipamento não respondeu agora; a alteração fica na fila. Cópia guardada.");
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
        <dt>Cliente SGP</dt><dd>${d.sgpCliente ? `${sgpClienteLink(d.sgpCliente)}${d.sgpContrato ? ` <span class="muted">· contrato ${esc(d.sgpContrato)}</span>` : ""}` : `<span class="muted">não vinculado</span>`}</dd>
        <dt>Serial</dt><dd>${esc(d.serial)}</dd>
        <dt>Fabricante / modelo</dt><dd>${esc(d.manufacturer)} ${esc(d.model)}</dd>
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
    ${speedSection(st, d.online)}
    ${lanSection(lan, d.online)}`;

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

// ---------- Firmware: arquivos por modelo e atualização ----------
const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB");

// Envia o arquivo com barra de progresso no quadro central
function uploadFirmware(file, model, version) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const qs = new URLSearchParams({ model, version, filename: file.name });
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
  const { files, models, maxMb } = await api("/firmware");
  const folders = {};
  for (const m of models) folders[m] = [];
  for (const f of files) (folders[f.model] = folders[f.model] || []).push(f);
  view.innerHTML = `
    <div class="page-head"><h1>Firmware</h1><span class="muted">${files.length} arquivo(s) no servidor do GenieACS</span></div>
    <div class="card" style="margin-bottom:16px">
      <h2>Enviar firmware</h2>
      <form id="fw-form" class="fw-form">
        <label>Modelo (pasta)
          <input id="fw-model" list="fw-models" required placeholder="ex.: XX530v" value="${esc(models[0] || "")}">
          <datalist id="fw-models">${models.map((m) => `<option value="${esc(m)}">`).join("")}</datalist></label>
        <label>Versão<input id="fw-version" required placeholder="ex.: 0.5.0 Build 251104"></label>
        <label>Arquivo (até ${maxMb} MB)<input id="fw-file" type="file" required accept=".bin,.img,.w,.fw,.tar,.gz,.zip"></label>
        <button class="btn primary" type="submit">Enviar</button>
      </form>
      <p class="muted" style="margin:10px 0 0">Use só o firmware oficial do fabricante para esse modelo. O modelo precisa ser igual ao do equipamento (coluna "Modelo" em Dispositivos).</p>
    </div>
    ${Object.keys(folders).sort().map((m) => `
      <div class="card" style="margin-bottom:12px">
        <div class="card-head"><h2>📁 ${esc(m)}</h2><span class="muted">${folders[m].length} arquivo(s)</span></div>
        ${folders[m].length ? `<div class="table-wrap"><table>
          <thead><tr><th>Arquivo</th><th>Versão</th><th>Tamanho</th><th>Enviado</th><th></th></tr></thead>
          <tbody>${folders[m].map((f) => `<tr>
            <td><code>${esc(f.name.replace(/^[^/]*\//, ""))}</code></td><td>${esc(f.version || "—")}</td>
            <td>${fmtSize(f.size)}</td><td title="${esc(fmtDate(f.uploadedAt))}">${timeAgo(f.uploadedAt)}</td>
            <td><button class="btn sm danger" data-fw-del="${esc(f.name)}">Apagar</button></td></tr>`).join("")}</tbody>
        </table></div>` : `<div class="empty">Nenhum firmware para este modelo.</div>`}
      </div>`).join("")}`;

  $("#fw-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = $("#fw-file").files[0];
    if (!file) return;
    if (file.size > maxMb * 1048576) return toast(`Arquivo maior que ${maxMb} MB.`, true);
    try {
      await uploadFirmware(file, $("#fw-model").value.trim(), $("#fw-version").value.trim());
      toast("Firmware enviado ao servidor.");
      route(true);
    } catch (ex) { toast(ex.message, true); }
  });
  view.querySelectorAll("[data-fw-del]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm(`Apagar o firmware ${b.dataset.fwDel} do servidor?`)) return;
    try {
      await api("/firmware/" + enc(b.dataset.fwDel), { method: "DELETE", loading: "Apagando firmware…" });
      toast("Firmware apagado.");
      route(true);
    } catch (e) { toast(e.message, true); }
  }));
}

// Botão "Atualizar firmware" na página do dispositivo
function bindFirmwareUpgrade(id, d) {
  const btn = $("#fw-upgrade");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    let files;
    try { files = (await api("/firmware")).files.filter((f) => f.model === d.model); } catch (e) { return toast(e.message, true); }
    if (!files.length) return toast(`Não há firmware na pasta ${d.model}. Envie em Firmware.`, true);
    const opts = files.map((f, i) => `${i + 1}) ${f.version || "?"} — ${f.name.replace(/^[^/]*\//, "")}`).join("\n");
    const pick = prompt(`Firmware atual: ${d.software || "?"}\n\nArquivos da pasta ${d.model}:\n${opts}\n\nDigite o número do arquivo:`, "1");
    const f = files[Number(pick) - 1];
    if (!f) return;
    if (!confirm(`Atualizar o firmware de ${d.ssid || d.serial}?\n\nDe: ${d.software || "?"}\nPara: ${f.version || f.name}\n\n` +
      "• O roteador baixa o arquivo, grava e reinicia: o cliente fica sem internet por alguns minutos.\n" +
      "• Não desligue nem reinicie o equipamento durante a atualização (o Reiniciar fica bloqueado por 10 min).\n" +
      "• A atualização pode TROCAR O MAC usado na autenticação: confira o login IPoE no SGP/BNG depois.\n" +
      "• Algumas versões não aceitam pular direto para a mais nova (ex.: a 0.2.0 precisou passar pela 0.4.0 antes da 0.8.0).\n" +
      "• Se o roteador recusar o arquivo, o portal NÃO repete a atualização sozinho.")) return;
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

// ---------- Roteamento ----------
const ROUTES = {
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

// Código do cliente com link para a ficha no SGP (nova aba)
let SGP_URL = "";
function sgpClienteLink(id) {
  const tag = `<b class="client-id">${esc(id)}</b>`;
  if (!SGP_URL || !/^\d+$/.test(String(id))) return tag;
  return `<a href="${esc(SGP_URL)}/admin/cliente/${enc(id)}/contratos/" target="_blank" rel="noopener noreferrer" title="Abrir o cliente no SGP">${tag} ↗</a>`;
}

(async () => {
  const me = await api("/me");
  SGP_URL = me.sgpUrl || "";
  $("#username").textContent = me.name;
  $("#avatar").textContent = (me.name || "?")[0].toUpperCase();
  window.addEventListener("hashchange", () => route());
  route();
})();
