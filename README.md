# Globaltech ACS

Portal de gerência e configuração do GenieACS usados pela Globaltech para os
equipamentos dos clientes (TP-Link XX530v, roteadores TR-098 e MikroTik).

- **Portal web**: dashboard, dispositivos, sinal óptico (PON), Wi-Fi e clientes conectados,
  portas LAN, verificação de interferência com troca de canal, teste de velocidade (TR-143),
  alteração de Wi-Fi, atualização de firmware (arquivos por modelo, sem repetição automática),
  falhas, provisions/presets (consulta) e código do cliente no SGP.
- **GenieACS**: provisions, presets, virtual parameters e extensões
  (integração com o SGP e restauração de Wi-Fi após reset de fábrica).

## Estrutura

```
portal/                    aplicação web (Node.js 18+, sem dependências npm)
  server.js, lib/, public/
  scripts/add-user.js      cria/altera usuários do portal
  deploy/install.sh        instalação em Debian/Ubuntu (systemd + nginx)
  .env.example             configuração (vira /opt/globaltech-portal/.env)
acs/                       configuração do GenieACS
  provisions/  presets/  virtual_parameters/
  ext/sistema              consulta o contrato no SGP (por serial ou login = MAC WAN)
  ext/wifibackup           devolve o Wi-Fi guardado (portal ou SGP) para restaurar após reset
  deploy-acs.js            publica a configuração pela API NBI (com backup e simulação)
  acs.env.example          valores das {{VARIAVEIS}} das provisions (senha do Connection Request etc.)
  sgp.env.example          credenciais da API do SGP
```

Arquivos `*.env` com senhas e tokens **não vão para o Git** (veja `.gitignore`).

## Requisitos

- GenieACS 1.2 com a API NBI acessível pelo portal (porta 7557).
- Servidor do portal: Debian 12 ou Ubuntu 22.04+, Node.js 18+ (pacote `nodejs`), nginx.
- Servidor do GenieACS: Node.js 18+ (já vem com o GenieACS).

## 1. Instalar o portal

No servidor do portal, como root:

```bash
git clone <url-do-repositorio> globaltech-acs
cd globaltech-acs/portal
bash deploy/install.sh                    # publica na porta 8080 (PORTAL_PORT=80 para outra)
nano /opt/globaltech-portal/.env          # revise NBI_URL e as URLs do teste de velocidade
systemctl restart globaltech-portal
cd /opt/globaltech-portal && sudo -u portal node scripts/add-user.js admin "Administrador"
```

O instalador:
- instala só `nodejs` e `nginx` (o portal não usa npm);
- baixa o Chart.js 4.4.1 do registro oficial e confere a integridade (SHA-512);
- cria o usuário de sistema `portal`, o serviço `globaltech-portal` (escuta só em 127.0.0.1:3100)
  e um site próprio no nginx, **sem mexer nos outros sites**;
- pode ser rodado de novo para atualizar: mantém `.env` e `data/` (usuários, fotos, cópias de Wi-Fi).

Libere a porta escolhida no firewall do servidor (`ufw allow 8080/tcp` ou
`firewall-cmd --permanent --add-port=8080/tcp && firewall-cmd --reload`).

## 2. Configurar o GenieACS

No servidor do GenieACS, como root:

```bash
git clone <url-do-repositorio> globaltech-acs
cd globaltech-acs/acs

# Credenciais do SGP (lidas pela extensão "sistema" a cada consulta)
cp sgp.env.example /opt/genieacs/sgp.env
nano /opt/genieacs/sgp.env
chown genieacs:genieacs /opt/genieacs/sgp.env && chmod 600 /opt/genieacs/sgp.env

# Valores das provisions (URL do ACS, senha do Connection Request, NTP...)
cp acs.env.example acs.env
nano acs.env

node deploy-acs.js --dry-run              # mostra o que mudaria
node deploy-acs.js --install-ext          # backup do servidor + publica + copia as extensões
chown genieacs:genieacs /opt/genieacs/ext/*
systemctl restart genieacs-cwmp
```

Para a atualização de firmware pelo portal, o GenieACS precisa informar aos roteadores um
endereço de download que eles consigam acessar. Em `/opt/genieacs/genieacs.env`:

```bash
GENIEACS_FS_HOSTNAME=acs.exemplo.com.br   # mesmo nome que os roteadores usam para o ACS
```

e depois `systemctl restart genieacs-cwmp`. Os arquivos são baixados pela porta 7567.

O `deploy-acs.js` guarda um backup da configuração atual em `acs/backups/<data>/`
antes de gravar e se recusa a publicar se faltar alguma variável em `acs.env`.

