"use strict";
// Assistente de suporte com IA (API compatível com OpenAI: Groq, Gemini, OpenRouter...).
// Recebe só dados técnicos do equipamento (diagnostico.contextoIA): sem SSID, MAC, serial, IP ou código do cliente.
const IA_URL = (process.env.IA_URL || "").replace(/\/+$/, "");
const IA_CHAVE = process.env.IA_CHAVE || "";
const IA_MODELO = process.env.IA_MODELO || "";
const LIMITE_DIA = Number(process.env.IA_LIMITE_DIA || 300);
const ACOES = ["refresh", "read-lan", "wifi-scan", "speedtest-download", "speedtest-upload"];

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

const SISTEMA = `Você é o assistente de suporte técnico da Globaltech, um provedor de internet por fibra (GPON).
Quem fala com você é um TÉCNICO ou atendente do suporte, dentro do portal do ACS, olhando um equipamento de cliente.
Responda em português do Brasil, de forma curta e prática: no máximo 8 linhas ou uma lista de passos.

Use SÓ os dados do equipamento enviados (JSON "equipamento") e o que o técnico contar. Não invente leituras.
Se faltar um dado, diga qual e como obter.

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
  return !!(IA_URL && IA_CHAVE && IA_MODELO);
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

  let r;
  try {
    r = await fetch(`${IA_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${IA_CHAVE}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: IA_MODELO,
        temperature: 0.2,
        max_tokens: 700,
        messages: [
          { role: "system", content: SISTEMA },
          { role: "system", content: "Dados do equipamento (JSON):\n" + JSON.stringify({ equipamento: contexto }) },
          ...hist,
        ],
      }),
      signal: AbortSignal.timeout(45000),
    });
  } catch (e) {
    usados--;
    throw bad(`O serviço de IA não respondeu: ${e.message}`, 502);
  }
  const j = await r.json().catch(() => ({}));
  if (r.status === 429) throw bad("Limite gratuito do serviço de IA atingido agora. Tente de novo em alguns minutos; o diagnóstico continua funcionando.", 429);
  if (!r.ok) throw bad(`Serviço de IA respondeu HTTP ${r.status}: ${((j.error || {}).message || "").slice(0, 200)}`, 502);
  let texto = String(((((j.choices || [])[0] || {}).message) || {}).content || "").trim();
  // Alguns modelos devolvem o raciocínio entre <think>...</think>
  texto = texto.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const acoes = [...new Set([...texto.matchAll(/\[\[ACAO:([a-z-]+)\]\]/g)].map((m) => m[1]).filter((a) => ACOES.includes(a)))];
  texto = texto.replace(/\[\[ACAO:[a-z-]+\]\][^\n]*\n?/g, "").trim();
  return { texto: texto || "(sem resposta)", acoes, usadosHoje: usados, limiteDia: LIMITE_DIA };
}

module.exports = { configurado, perguntar };
