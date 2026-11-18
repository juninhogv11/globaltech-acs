"use strict";
// Diagnóstico por regras (sem IA) de um equipamento: lista de achados para o técnico.
// Cada achado: { nivel: "problema" | "atencao" | "ok" | "info", area, titulo, detalhe, acao? }
// acao (opcional) é uma ação segura que o portal já tem: refresh | read-lan | wifi-scan | speedtest-download | speedtest-upload
const devices = require("./devices");
const lan = require("./lan");
const speedtest = require("./speedtest");
const firmware = require("./firmware");

const H = 3600000;
const ago = (iso) => (iso ? Date.now() - Date.parse(iso) : Infinity);
const tempo = (ms) => {
  if (!Number.isFinite(ms)) return "nunca";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} dias`;
};

function diagnosticar(doc, faults) {
  const d = devices.normalize(doc);
  const info = lan.lanInfo(doc);
  const st = speedtest.info(doc);
  const fj = firmware.history(d.id) || {};
  const out = [];
  const add = (nivel, area, titulo, detalhe, acao) => out.push({ nivel, area, titulo, detalhe, ...(acao ? { acao } : {}) });

  // 1. Comunicação com o ACS
  if (!d.online) {
    add("problema", "ACS", `Sem contato com o ACS há ${tempo(ago(d.lastInform))}`,
      "O equipamento não responde ao ACS: pode estar desligado, sem energia, sem fibra (LOS) ou sem internet. Os dados abaixo são da última leitura.");
  } else {
    add("ok", "ACS", "Comunicando com o ACS", `Último contato há ${tempo(ago(d.lastInform))}.`);
  }

  // 2. Sinal óptico (GPON): sensibilidade -27 dBm, saturação -8 dBm; TX normal ~0,5 a 5 dBm
  if (d.hasOptical) {
    if (d.rx === null) add("problema", "Fibra", "Sem leitura de sinal óptico (RX)", "Pode indicar fibra sem luz (LOS), conector solto ou leitura ainda não feita.", "refresh");
    else if (d.signal === "bad") add("problema", "Fibra", `Sinal óptico fora do limite: RX ${d.rx} dBm`, d.rx < -27 ? "Abaixo de -27 dBm: atenuação alta (emenda, conector sujo, curva na fibra ou splitter). Precisa de visita técnica." : "Acima de -8 dBm: sinal forte demais (saturação), falta atenuador.");
    else if (d.signal === "warn") add("atencao", "Fibra", `Sinal óptico no limite: RX ${d.rx} dBm`, "Entre -24 e -27 dBm a conexão funciona, mas pode cair com variação de temperatura ou sujeira no conector. Vale limpar o conector/verificar a rede.");
    else add("ok", "Fibra", `Sinal óptico bom: RX ${d.rx} dBm`, d.tx !== null ? `TX ${d.tx} dBm.` : "");
    if (d.tx !== null && (d.tx < 0.5 || d.tx > 5)) add("atencao", "Fibra", `Potência de transmissão incomum: TX ${d.tx} dBm`, "O normal é entre 0,5 e 5 dBm. Valor fora disso pode indicar defeito no módulo óptico da ONU.");
  }

  // 3. Reinícios
  if (d.uptime !== null && d.uptime < 30 * 60) {
    add("atencao", "Energia", `Reiniciou há ${tempo(d.uptime * 1000)}`, "Reinício recente: queda de energia, reboot manual/periódico ou travamento. Se o cliente relata quedas, pergunte se o roteador está em tomada/filtro de linha estável.");
  } else if (d.uptime !== null) {
    add("ok", "Energia", `Ligado há ${tempo(d.uptime * 1000)}`, "");
  }

  // 4. Provisionamento e SGP
  if (d.tags.includes("ERRO_SGP")) add("problema", "SGP", "Não encontrado no SGP", "O ACS não achou contrato para o serial/MAC deste equipamento. Confira o cadastro do serviço no SGP (serial e MAC).");
  if (!d.tags.includes("Provisioned")) add("problema", "Provisionamento", "Equipamento não provisionado", "A configuração automática (IPoE/Wi-Fi) não terminou. Pode usar \"Reprovisionar\" depois de conferir o SGP.");
  if (d.tags.includes("BOOTSTRAP_PENDING") && ago(doc._lastBootstrap) > 2 * H) {
    add("atencao", "Provisionamento", "Pós-reset pendente há mais de 2 h", "O equipamento passou por reset/bootstrap e o ciclo de restauração ainda não terminou.");
  }

  // 5. Falhas no ACS
  const fs = (faults || []).filter((f) => f.device === d.id);
  for (const f of fs) {
    const extra = f.code === "cwmp.9805" && /^0\.2\.0 /.test(d.software)
      ? " No firmware 0.2.0 isso costuma acontecer depois de reinícios (o roteador renumera interfaces). Atualizar para 0.6.0 resolve."
      : f.code === "preset_loop" ? " As configurações automáticas ficaram repetindo sem parar e o ACS desistiu." : "";
    add("atencao", "ACS", `Falha no ACS: ${f.code} (canal ${f.channel})`, `${f.message || ""}.${extra}`);
  }

  // 6. Firmware
  if (d.model === "XX530v" && /^0\.2\.0 /.test(d.software)) {
    add("atencao", "Firmware", "Firmware antigo (0.2.0)", "Há versões mais novas no portal (página Firmware). O caminho seguro é ir primeiro para a 0.6.0.");
  }
  if (fj.status === "recusado") add("info", "Firmware", "Última atualização de firmware foi recusada", `${fj.code || ""} ${fj.message || ""}`.trim());

  // 7. Wi-Fi
  const radios = info.radios || [];
  for (const r of radios) {
    const banda = r.band || r.name;
    if (r.status && !/^up$/i.test(r.status)) add("problema", "Wi-Fi", `Rádio ${banda} desligado (${r.status})`, "Os clientes não conseguem conectar nessa faixa.");
  }
  for (const a of info.interference || []) {
    if (a.level === "Alta" || a.level === "Média") {
      add("atencao", "Wi-Fi", `Interferência ${a.level.toLowerCase()} no ${a.band} (canal ${a.channel})`,
        `${a.overlapping} rede(s) vizinha(s) no mesmo canal ou sobrepostas.${a.suggestion ? ` Canal sugerido: ${a.suggestion} (botão na seção Wi-Fi da página).` : ""}`);
    }
  }
  if (info.neighbors && info.neighbors.supported && !info.neighbors.results.length) {
    add("info", "Wi-Fi", "Interferência ainda não verificada", "A varredura de redes vizinhas mostra se o canal está congestionado.", "wifi-scan");
  }
  const clientes = info.clients || [];
  const fracos = clientes.filter((c) => c.signal !== null && c.signal < -75);
  if (fracos.length) {
    add("atencao", "Wi-Fi", `${fracos.length} de ${clientes.length} aparelho(s) com sinal Wi-Fi fraco`,
      `Sinal abaixo de -75 dBm (${fracos.map((c) => `${c.signal} dBm no ${c.band}`).join(", ")}). Causa comum de "internet lenta" e quedas: distância/paredes. Sugira aproximar, usar cabo ou repetidor/mesh.`);
  } else if (clientes.length) {
    add("ok", "Wi-Fi", `${clientes.length} aparelho(s) no Wi-Fi com sinal bom`, "");
  }
  const em24 = clientes.filter((c) => c.band === "2.4GHz").length;
  if (em24 >= 12) add("atencao", "Wi-Fi", `${em24} aparelhos no 2.4 GHz`, "Muitos aparelhos na faixa de 2.4 GHz dividem pouca banda. Quem estiver perto do roteador deve usar a rede 5G.");
  if (Date.now() - Date.parse(info.readAt || 0) > H) add("info", "Wi-Fi", `Dados de Wi-Fi/LAN de ${tempo(ago(info.readAt))} atrás`, "Ler de novo mostra a situação de agora.", "read-lan");

  // 8. Portas LAN (cabo)
  for (const p of info.ports || []) {
    if (/^up$/i.test(p.status) && p.speed !== null && p.speed > 0 && p.speed < 1000) {
      add("atencao", "Cabo", `${p.name} conectada a ${p.speed} Mbps`, "Porta negociou abaixo de 1 Gbps: cabo ruim/antigo (só 4 vias), conector mal crimpado ou placa de rede do aparelho limitada. Limita a velocidade de quem está nesse cabo.");
    }
  }

  // 9. Teste de velocidade
  const dl = st.download || {};
  if (dl.supported) {
    if (dl.mbps) add("info", "Velocidade", `Último teste de download: ${dl.mbps} Mbps (${tempo(ago(dl.at))} atrás)`, "O teste mede do roteador até o servidor da Globaltech (sem o Wi-Fi do cliente).", ago(dl.at) > 24 * H ? "speedtest-download" : undefined);
    else add("info", "Velocidade", "Sem teste de velocidade recente", "O teste no próprio roteador separa problema de rede (fibra/plano) de problema no Wi-Fi do cliente.", "speedtest-download");
  }

  const ordem = { problema: 0, atencao: 1, info: 2, ok: 3 };
  out.sort((a, b) => ordem[a.nivel] - ordem[b.nivel]);
  return { device: d, achados: out, resumo: resumo(out) };
}

function resumo(achados) {
  const n = (k) => achados.filter((a) => a.nivel === k).length;
  const p = n("problema"), a = n("atencao");
  if (p) return `${p} problema(s) e ${a} ponto(s) de atenção`;
  if (a) return `${a} ponto(s) de atenção`;
  return "Nenhum problema encontrado";
}

// Dados técnicos para a IA, SEM identificar o cliente (sem SSID, MAC, serial, IP, código do SGP)
function contextoIA(doc, diag) {
  const d = diag.device;
  const info = lan.lanInfo(doc);
  const st = speedtest.info(doc);
  return {
    modelo: d.model, fabricante: d.manufacturer, hardware: (d.hardware || "").split(" ")[0], firmware: d.software,
    online: d.online, ultimoContatoMin: Number.isFinite(ago(d.lastInform)) ? Math.round(ago(d.lastInform) / 60000) : null,
    ligadoHaMin: d.uptime !== null ? Math.round(d.uptime / 60) : null,
    fibra: d.hasOptical ? { rxDbm: d.rx, txDbm: d.tx, nivel: d.signal } : null,
    tags: d.tags.filter((t) => !/^SGP_/.test(t)),
    wifi: (info.radios || []).map((r) => ({ banda: r.band, canal: r.channel, largura: r.bandwidth, automatico: r.autoChannel, status: r.status })),
    interferencia: (info.interference || []).map((a) => ({ banda: a.band, canal: a.channel, nivel: a.level, redesSobrepostas: a.overlapping, canalSugerido: a.suggestion })),
    clientesWifi: (info.clients || []).map((c) => ({ banda: c.band, sinalDbm: c.signal, padrao: c.standard })),
    aparelhosNaRede: (info.hosts || []).filter((h) => h.active !== false).length,
    portasLan: (info.ports || []).map((p) => ({ porta: p.name, status: p.status, mbps: p.speed })),
    testeVelocidade: { downloadMbps: (st.download || {}).mbps || null, uploadMbps: (st.upload || {}).mbps || null },
    achados: diag.achados.map((a) => ({ nivel: a.nivel, area: a.area, titulo: a.titulo, detalhe: a.detalhe })),
  };
}

module.exports = { diagnosticar, contextoIA };
