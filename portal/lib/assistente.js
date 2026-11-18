"use strict";
// Assistente de suporte com IA (API compatível com OpenAI: Groq, Gemini, OpenRouter...).
// Recebe só dados técnicos do equipamento (diagnostico.contextoIA): sem SSID, MAC, serial, IP ou código do cliente.
//
// Provedores em ordem de preferência: IA_* (1º), IA2_* (2º), IA3_* (3º). Cada um com URL, CHAVE e MODELO
// (MODELO pode ser lista separada por vírgula). Se um modelo estiver sobrecarregado, sem cota ou fora do ar,
// tenta o próximo modelo; se a chave do provedor for recusada, pula para o próximo provedor.
// Ex.: IA_URL=https://generativelanguage.googleapis.com/v1beta/openai  IA_MODELO=gemini-flash-lite-latest,gemini-flash-latest
//      IA2_URL=https://api.openai.com/v1                              IA2_MODELO=<modelo pequeno da OpenAI>
const PROVEDORES = ["", "2", "3"].map((n) => {
  const url = (process.env[`IA${n}_URL`] || "").replace(/\/+$/, "");
  return {
    nome: process.env[`IA${n}_NOME`] || (url ? new URL(url).hostname.replace(/^(api|www|generativelanguage)\./, "") : ""),
    url,
    chave: process.env[`IA${n}_CHAVE`] || "",
    modelos: String(process.env[`IA${n}_MODELO`] || "").split(",").map((s) => s.trim()).filter(Boolean),
    openai: /api\.openai\.com/.test(url),
  };
}).filter((p) => p.url && p.chave && p.modelos.length);
const LIMITE_DIA = Number(process.env.IA_LIMITE_DIA || 300);
const ACOES = ["refresh", "read-lan", "wifi-scan", "speedtest-download", "speedtest-upload"];

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

const SISTEMA = `Você é o assistente de suporte técnico da Globaltech, um provedor de internet por fibra (GPON).
Quem fala com você é um TÉCNICO ou atendente do suporte, dentro do portal do ACS, olhando um equipamento de cliente.
Fale COM O TÉCNICO (ex.: "peça ao cliente...", "verifique..."), nunca diretamente com o cliente,
a não ser que o técnico peça um texto para repassar ao cliente.
Responda em português do Brasil, curto e prático: no máximo 8 linhas, em lista de passos numerados quando houver passos.
Sem títulos, sem emojis, sem repetir todos os dados de volta; cite só os números que justificam a conclusão.

Use SÓ os dados do equipamento enviados (JSON "equipamento") e o que o técnico contar. Não invente leituras.
Use o modelo exatamente como está no campo "modelo"; nunca deduza marca ou modelo comercial
("IGD" significa só que o roteador usa o padrão TR-098). Se faltar um dado, diga qual e como obter.

Referências:
- Sinal óptico RX: bom acima de -24 dBm; atenção de -24 a -27; problema abaixo de -27 (visita técnica) ou acima de -8 (saturação).
- Wi-Fi: sinal do aparelho abaixo de -75 dBm é fraco (distância/paredes). 2.4 GHz alcança mais e é mais lento; 5 GHz é rápido e alcança menos.
- Interferência alta no canal: sugerir o canal indicado em "interferencia".
- Porta LAN abaixo de 1000 Mbps: cabo/conector ou placa do aparelho.
- Teste de velocidade do portal mede do roteador ao servidor (sem o Wi-Fi). Se ele está bom e o cliente reclama, o gargalo é o Wi-Fi ou o aparelho do cliente.
- Firmware 0.2.0 do XX530v tem falhas conhecidas; recomendar 0.6.0.

Ações que o técnico pode disparar com um botão (sugira no máximo 2 quando fizerem sentido, uma por linha, exatamente assim):
[[ACAO:refresh]] atualizar dados do equipamento
[[ACAO:read-lan]] ler Wi-Fi, aparelhos conectados e portas
[[ACAO:wifi-scan]] verificar interferência de redes vizinhas
[[ACAO:speedtest-download]] teste de velocidade de download
[[ACAO:speedtest-upload]] teste de velocidade de upload
Nunca sugira reiniciar, resetar, trocar firmware ou mudar Wi-Fi/senha como ação automática: só como orientação para o técnico decidir.
Se o problema for físico (fibra, energia, cabo), diga claramente que precisa de visita ou de verificação no local.`;

// Contador diário simples (o provedor gratuito também tem limite próprio)
let dia = "", usados = 0;
function contar() {
  const hoje = new Date().toISOString().slice(0, 10);
  if (hoje !== dia) { dia = hoje; usados = 0; }
  if (usados >= LIMITE_DIA) throw bad(`Limite diário do assistente atingido (${LIMITE_DIA} perguntas). O diagnóstico continua funcionando.`, 429);
  usados++;
}

