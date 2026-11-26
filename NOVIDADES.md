# Novidades

O que muda em cada versão, em português simples. A página **Atualizações** do portal mostra a seção de cada
versão mais nova que a instalada. Cada versão começa com uma linha `## vAAAA.MM.DD — título` (ou `vAAAA.MM.DD-2`
para a segunda versão do mesmo dia). Itens que exigem algo do provedor começam com **Atenção:**.

## v2026.11.25-7 — OLTs Huawei conferidas

- OLTs Huawei conferidas em equipamentos reais (MA5608T, MA5800-X2, X15 e X17): ONUs, motivo da queda, sinal e temperatura
  batem com a tela da OLT.
- Temperatura da Huawei mostra o nome de cada placa e usa limites próprios (aviso a partir de 75 °C, alarme a 85 °C): a placa
  controladora trabalha normalmente perto de 70 °C e antes aparecia como alarme.
- Telnet da Huawei: corrigido o "tempo esgotado" em comandos que pedem confirmação (`{ <cr>||<K> }:`).

## v2026.11.25-6 — OLTs Huawei

- **OLTs novas:** Huawei MA5608T, MA5800-X2, MA5800-X15 e MA5800-X17 (ONUs online, sem energia, sem fibra com o motivo da
  queda, sinal, temperatura das placas e tempo ligada). Lidas por SNMP: cadastre a community. Ainda precisam ser conferidas
  num equipamento real.
- ONTs Huawei são ligadas ao aparelho do ACS pelo serial (ex.: `HWTC1A2B3C4D` na OLT = `485754431A2B3C4D` no ACS).

## v2026.11.25-5 — ACS em servidor separado atualiza junto com o portal

- Quando o ACS fica em outro servidor, ele agora segue a versão do portal: depois de atualizar pelo botão do portal, o ACS
  instala a mesma versão sozinho em até 2 minutos, com as mesmas conferências e volta automática. O andamento aparece na
  página Atualizações, no cartão "ACS".
- **Atenção:** no servidor do ACS separado, esta versão precisa ser instalada uma vez pela linha de comando (como root):
  `globaltech-atualizar aplicar v2026.11.25-5`. Daí em diante ele acompanha o portal sozinho. O IP do ACS precisa estar no
  `WIFI_BACKUP_ALLOW` do `.env` do portal (já está, se a restauração do Wi-Fi funciona).

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
