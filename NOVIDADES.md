# Novidades

O que muda em cada versão, em português simples. A página **Atualizações** do portal mostra a seção de cada
versão mais nova que a instalada. Cada versão começa com uma linha `## vAAAA.MM.DD — título` (ou `vAAAA.MM.DD-2`
para a segunda versão do mesmo dia). Itens que exigem algo do provedor começam com **Atenção:**.

## v2026.11.25-4 — ONU V-SOL V2802DAC

- **V-SOL V2802DAC:** sinal óptico (RX e TX) correto na página do aparelho. Esse modelo informa o sinal já em dBm; antes o
  portal mostrava o RX vazio e o TX em torno de -35 dBm.
- Wi-Fi: a lista de canais aparece também nos aparelhos que informam os canais como faixa (ex.: "1-11").

## v2026.11.25-3 — Correção: atualizar em servidor sem curl

- O atualizador conferia o portal novo com o comando `curl`, que nem todo servidor tem; sem ele, a atualização parava na
  conferência (sem alterar nada). Agora a conferência usa o próprio Node.

## v2026.11.25-2 — Correção: botões da página Atualizações

- Corrigido o erro "read-only file system" ao clicar em Verificar agora / Atualizar: o serviço do portal não tinha
  permissão para deixar o pedido para o atualizador.
- **Atenção:** servidor que já está na v2026.11.25 precisa receber esta versão pela linha de comando, uma vez
  (como root): `globaltech-atualizar aplicar v2026.11.25-2`. Depois disso os botões do portal funcionam.

## v2026.11.25 — Atualizador pelo portal, novas OLTs e ONUs China Telecom

- **Atualizações pelo portal:** nova página Configuração → Atualizações. Mostra a versão instalada e as novas, com o que
  mudou; o administrador clica em Atualizar. Antes de trocar, o servidor confere a versão nova e, se algo falhar, volta
  sozinho para a anterior. Atualizar o portal não desconecta mais quem está usando.
- **OLTs novas:** ZTE C220, FiberHome AN5516 e FiberHome AN6000 (ONUs online, sem energia, sem fibra, sinal, temperatura
  e tempo ligada). A AN5516 foi conferida num equipamento real; C220 e AN6000 ainda precisam ser conferidas.
- **ONUs padrão China Telecom (ex.: Realtek FW323DAC):** sinal óptico, nome do Wi-Fi e canal na página do aparelho;
  ligação com a ONU na OLT; botão "Alterar Wi-Fi"; Wi-Fi restaurado pelo ACS depois de reset de fábrica.
- Hubsoft: a cópia do Wi-Fi para restaurar após reset também é achada pelo serviço do aparelho ou pelo MAC.
- Telnet das OLTs FiberHome: corrigido o "tempo esgotado" no enable (o prompt muda de `User>` para `Admin#`).
- **Atenção:** em OLT FiberHome com Wi-Fi configurado na própria OLT (`wifi_serv`), tire essa configuração das ONUs
  gerenciadas pelo ACS; senão a OLT pode regravar o Wi-Fi depois que o ACS restaurar.