function configurado() {
  return PROVEDORES.length > 0;
}

// Corpo do pedido: modelos novos da OpenAI usam max_completion_tokens e não aceitam temperature
function corpo(p, modelo, messages) {
  return p.openai
    ? { model: modelo, max_completion_tokens: 600, messages }
    : { model: modelo, temperature: 0.2, max_tokens: 600, messages };
}

// mensagens: [{ role: "user" | "assistant", content }] (histórico curto vindo do navegador)
async function perguntar(contexto, mensagens) {
  if (!configurado()) throw bad("Assistente não configurado no portal (IA_URL, IA_CHAVE e IA_MODELO no .env).", 503);
  const hist = (Array.isArray(mensagens) ? mensagens : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-10)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (!hist.length || hist[hist.length - 1].role !== "user") throw bad("Escreva a pergunta.");
  contar();

  // Modelos pequenos obedecem melhor ao formato quando a regra vem junto da última pergunta
  const ultima = hist[hist.length - 1];
  const lembrete = "\n\n(Formato: fale com o técnico; no máximo 8 linhas; passos numerados; sem títulos, sem emojis, sem resumo final; não repita os dados. Se um teste ou leitura do portal ajudar, termine com até 2 linhas usando só estes códigos: [[ACAO:speedtest-download]] [[ACAO:speedtest-upload]] [[ACAO:wifi-scan]] [[ACAO:read-lan]] [[ACAO:refresh]].)";
  const messages = [
    { role: "system", content: SISTEMA },
    { role: "system", content: "Dados do equipamento (JSON):\n" + JSON.stringify({ equipamento: contexto }) },
    ...hist.slice(0, -1),
    { role: "user", content: ultima.content + lembrete },
  ];
  let r = null, j, modelo, provedor, todosSemCota = true;
  const erros = [];
  fora: for (provedor of PROVEDORES) {
    for (modelo of provedor.modelos) {
      try {
        r = await fetch(`${provedor.url}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${provedor.chave}`, "Content-Type": "application/json" },
          body: JSON.stringify(corpo(provedor, modelo, messages)),
          signal: AbortSignal.timeout(30000),
        });
      } catch (e) {
        erros.push(`${provedor.nome}/${modelo}: não respondeu`);
        r = null;
        todosSemCota = false;
        continue;
      }
      j = await r.json().catch(() => ({}));
      if (r.ok) break fora;
      const err = (Array.isArray(j) ? (j[0] || {}).error : j.error) || {};
      erros.push(`${provedor.nome}/${modelo}: HTTP ${r.status} ${String(err.message || "").slice(0, 80)}`);
      if (r.status !== 429) todosSemCota = false;
      // Chave recusada ou sem crédito: os outros modelos do mesmo provedor também vão falhar
      if ([401, 402, 403].includes(r.status)) continue fora;
    }
  }
  if (!r || !r.ok) {
    usados--;
    console.error(new Date().toISOString(), "assistente IA: todos falharam:", erros.join(" | "));
    if (todosSemCota) throw bad("Limite gratuito dos serviços de IA atingido agora. Tente de novo em alguns minutos; o diagnóstico continua funcionando.", 429);
    throw bad(`Serviço de IA indisponível agora (${erros[erros.length - 1] || "sem resposta"}). O diagnóstico continua funcionando.`, 502);
  }
  let texto = String(((((j.choices || [])[0] || {}).message) || {}).content || "").trim();
  // Alguns modelos devolvem o raciocínio entre <think>...</think>
  texto = texto.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  // [[ACAO:wifi-scan]] ou, se o modelo escrever em texto livre, reconhece pelas palavras
  const acoes = [];
  for (const m of texto.matchAll(/\[\[\s*ACAO\s*:\s*([^\]]+)\]\]/gi)) {
    const t = m[1].trim().toLowerCase();
    const achadas = ACOES.includes(t) ? [t] : [
      /upload/.test(t) && "speedtest-upload",
      /(velocidade|download|speed)/.test(t) && !/upload/.test(t) && "speedtest-download",
      /(interfer|varredura|vizinh|wifi-scan)/.test(t) && "wifi-scan",
      /(ler wi-?fi|read-lan|conectados|portas|lan agora)/.test(t) && "read-lan",
      /(atualiz|refresh)/.test(t) && "refresh",
    ].filter(Boolean);
    for (const a of achadas) if (!acoes.includes(a)) acoes.push(a);
  }
  acoes.splice(2);
  texto = texto.replace(/\[\[\s*ACAO[^\]]*\]\][^\n]*\n?/gi, "").trim();
  return { texto: texto || "(sem resposta)", acoes, provedor: provedor.nome, modelo, tentativasFalhas: erros.length, usadosHoje: usados, limiteDia: LIMITE_DIA };
}

module.exports = { configurado, perguntar };
