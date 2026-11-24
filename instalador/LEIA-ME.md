# Instalador com assistente (wizard)

Instala o Globaltech ACS em um servidor Linux novo, fazendo perguntas em telas
(navegue com **TAB**, marque com **ESPAÇO**, confirme com **ENTER**).

Sistemas: **Debian 12/13** ou **Ubuntu 22.04+**, com acesso à internet. Rodar como **root**.

## 1. Levar o projeto para o servidor

**Com Git:**
```bash
git clone https://github.com/juninhogv11/globaltech-acs.git
cd globaltech-acs
```

**Sem Git (pelo Windows):** na pasta do projeto, rode no PowerShell `.\instalador\empacotar.ps1`.
Ele cria `globaltech-acs-instalador-AAAAMMDD-HHMM.tar.gz` (sem arquivos `.env` com senhas).
Copie para o servidor (WinSCP) e:
```bash
tar xzf globaltech-acs-instalador-*.tar.gz
cd globaltech-acs
```

## 2. Rodar o assistente

```bash
bash instalador/instalar.sh
```

### Tipo de instalação

A primeira tela pergunta onde fica cada parte:

| Opção | Instala neste servidor | Use quando |
|---|---|---|
| **Tudo no mesmo servidor** | GenieACS + Portal | um servidor só (o mais simples) |
| **Só o servidor ACS** | GenieACS (+ backup, firewall, teste de velocidade) | o portal vai ficar em outro servidor |
| **Só o Portal** | Portal (Node.js + nginx) | o GenieACS já está em outro servidor |

**Portal e ACS em servidores separados** — instale nesta ordem:
1. No servidor do **ACS**: escolha "Só o servidor ACS" e informe o endereço do portal (ex.: `http://192.168.10.3:8080`).
   Ele é usado para restaurar o Wi-Fi após reset e para o backup incluir os dados do portal. No firewall,
   o IP do portal já vem sugerido. Se o portal ainda não existir, deixe vazio e rode o instalador de novo depois.
2. No servidor do **portal**: escolha "Só o Portal" e informe o IP do GenieACS. O instalador **testa a conexão
   com a API NBI (7557)** na hora e avisa se o firewall do ACS estiver bloqueando. Se o ACS tiver backup,
   informe o token (no ACS: `grep ^TOKEN= /etc/genieacs-backup/backup.env`).

No modo "Só o Portal" os requisitos de hardware são menores e não há Docker nem MongoDB.

### Verificação do hardware (antes das outras perguntas)

O instalador confere o servidor e mostra um relatório com `[ OK ]`, `[AVISO]` e `[ERRO]`.
Com algum **ERRO** ele não instala; com **AVISO** você escolhe se continua.

| Item | Com GenieACS: mínimo / recomendado | Só o Portal: mínimo / recomendado |
|---|---|---|
| Arquitetura | amd64 (x86_64) | amd64 ou arm64 |
| Processador | 2 / 4 núcleos, com AVX | 1 / 2 núcleos |
| Memória | 4 / 8 GB, com swap | 1 / 2 GB |
| Disco livre em `/var/lib` | 15 / 40 GB | 3 / 10 GB |
| Internet | Debian, npm e Docker Hub | Debian e npm |
| Portas livres | 7547, 7557, 7567, 3000, 27017, 7570 (+3100 com portal) | 3100 |
| Sistema | Debian 12/13 ou Ubuntu 22.04+, relógio sincronizado | igual |

Abaixo do mínimo é ERRO; abaixo do recomendado é AVISO.

Também identifica se é **servidor físico**, **máquina virtual** (Proxmox/KVM, VMware, Hyper-V,
VirtualBox, Xen) ou **contêiner** (LXC — não recomendado, por causa do Docker). Em VM Proxmox/KVM,
VMware ou Hyper-V, oferece instalar o agente da VM (`qemu-guest-agent`, `open-vm-tools`, `hyperv-daemons`).
No Proxmox, ligue também **VM → Options → QEMU Guest Agent** e use CPU tipo **host** (libera o AVX).

### Perguntas

O assistente pergunta, em ordem:

| Tela | O que pede |
|---|---|
| Opções do ACS | Backup, Firewall da NBI, arquivo do teste de velocidade |
| GenieACS | nome/IP do ACS usado pelos roteadores, porta CWMP, usuário/senha do Connection Request, NTP, memória do MongoDB |
| SGP | host, APP e TOKEN da API (opcional) |
| Portal | porta, IP visto pelos roteadores, IP do GenieACS (se estiver em outro servidor), HTTPS, usuário e senha do administrador |
| Backup | destino FTP/FTPS/SFTP, usuário, senha e senha de criptografia |
| Firewall | IPs que podem acessar a API NBI (7557) e a API de backup (7570) |
| Tarefas | reinício semanal do NBI/FS e limpeza automática de equipamentos offline |

No fim aparece um **resumo**; nada é instalado antes de você confirmar.
Antes de publicar as provisions, o instalador mostra a **simulação** (`deploy-acs.js --dry-run`)
e pede outra confirmação.

## O que é instalado

- **GenieACS 1.2.16** (npm) com os serviços `genieacs-cwmp/nbi/fs/ui`, logs em `/var/log/genieacs`
  e configuração em `/opt/genieacs/genieacs.env` (inclui `GENIEACS_FS_HOSTNAME`).
- **MongoDB 4.4.29 em Docker** (contêiner `mongodb`, dados em `/var/lib/mongodb-docker`) —
  roda mesmo sem AVX e é o que o `genieacs-backup.js` espera.
- `/opt/genieacs/sgp.env`, `acs/acs.env`, extensões `sistema` e `wifibackup`, provisions/presets/virtual parameters.
- Timers opcionais: reinício semanal, limpeza de offline; rotação de logs.
- **Portal** pelo `portal/deploy/install.sh` (systemd + nginx), `.env` preenchido e usuário administrador criado.
- **Backup** em `/opt/genieacs-backup` + `/etc/genieacs-backup` (timer diário 02:00 e API na porta 7570).
- **Firewall** `/usr/local/sbin/genieacs-firewall.sh` (serviço `genieacs-firewall`).

## Rodar de novo

Pode rodar quantas vezes quiser (para corrigir uma resposta ou atualizar o código):
- as respostas (sem senhas) ficam em `/etc/globaltech-instalador/respostas.conf` e voltam preenchidas;
- os `.env` existentes são mantidos — só as chaves perguntadas são atualizadas;
- o contêiner do MongoDB e os dados do portal são preservados.

Log completo: `/var/log/globaltech-instalador.log` (não contém senhas).

## Migrar os dados de um servidor antigo

O instalador cria um GenieACS **vazio**. Para trazer os equipamentos do servidor atual, depois da instalação:
```bash
ssh antigo 'mongodump --db genieacs --gzip --archive' | docker exec -i mongodb mongorestore --gzip --archive --nsInclude 'genieacs.*' --drop
systemctl restart genieacs-cwmp genieacs-nbi genieacs-fs genieacs-ui
```
Veja também `acs/servidor/MIGRACAO-DEBIAN12.md`.

## Depois de instalar

- Interface do GenieACS: `http://IP:3000` (no primeiro acesso ela pede para criar o administrador).
- Libere no firewall externo/roteador: porta CWMP (7547), 7567 (firmware), porta do portal e 80 (teste de velocidade).
- Se usou backup: **guarde fora do servidor** a senha de `/etc/genieacs-backup/senha`.
- IA do assistente do portal (opcional): preencha `IA_URL`, `IA_CHAVE`, `IA_MODELO` em
  `/opt/globaltech-portal/.env` e `systemctl restart globaltech-portal`.