## Configuração obrigatória

Os valores nos arquivos `.example` (`acs.exemplo.com.br`, `192.168.10.x`, `suaempresa.sgp.net.br`)
são **exemplos**. Preencha com os endereços reais antes de usar:

| Arquivo | Chaves |
|---|---|
| `/opt/globaltech-portal/.env` (servidor do portal) | `NBI_URL`, `SPEEDTEST_DOWNLOAD_URL`, `SPEEDTEST_UPLOAD_BASE`, `WIFI_BACKUP_ALLOW` |
| `/opt/genieacs/sgp.env` (servidor do GenieACS) | `SGP_HOST`, `SGP_APP`, `SGP_TOKEN`, `WIFI_PORTAL_URL` |
| `acs/acs.env` (onde rodar o `deploy-acs.js`) | `NBI_URL`, `ACS_URL`, `CR_USER`, `CR_PASS`, `SPEEDTEST_URL`, `NTP_SERVER` |

Ao atualizar uma instalação antiga, confira se essas chaves existem: versões anteriores
tinham alguns desses endereços fixos no código.

## Como funciona o provisionamento

| Preset | Quando | O que faz |
|---|---|---|
| `01_BOOTSTRAP` | evento `0 BOOTSTRAP` (reset de fábrica, reinício pela OLT no XX530v ou novo ACS) | só marca a tag `BOOTSTRAP_PENDING` (não mexe em outras tags nem usa `clear()`: preset de evento roda a cada ciclo da sessão e geraria `preset_loop`) |
| `02_PROVISION_IPOE` | sem tag `Provisioned` **ou** com `BOOTSTRAP_PENDING` | URL do ACS, credenciais do Connection Request; consulta o SGP **pelo serial** e, se não achar, **pelo login = MAC WAN** (`xxxx-xxxx-xxxx`); grava as tags `SGP_CLIENTE_<id>` e `SGP_CONTRATO_<id>`; sem contrato → tag `ERRO_SGP` |
| `04_WIFI_RESTORE` (canal `wifi`) | tag `BOOTSTRAP_PENDING` | só se o Wi-Fi voltou ao padrão `TP-Link_XXXX`: grava nome e senha guardados (portal ou SGP) |
| `05_BOOTSTRAP_DONE` (canal `bootstrap`) | `2 PERIODIC` com `BOOTSTRAP_PENDING` | tira a marca `BOOTSTRAP_PENDING` no primeiro inform periódico, fora da sessão do BOOTSTRAP |
| `06_REBOOT_PERIODICO` (canal `reboot`) | `2 PERIODIC`, sem `BOOTSTRAP_PENDING` e sem tag `SEM_REBOOT` | entre 03:00 e 05:00 (Brasília) reinicia quem está ligado há **48 h ou mais**; cada equipamento tem seu minuto na janela (calculado pelo ID) para não reiniciarem todos juntos; não repete se o ACS já pediu reboot nas últimas 20 h |
| `default` | todo inform | leitura periódica (IP, sinal óptico RX/TX, Wi-Fi, hosts) e virtual parameters |
| `inform` | `2 PERIODIC` | intervalo de inform, NTP, atualização diária da árvore |

Para tirar um equipamento do reboot automático, coloque nele a tag `SEM_REBOOT` (pela interface do GenieACS). Os reboots ficam no log: `grep REBOOT_PERIODICO /var/log/genieacs/genieacs-cwmp-access.log`.

O XX530v **não informa a senha do Wi-Fi** ao ACS (o campo é só de escrita). Por isso a
restauração depende de uma cópia: ela é guardada quando o Wi-Fi é alterado pelo botão
**"Alterar Wi-Fi"** do portal, ou vem dos campos de Wi-Fi do contrato no SGP.

## Segurança

- A API NBI do GenieACS (7557) não tem senha: libere-a no firewall só para o portal e o SGP.
- O portal usa login próprio (senhas em scrypt, bloqueio após 5 tentativas, proteção CSRF).
  Se for acessado pela internet, use HTTPS e `COOKIE_SECURE=1`.
- A cópia do Wi-Fi fica em `/opt/globaltech-portal/data/wifi-backup.json` (permissão 600) e só
  pode ser lida pelo IP do GenieACS configurado em `WIFI_BACKUP_ALLOW`.
- Nenhum log registra senhas (PPPoE, Wi-Fi ou Connection Request).

## Operação

```bash
journalctl -u globaltech-portal -f                                   # log do portal
grep -E 'ETAPA|PAROU|WIFI|REBOOT_PERIODICO' /var/log/genieacs/genieacs-cwmp-access.log | tail   # provisionamento
```
