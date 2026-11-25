#!/usr/bin/env bash
# =============================================================================
#  Instalador com assistente (wizard) — Globaltech ACS
#  Instala em um servidor Linux novo (Debian 12/13 ou Ubuntu 22.04+):
#    - GenieACS 1.2.16 + MongoDB 4.4 (Docker) + provisions/presets/extensões
#    - Portal Globaltech (systemd + nginx)
#    - Backup automático criptografado (FTP/FTPS/SFTP) — opcional
#
#  Uso, como root, na pasta do projeto:
#    bash instalador/instalar.sh
#
#  Pode ser rodado de novo: as respostas ficam salvas (sem senhas) e os arquivos
#  .env existentes são atualizados só nas chaves perguntadas.
# =============================================================================
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
TITULO="Instalador Globaltech ACS"
LOG=/var/log/globaltech-instalador.log
RESP_DIR=/etc/globaltech-instalador
RESP="$RESP_DIR/respostas.conf"
GENIEACS_VERSION=1.2.16
MONGO_IMAGE=mongo:4.4.29     # 4.4: roda sem AVX e é a versão usada pelo genieacs-backup.js (shell "mongo")
PORTAL_APP=/opt/globaltech-portal

# ----------------------------------------------------------------------------- checagens
[ "$(id -u)" = 0 ] || { echo "Rode como root (entre com 'su -' e depois: bash $0)"; exit 1; }
[ -f "$SRC/portal/server.js" ] && [ -f "$SRC/acs/deploy-acs.js" ] || {
  echo "Não achei o projeto em $SRC (falta portal/ ou acs/)."; exit 1; }
. /etc/os-release 2>/dev/null || true
case "${ID:-}${ID_LIKE:-}" in
  *debian*|*ubuntu*) ;;
  *) echo "Sistema não suportado (${PRETTY_NAME:-desconhecido}). Use Debian 12/13 ou Ubuntu 22.04+."; exit 1 ;;
esac
export DEBIAN_FRONTEND=noninteractive
if ! command -v whiptail >/dev/null || ! command -v curl >/dev/null; then
  echo "Instalando whiptail e curl (telas do assistente e teste de internet)..."
  apt-get update -qq && apt-get install -y -qq whiptail curl ca-certificates >/dev/null
fi

# ----------------------------------------------------------------------------- telas
cancelar() {
  if whiptail --title "$TITULO" --yesno "Deseja sair do instalador?\n\nNada foi alterado no servidor até agora." 10 60; then
    clear >/dev/tty; echo "Instalação cancelada. Nada foi alterado." >&2; exit 1
  fi
}
# perguntar "Texto" "padrão"  -> imprime a resposta
perguntar() {
  local r
  while true; do
    if r=$(whiptail --title "$TITULO" --inputbox "$1" 12 76 "${2:-}" 3>&1 1>&2 2>&3); then
      if [ -z "$r" ] && [ "${3:-}" != "opcional" ]; then
        whiptail --title "$TITULO" --msgbox "Este campo é obrigatório." 8 50; continue
      fi
      printf '%s' "$r"; return
    fi
    cancelar
  done
}
# senha "Texto" [opcional] [gerar]  -> pede duas vezes
senha() {
  local a b
  while true; do
    a=$(whiptail --title "$TITULO" --passwordbox "$1" 12 76 3>&1 1>&2 2>&3) || { cancelar; continue; }
    if [ -z "$a" ]; then
      [ "${2:-}" = "opcional" ] && { printf ''; return; }
      if [ "${3:-}" = "gerar" ]; then printf '%s' "$(gerar_segredo 18)"; return; fi
      whiptail --title "$TITULO" --msgbox "A senha não pode ficar vazia." 8 50; continue
    fi
    b=$(whiptail --title "$TITULO" --passwordbox "Repita a senha:" 10 76 3>&1 1>&2 2>&3) || { cancelar; continue; }
    [ "$a" = "$b" ] && { printf '%s' "$a"; return; }
    whiptail --title "$TITULO" --msgbox "As senhas não conferem. Tente de novo." 8 50
  done
}
sim_nao() { whiptail --title "$TITULO" ${3:+--defaultno} --yesno "$1" "${2:-10}" 76; }
aviso()   { whiptail --title "$TITULO" --msgbox "$1" "${2:-12}" 76; }
# Sem "head" no fim do pipe (evita SIGPIPE com pipefail): gera sobrando e corta no bash
gerar_segredo() {
  local s=""
  while [ ${#s} -lt "${1:-32}" ]; do s+=$(head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9'); done
  printf '%s' "${s:0:${1:-32}}"
}
ip_valido() { [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }
pedir_ip() {
  local v
  while true; do
    v=$(perguntar "$1" "$2")
    ip_valido "$v" && { printf '%s' "$v"; return; }
    aviso "\"$v\" não é um IP válido (ex.: 192.168.10.2)." 8
  done
}
pedir_porta() {
  local v
  while true; do
    v=$(perguntar "$1" "$2")
    [[ "$v" =~ ^[0-9]+$ ]] && [ "$v" -ge 1 ] && [ "$v" -le 65535 ] && { printf '%s' "$v"; return; }
    aviso "Porta inválida: $v" 8
  done
}

# Grava CHAVE=valor num arquivo .env (troca a linha existente ou acrescenta), sem mexer nas outras
set_env() {
  local f="$1" k="$2" v="$3"
  [ -f "$f" ] || : > "$f"
  K="$k" V="$v" awk 'BEGIN{d=0} index($0, ENVIRON["K"]"=")==1 {print ENVIRON["K"]"="ENVIRON["V"]; d=1; next} {print} END{if(!d) print ENVIRON["K"]"="ENVIRON["V"]}' "$f" > "$f.tmp"
  cat "$f.tmp" > "$f"; rm -f "$f.tmp"
}
# Copia um .example (sem CR) se o destino não existir
do_exemplo() { [ -f "$2" ] || sed 's/\r$//' "$1" > "$2"; }

etapa() { echo; echo "==> $*"; }
falha() { echo; echo "ERRO: $*"; echo "Veja o log completo em $LOG"; exit 1; }

# ----------------------------------------------------------------------------- respostas anteriores
mkdir -p "$RESP_DIR"; chmod 700 "$RESP_DIR"
[ -f "$RESP" ] && . "$RESP"
IP_LOCAL=$(hostname -I 2>/dev/null | awk '{print $1}')
RAM_GB=$(awk '/MemTotal/ {printf "%d", $2/1024/1024}' /proc/meminfo)

# ============================================================================= BOAS-VINDAS E MODO
whiptail --title "$TITULO" --msgbox "Bem-vindo ao instalador do Globaltech ACS.

Servidor: $(hostname)  —  ${PRETTY_NAME:-Linux}
IP: ${IP_LOCAL:-?}   Memória: ${RAM_GB} GB

Primeiro você escolhe o tipo de instalação, depois o instalador confere
o hardware e faz algumas perguntas. Nada é instalado antes de você
confirmar o resumo no final.

Use as SETAS para escolher, ESPAÇO para marcar e TAB para os botões." 18 76

# Modo salvo da última vez (ou deduzido das respostas antigas)
if [ -z "${MODO:-}" ]; then
  if [ "${I_ACS:-1}" = 1 ] && [ "${I_PORTAL:-1}" = 1 ]; then MODO=JUNTO
  elif [ "${I_ACS:-1}" = 1 ]; then MODO=ACS; else MODO=PORTAL; fi
fi
sel() { [ "$MODO" = "$1" ] && echo ON || echo OFF; }
MODO=$(whiptail --title "$TITULO" --radiolist "Tipo de instalação neste servidor:" 17 78 3 \
  JUNTO  "Tudo no mesmo servidor: GenieACS + Portal"              "$(sel JUNTO)" \
  ACS    "Só o servidor ACS (o portal fica em outro servidor)"   "$(sel ACS)" \
  PORTAL "Só o Portal (o GenieACS já está em outro servidor)"    "$(sel PORTAL)" \
  3>&1 1>&2 2>&3) || cancelar
case "$MODO" in
  JUNTO)  I_ACS=1; I_PORTAL=1 ;;
  ACS)    I_ACS=1; I_PORTAL=0 ;;
  PORTAL) I_ACS=0; I_PORTAL=1 ;;
esac

# ============================================================================= VERIFICAÇÃO DO HARDWARE
# Requisitos: mínimo (abaixo disso não instala) e recomendado (abaixo disso só avisa)
if [ $I_ACS = 1 ]; then
  MIN_CPU=2;  REC_CPU=4
  MIN_RAM=3500; REC_RAM=7500      # MB (8 GB aparecem como ~7,7 GB)
  MIN_DISCO=15; REC_DISCO=40      # GB livres em /var/lib (banco, imagens Docker, backups)
  SITES="https://deb.debian.org https://registry.npmjs.org https://registry-1.docker.io/v2/"
  PORTAS_TESTE="7547 7557 7567 3000 27017 7570"
else                              # só o portal: bem mais leve (Node.js + nginx)
  MIN_CPU=1;  REC_CPU=2
  MIN_RAM=900;  REC_RAM=1800
  MIN_DISCO=3;  REC_DISCO=10
  SITES="https://deb.debian.org https://registry.npmjs.org"
  PORTAS_TESTE=""
fi
[ $I_PORTAL = 1 ] && PORTAS_TESTE="$PORTAS_TESTE 3100"

verificar_hardware() {
  local erros=0 avisos=0 rel="" ram_mb cpu disco arch virt cont vendor modelo cpu_nome
  ok()   { rel+="  [ OK ]  $1\n"; }
  av()   { rel+="  [AVISO] $1\n"; avisos=$((avisos+1)); }
  erro() { rel+="  [ERRO]  $1\n"; erros=$((erros+1)); }

  # --- Máquina: virtual ou física
  virt=$(systemd-detect-virt --vm 2>/dev/null || true)
  cont=$(systemd-detect-virt --container 2>/dev/null || true)
  vendor=$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null || echo "?")
  modelo=$(cat /sys/class/dmi/id/product_name 2>/dev/null || echo "?")
  GUEST_PKG=""
  rel+="MÁQUINA\n"
  if [ -n "$cont" ] && [ "$cont" != none ]; then
    TIPO_MAQ="Contêiner ($cont)"
    if [ $I_ACS = 1 ]; then
      av "Rodando em CONTÊINER $cont (ex.: LXC do Proxmox). O MongoDB usa Docker, que dentro\n         de LXC exige 'nesting' e costuma dar problema. Prefira uma VM."
    else
      ok "Contêiner $cont (serve para o portal)"
    fi
  elif [ -n "$virt" ] && [ "$virt" != none ]; then
    case "$virt" in
      kvm|qemu) TIPO_MAQ="Máquina virtual KVM/QEMU (Proxmox?)"; GUEST_PKG=qemu-guest-agent ;;
      vmware)   TIPO_MAQ="Máquina virtual VMware";              GUEST_PKG=open-vm-tools ;;
      microsoft) TIPO_MAQ="Máquina virtual Hyper-V";            GUEST_PKG=hyperv-daemons ;;
      oracle)   TIPO_MAQ="Máquina virtual VirtualBox" ;;
      xen)      TIPO_MAQ="Máquina virtual Xen" ;;
      *)        TIPO_MAQ="Máquina virtual ($virt)" ;;
    esac
    ok "$TIPO_MAQ — $vendor $modelo"
    [ -n "$GUEST_PKG" ] && rel+="          Será oferecido instalar o agente da VM ($GUEST_PKG).\n"
  else
    TIPO_MAQ="Servidor físico"
    ok "Servidor FÍSICO — $vendor $modelo"
  fi

  # --- Processador
  rel+="\nPROCESSADOR\n"
  arch=$(dpkg --print-architecture)
  cpu=$(nproc)
  cpu_nome=$(awk -F': ' '/model name/ {print $2; exit}' /proc/cpuinfo | sed 's/  */ /g')
  case "$arch:$I_ACS" in
    amd64:*) ok "Arquitetura $arch" ;;
    arm64:1) av "Arquitetura $arch: o MongoDB 4.4 só roda em ARM v8.2+ (ex.: Raspberry Pi 4 NÃO serve)." ;;
    arm64:0) ok "Arquitetura $arch" ;;
    *)       erro "Arquitetura $arch não suportada (precisa amd64/x86_64)." ;;
  esac
  [ -n "$cpu_nome" ] && rel+="          ${cpu_nome}\n"
  if   [ "$cpu" -lt $MIN_CPU ]; then erro "$cpu núcleo(s): mínimo $MIN_CPU."
  elif [ "$cpu" -lt $REC_CPU ]; then av "$cpu núcleos: funciona, recomendado $REC_CPU ou mais."
  else ok "$cpu núcleos"; fi
  if [ $I_ACS = 0 ]; then
    :   # o portal não usa MongoDB: AVX não importa
  elif grep -qm1 -w avx /proc/cpuinfo; then
    ok "AVX presente"
  else
    av "Sem AVX: o MongoDB fica no 4.4 (MongoDB 5+ não roda).\n         Em VM no Proxmox, use CPU tipo 'host' para liberar o AVX."
  fi

  # --- Memória
  rel+="\nMEMÓRIA E DISCO\n"
  ram_mb=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)
  local ram_txt; ram_txt=$(awk -v m="$ram_mb" 'BEGIN{printf "%.1f GB", m/1024}')
  local min_txt rec_txt
  min_txt=$(( (MIN_RAM + 500) / 1000 )); rec_txt=$(( (REC_RAM + 500) / 1000 ))
  if   [ "$ram_mb" -lt $MIN_RAM ]; then erro "RAM $ram_txt: mínimo $min_txt GB."
  elif [ "$ram_mb" -lt $REC_RAM ]; then av "RAM $ram_txt: funciona, recomendado $rec_txt GB."
  else ok "RAM $ram_txt"; fi
  if [ "$(awk '/SwapTotal/ {print $2}' /proc/meminfo)" = 0 ]; then
    av "Sem memória swap: se a RAM acabar, serviços podem ser encerrados."
  fi

  # --- Disco
  disco=$(df -BG --output=avail /var/lib 2>/dev/null | tail -1 | tr -dc '0-9'); disco=${disco:-0}
  if   [ "$disco" -lt $MIN_DISCO ]; then erro "Disco: ${disco} GB livres em /var/lib (mínimo ${MIN_DISCO} GB)."
  elif [ "$disco" -lt $REC_DISCO ]; then av "Disco: ${disco} GB livres em /var/lib (recomendado ${REC_DISCO} GB)."
  else ok "Disco: ${disco} GB livres em /var/lib"; fi

  # --- Sistema
  rel+="\nSISTEMA\n"
  case "${ID:-}:${VERSION_ID:-}" in
    debian:12|debian:13) ok "${PRETTY_NAME}" ;;
    ubuntu:22.04|ubuntu:24.04|ubuntu:2[4-9]*) ok "${PRETTY_NAME}" ;;
    *) av "${PRETTY_NAME:-?}: não testado (use Debian 12/13 ou Ubuntu 22.04+)." ;;
  esac
  if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ]; then
    ok "Relógio sincronizado (NTP)"
  else
    av "Relógio não sincronizado: confira a hora (timedatectl). Hora errada atrapalha logs e o reboot periódico."
  fi

  # --- Internet (pacotes, npm e Docker Hub)
  rel+="\nINTERNET\n"
  local site falhou=""
  for site in $SITES; do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$site" || true)" = 000 ] && falhou+=" ${site#https://}"
  done
  if [ -n "$falhou" ]; then erro "Sem acesso a:$falhou"
  else ok "Acesso aos repositórios ($(echo $SITES | sed 's#https://##g; s#/v2/##; s/ /, /g'))"; fi

  # --- Portas já usadas por outro programa (só na 1ª instalação)
  if [ ! -f "$RESP" ] && command -v ss >/dev/null; then
    local p ocupadas=""
    for p in $PORTAS_TESTE; do
      ss -ltnH "sport = :$p" 2>/dev/null | grep -q . && ocupadas+=" $p"
    done
    if [ -n "$ocupadas" ]; then av "Portas já em uso:$ocupadas (outro ACS/programa instalado?)"; else ok "Portas do GenieACS e do portal livres"; fi
  fi

  # --- Resultado
  if [ $erros -gt 0 ]; then
    whiptail --title "$TITULO — Verificação do hardware" --scrolltext --msgbox \
      "${rel}\n$erros problema(s) impedem a instalação. Corrija e rode o instalador de novo." 30 90
    clear; echo -e "Verificação do hardware:\n\n$rel"; echo "Instalação não iniciada."; exit 1
  fi
  local fim="Tudo certo: o servidor atende aos requisitos."
  [ $avisos -gt 0 ] && fim="$avisos aviso(s): a instalação funciona, mas veja os itens acima."
  whiptail --title "$TITULO — Verificação do hardware" --scrolltext --yes-button "Continuar" --no-button "Sair" \
    --yesno "${rel}\n$fim\n\nContinuar?" 30 90 || { clear; echo "Instalação cancelada. Nada foi alterado."; exit 1; }
}
verificar_hardware

I_GUEST=0
if [ -n "$GUEST_PKG" ]; then
  if dpkg -s "$GUEST_PKG" >/dev/null 2>&1; then
    I_GUEST=0
  elif sim_nao "Este servidor é uma $TIPO_MAQ.\n\nInstalar o agente da VM ($GUEST_PKG)?\nPermite desligar/reiniciar pelo hypervisor, ver o IP no painel e fazer\nbackup/snapshot consistente.\n\n(No Proxmox, ative também: VM > Options > QEMU Guest Agent)" 15; then
    I_GUEST=1
  fi
fi

# ============================================================================= ASSISTENTE
# --- 1. Opções extras do servidor ACS
on() { [ "${!1:-$2}" = 1 ] && echo ON || echo OFF; }   # marcação salva da última vez
if [ $I_ACS = 1 ]; then
  ESCOLHA=$(whiptail --title "$TITULO" --checklist "Opções do servidor ACS (ESPAÇO marca/desmarca):" 15 78 3 \
    BACKUP   "Backup diário criptografado (FTP/FTPS/SFTP)"            "$(on I_BACKUP 0)" \
    FIREWALL "Proteger API NBI 7557 (liberar só IPs informados)"     "$(on I_FIREWALL 1)" \
    SPEED    "Arquivo 100MB.bin do teste de velocidade (nginx :80)"  "$(on I_SPEED 1)" \
    3>&1 1>&2 2>&3) || cancelar
else
  ESCOLHA=""
fi
tem() { [[ " $ESCOLHA " == *"\"$1\""* ]]; }
I_BACKUP=0; I_FIREWALL=0; I_SPEED=0
tem BACKUP && I_BACKUP=1; tem FIREWALL && I_FIREWALL=1; tem SPEED && I_SPEED=1

# --- 1b. Sistema de gestão de clientes (ERP)
selsis() { [ "${SISTEMA:-sgp}" = "$1" ] && echo ON || echo OFF; }
SISTEMA=$(whiptail --title "$TITULO" --radiolist "Sistema de gestão de clientes (ERP) do provedor:\n\nO ACS consulta nele o contrato pelo serial/MAC do equipamento\ne o Wi-Fi para restaurar após reset." 16 78 3 \
  sgp     "SGP"                                   "$(selsis sgp)" \
  hubsoft "Hubsoft"                               "$(selsis hubsoft)" \
  nenhum  "Nenhum (sem consulta automática)"     "$(selsis nenhum)" \
  3>&1 1>&2 2>&3) || cancelar
case "$SISTEMA" in sgp) SISTEMA_NOME=SGP ;; hubsoft) SISTEMA_NOME=Hubsoft ;; *) SISTEMA_NOME=SGP ;; esac

# Escapa texto para dentro de uma string JSON
json_str() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
# Testa o login na API do Hubsoft (oAuth). Os dados vão pela entrada padrão do curl, não pela linha de comando.
testar_hubsoft() {
  local r
  r=$(printf '{"client_id":"%s","client_secret":"%s","username":"%s","password":"%s","grant_type":"password"}' \
      "$(json_str "$HUBSOFT_CLIENT_ID")" "$(json_str "$HUBSOFT_CLIENT_SECRET")" "$(json_str "$HUBSOFT_USUARIO")" "$(json_str "$HUBSOFT_SENHA")" \
    | curl -s --max-time 15 -H 'Content-Type: application/json' -H 'Accept: application/json' -d @- "$HUBSOFT_URL/oauth/token" || true)
  if printf '%s' "$r" | grep -q '"access_token"'; then return 0; fi
  HUBSOFT_ERRO=$(printf '%s' "$r" | grep -o '"message" *: *"[^"]*"' | head -1 | cut -d'"' -f4)
  [ -z "$HUBSOFT_ERRO" ] && HUBSOFT_ERRO=${r:0:120}
  [ -z "$HUBSOFT_ERRO" ] && HUBSOFT_ERRO="sem resposta de $HUBSOFT_URL"
  return 1
}
# Pergunta os dados da API do Hubsoft e testa o login (usados pelo ACS e pelo portal)
perguntar_hubsoft() {
  aviso "Hubsoft: use os dados de API criados pelo administrador do Hubsoft:\nURL da API, client_id, client_secret, usuário e senha da API.\n\n(documentação: https://docs.hubsoft.com.br)" 12
  while true; do
    while true; do
      HUBSOFT_URL=$(perguntar "Hubsoft — URL da API (ex.: https://api.suaempresa.hubsoft.com.br):" "${HUBSOFT_URL:-https://api.}")
      HUBSOFT_URL=${HUBSOFT_URL%/}
      [[ "$HUBSOFT_URL" =~ ^https?://[^/]+$ ]] && break
      aviso "Use só o endereço, sem caminho (ex.: https://api.suaempresa.hubsoft.com.br)." 8
    done
    HUBSOFT_CLIENT_ID=$(perguntar "Hubsoft — client_id:" "${HUBSOFT_CLIENT_ID:-}")
    HUBSOFT_CLIENT_SECRET=$(senha "Hubsoft — client_secret:")
    HUBSOFT_USUARIO=$(perguntar "Hubsoft — usuário da API:" "${HUBSOFT_USUARIO:-}")
    HUBSOFT_SENHA=$(senha "Hubsoft — senha do usuário da API:")
    if testar_hubsoft; then
      aviso "Login na API do Hubsoft: OK." 8; return 0
    fi
    sim_nao "NÃO consegui entrar na API do Hubsoft:\n\n  $HUBSOFT_ERRO\n\nConfira a URL, o client_id/client_secret e o usuário/senha da API.\n\nContinuar assim mesmo? (Não = digitar de novo)" 15 nao && return 0
  done
}

# --- 2. GenieACS
if [ $I_ACS = 1 ]; then
  ACS_HOST=$(perguntar "Nome ou IP que os ROTEADORES usam para falar com o ACS\n(ex.: acs.suaempresa.com.br ou $IP_LOCAL):" "${ACS_HOST:-$IP_LOCAL}")
  ACS_PORTA=$(pedir_porta "Porta CWMP (TR-069) do ACS:" "${ACS_PORTA:-7547}")
  CR_USER=$(perguntar "Usuário do Connection Request gravado nos roteadores:" "${CR_USER:-admin}")
  CR_PASS=$(senha "Senha do Connection Request gravada nos roteadores.\n(deixe vazio para gerar uma automaticamente)" "" gerar)
  NTP_SERVER=$(perguntar "Servidor NTP gravado nos roteadores:" "${NTP_SERVER:-pool.ntp.br}")
  def_cache=$(( RAM_GB / 2 - 1 )); [ $def_cache -lt 1 ] && def_cache=1
  MONGO_CACHE=$(perguntar "Memória do MongoDB em GB (cache WiredTiger).\nRecomendado: metade da RAM menos 1 (este servidor: ${RAM_GB} GB):" "${MONGO_CACHE:-$def_cache}")

  SGP_HOST=${SGP_HOST:-suaempresa.sgp.net.br}; SGP_TOKEN=""; HUBSOFT_CLIENT_SECRET=""; HUBSOFT_SENHA=""
  [ "$SISTEMA" = sgp ] || SGP_APP=""
  if [ "$SISTEMA" = sgp ]; then
    SGP_HOST=$(perguntar "Endereço da API do SGP (sem https://):" "$SGP_HOST")
    SGP_APP=$(perguntar "SGP — nome do APP (app):" "${SGP_APP:-}")
    SGP_TOKEN=$(senha "SGP — TOKEN da API:")
  elif [ "$SISTEMA" = hubsoft ]; then
    perguntar_hubsoft
  fi

  if [ $I_PORTAL = 0 ]; then
    # Portal em outro servidor: o ACS busca nele a cópia do Wi-Fi (restauração após reset) e o backup inclui os dados dele
    while true; do
      PORTAL_EXT_URL=$(perguntar "Endereço do PORTAL (no outro servidor), como os roteadores/ACS o acessam.\nEx.: http://192.168.10.3:8080\n\nDeixe vazio se o portal ainda não existe (dá para rodar o instalador de novo depois)." "${PORTAL_EXT_URL:-}" opcional)
      PORTAL_EXT_URL=${PORTAL_EXT_URL%/}
      [ -z "$PORTAL_EXT_URL" ] && break
      [[ "$PORTAL_EXT_URL" =~ ^https?://([^/:]+)(:[0-9]+)?$ ]] && { PORTAL_EXT_HOST=${BASH_REMATCH[1]}; break; }
      aviso "Use o formato http://IP:porta (ex.: http://192.168.10.3:8080)." 8
    done
  fi
fi

# --- 3. Portal
if [ $I_PORTAL = 1 ]; then
  PORTAL_PORTA=$(pedir_porta "Porta em que o portal vai abrir no navegador (nginx):" "${PORTAL_PORTA:-8080}")
  PORTAL_IP=$(pedir_ip "IP deste servidor visto pelos roteadores (recebe o upload do teste de velocidade):" "${PORTAL_IP:-$IP_LOCAL}")
  if [ $I_ACS = 1 ]; then
    NBI_URL_PORTAL="http://127.0.0.1:7557"
    ACS_IP="$PORTAL_IP"
  else
    while true; do
      ACS_IP=$(pedir_ip "IP do servidor GenieACS (no outro servidor):" "${ACS_IP:-}")
      NBI_URL_PORTAL="http://$ACS_IP:7557"
      # Testa a API NBI daqui (o firewall do ACS precisa liberar este servidor)
      if curl -fs --max-time 6 "$NBI_URL_PORTAL/presets/?projection=_id" >/dev/null; then
        aviso "Conexão com a API NBI em $NBI_URL_PORTAL: OK." 8; break
      fi
      sim_nao "NÃO consegui acessar a API NBI em $NBI_URL_PORTAL.\n\nConfira:\n - o IP do servidor GenieACS;\n - se o genieacs-nbi está rodando lá;\n - se o firewall do ACS libera a porta 7557 para este servidor ($PORTAL_IP).\n\nContinuar assim mesmo? (Não = digitar o IP de novo)" 16 nao && break
    done
    ACS_HOST=$(perguntar "Nome ou IP do ACS usado pelos roteadores (para o link do teste de velocidade):" "${ACS_HOST:-$ACS_IP}")
    BACKUP_TOKEN_EXT=""
    if sim_nao "O servidor ACS tem o BACKUP automático instalado?\n\n(se sim, o portal mostra os backups e inclui os dados dele;\no token fica no ACS em /etc/genieacs-backup/backup.env, linha TOKEN=)" 12 nao; then
      BACKUP_TOKEN_EXT=$(senha "TOKEN do backup (copie do servidor ACS: grep ^TOKEN= /etc/genieacs-backup/backup.env):")
    fi
  fi
  if [ "$SISTEMA" = hubsoft ]; then
    SGP_URL=""
    # Só o portal (ACS em outro servidor): o portal precisa da API para gravar o Wi-Fi no Hubsoft
    if [ $I_ACS = 0 ]; then
      HUBSOFT_CLIENT_SECRET=""; HUBSOFT_SENHA=""
      if sim_nao "Gravar no Hubsoft o Wi-Fi alterado pelo portal?\n\n(fica na Documentação de Senhas do serviço; o ACS usa para restaurar\no Wi-Fi após reset de fábrica)\n\nPrecisa dos dados da API do Hubsoft." 13; then
        perguntar_hubsoft
      fi
    fi
    CLIENTE_URL=$(perguntar "Link para abrir o cliente no Hubsoft (opcional).\nAbra um cliente no Hubsoft, copie o endereço do navegador e troque\no número do cliente (id_cliente) por {id}. Vazio = sem link." "${CLIENTE_URL:-}" opcional)
  elif [ "$SISTEMA" = sgp ]; then
    CLIENTE_URL=""
    SGP_URL=$(perguntar "Endereço do SGP para abrir a ficha do cliente (opcional):" "${SGP_URL:-https://${SGP_HOST:-suaempresa.sgp.net.br}}" opcional)
  else
    SGP_URL=""; CLIENTE_URL=""
  fi
  SPEED_DL=$(perguntar "Arquivo baixado pelos roteadores no teste de velocidade:" "${SPEED_DL:-http://$ACS_HOST/100MB.bin}")
  COOKIE_SECURE=0
  if sim_nao "Já existe um proxy HTTPS (com certificado) NA FRENTE do portal?\n\nEste instalador publica o portal só por HTTP (http://$PORTAL_IP:$PORTAL_PORTA).\nResponda SIM apenas se outro servidor/proxy já entrega o portal por https://.\n\nSe responder SIM e acessar por http://, o login NÃO funciona\n(volta sempre para a tela de entrada).\n\nNa dúvida, responda NÃO." 17 nao; then
    sim_nao "Confirma? O login só vai funcionar acessando por https://." 8 nao && COOKIE_SECURE=1
  fi
  ADMIN_USER=$(perguntar "Usuário administrador do portal:" "${ADMIN_USER:-admin}")
  if [ -f "$PORTAL_APP/data/users.json" ] && ! sim_nao "O portal já tem usuários.\n\nDefinir (ou trocar) a senha de \"$ADMIN_USER\" agora?" 10 nao; then
    ADMIN_PASS=""
  else
    while true; do
      ADMIN_PASS=$(senha "Senha do usuário \"$ADMIN_USER\" no portal (mínimo 8 caracteres):")
      [ ${#ADMIN_PASS} -ge 8 ] && break
      aviso "A senha precisa ter pelo menos 8 caracteres." 8
    done
  fi
fi
SPEED_DL=${SPEED_DL:-http://$ACS_HOST/100MB.bin}

# --- 4. Backup
if [ $I_BACKUP = 1 ]; then
  aviso "Backup diário (02:00): banco do GenieACS, configuração do servidor e dados do portal,\ncriptografado com AES-256 e enviado para FTP/FTPS/SFTP.\n\nExemplos de destino:\n  ftp://ftp.exemplo.com.br/backups/genieacs/\n  sftp://servidor.exemplo.com.br/backups/genieacs/" 14
  BK_URL=$(perguntar "Destino do backup (termine com /):" "${BK_URL:-ftp://}")
  BK_USER=$(perguntar "Usuário do destino:" "${BK_USER:-}")
  BK_PASS=$(senha "Senha do destino:")
  BK_TLS=1
  [[ "$BK_URL" == ftp://* ]] && ! sim_nao "Usar FTPS (FTP com TLS)? Recomendado." 8 && BK_TLS=0
  if [ ! -f /etc/genieacs-backup/senha ]; then
    BK_CRIPTO=$(senha "Senha de CRIPTOGRAFIA dos backups.\nDeixe vazio para gerar uma. GUARDE UMA CÓPIA FORA DO SERVIDOR:\nsem ela os backups não abrem." "" gerar)
  fi
fi

# --- 5. Firewall
if [ $I_FIREWALL = 1 ]; then
  while true; do
    def_fw="${FW_IPS:-}"
    if [ -z "$def_fw" ] && [ -n "${PORTAL_EXT_HOST:-}" ] && ip_valido "$PORTAL_EXT_HOST"; then def_fw="$PORTAL_EXT_HOST"; fi
    FW_IPS=$(perguntar "IPs que podem acessar a API NBI (7557) e a API de backup (7570),\nseparados por vírgula (portal, sistema de gestão). Este próprio servidor já é liberado:" "$def_fw" opcional)
    FW_IPS=$(echo "$FW_IPS" | tr -d ' ')
    ruim=""; for ip in ${FW_IPS//,/ }; do ip_valido "$ip" || ruim="$ip"; done
    [ -n "$ruim" ] && { aviso "IP inválido na lista: $ruim" 8; continue; }
    if [ -z "$FW_IPS" ] && [ $I_PORTAL = 0 ]; then
      sim_nao "Nenhum IP informado: o portal em outro servidor NÃO vai conseguir acessar o GenieACS.\n\nContinuar assim mesmo?" 10 nao || continue
    fi
    break
  done
fi

# --- 6. Provisions: valores e tarefas automáticas
if [ $I_ACS = 1 ]; then
  T_LIMPEZA=0; T_RESTART=1
  sim_nao "Ativar o reinício semanal do NBI/FS (domingo 06:30)?\n(libera memória acumulada — recomendado)" 10 || T_RESTART=0
  sim_nao "Ativar a LIMPEZA automática diária (07:00)?\n\nApaga do GenieACS equipamentos offline há 7+ dias que não estão\nvinculados ao $SISTEMA_NOME ou com contrato cancelado (máx. 10 por dia).\n\nSó ative se o $SISTEMA_NOME estiver configurado." 14 nao && T_LIMPEZA=1
  [ "$SISTEMA" = nenhum ] && T_LIMPEZA=0
fi

# --- Resumo
case "$MODO" in
  JUNTO)  MODO_TXT="Tudo no mesmo servidor (GenieACS + Portal)" ;;
  ACS)    MODO_TXT="Só o servidor ACS (portal em outro servidor)" ;;
  PORTAL) MODO_TXT="Só o Portal (GenieACS em $ACS_IP)" ;;
esac
RESUMO="Confira antes de instalar:\n\nTIPO: $MODO_TXT\nMÁQUINA: $TIPO_MAQ$([ $I_GUEST = 1 ] && echo " — instalar $GUEST_PKG" || true)\n\n"
if [ $I_ACS = 1 ]; then
  RESUMO+="GENIEACS $GENIEACS_VERSION + $MONGO_IMAGE (Docker, cache ${MONGO_CACHE} GB)\n"
  RESUMO+="  ACS dos roteadores: http://$ACS_HOST:$ACS_PORTA/\n"
  RESUMO+="  Connection Request: $CR_USER / ******    NTP: $NTP_SERVER\n"
  case "$SISTEMA" in
    sgp)     RESUMO+="  Sistema de gestão: SGP — $SGP_HOST (app ${SGP_APP:-?})\n" ;;
    hubsoft) RESUMO+="  Sistema de gestão: Hubsoft — ${HUBSOFT_URL:-?} (client_id ${HUBSOFT_CLIENT_ID:-?})\n" ;;
    *)       RESUMO+="  Sistema de gestão: nenhum (sem consulta automática)\n" ;;
  esac
  RESUMO+="  Reinício semanal: $([ $T_RESTART = 1 ] && echo sim || echo não)   Limpeza offline: $([ $T_LIMPEZA = 1 ] && echo sim || echo não)\n"
  RESUMO+="  Teste de velocidade (100MB.bin na porta 80): $([ $I_SPEED = 1 ] && echo sim || echo não)\n"
  RESUMO+="  Firewall NBI: $([ $I_FIREWALL = 1 ] && echo "liberado para 127.0.0.1,$IP_LOCAL${FW_IPS:+,$FW_IPS}" || echo não)\n"
  [ $I_PORTAL = 0 ] && RESUMO+="  Portal (outro servidor): ${PORTAL_EXT_URL:-não informado}\n"
  RESUMO+="\n"
fi
if [ $I_PORTAL = 1 ]; then
  RESUMO+="PORTAL em http://$PORTAL_IP:$PORTAL_PORTA  (usuário $ADMIN_USER)\n"
  RESUMO+="  NBI: $NBI_URL_PORTAL\n  Download do teste: $SPEED_DL\n  HTTPS: $([ $COOKIE_SECURE = 1 ] && echo sim || echo não)\n"
  [ $I_ACS = 0 ] && RESUMO+="  Backup do ACS no portal: $([ -n "${BACKUP_TOKEN_EXT:-}" ] && echo sim || echo não)\n"
  RESUMO+="\n"
fi
[ $I_BACKUP = 1 ] && RESUMO+="BACKUP diário 02:00 para $BK_URL (usuário $BK_USER)\n"
sim_nao "$RESUMO\nInstalar agora?" 26 || { clear; echo "Instalação cancelada. Nada foi alterado."; exit 1; }

# Salva as respostas (sem senhas) para a próxima vez
( umask 077
  for k in MODO SISTEMA HUBSOFT_URL HUBSOFT_CLIENT_ID HUBSOFT_USUARIO CLIENTE_URL PORTAL_EXT_URL I_ACS I_PORTAL I_BACKUP I_FIREWALL I_SPEED ACS_HOST ACS_PORTA CR_USER NTP_SERVER MONGO_CACHE SGP_HOST SGP_APP \
           PORTAL_PORTA PORTAL_IP ACS_IP SGP_URL SPEED_DL ADMIN_USER BK_URL BK_USER FW_IPS; do
    printf '%s=%q\n' "$k" "${!k:-}"
  done > "$RESP" )

# ============================================================================= INSTALAÇÃO
clear
exec > >(tee -a "$LOG") 2>&1
echo "===== $(date '+%d/%m/%Y %H:%M:%S') — instalação iniciada (projeto em $SRC)"
trap 'falha "a etapa acima falhou (linha $LINENO)."' ERR

# Node.js 18+ (Ubuntu 22.04 vem com o 12: usa o repositório oficial NodeSource, Node 20)
garantir_node() {
  local ok=0
  apt-get install -y -qq nodejs >/dev/null 2>&1 || true
  command -v node >/dev/null && node -e 'process.exit(+process.versions.node.split(".")[0]>=18?0:1)' && ok=1
  if [ $ok = 0 ]; then
    etapa "Node.js do sistema é antigo: instalando Node.js 20 (NodeSource)"
    apt-get install -y -qq curl gnupg ca-certificates >/dev/null
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq && apt-get install -y nodejs
  fi
  echo "Node.js $(node -v)"
}

etapa "Atualizando lista de pacotes"
apt-get update -qq
apt-get install -y -qq curl ca-certificates openssl tar >/dev/null
garantir_node

if [ $I_GUEST = 1 ]; then
  etapa "Agente da máquina virtual ($GUEST_PKG)"
  apt-get install -y "$GUEST_PKG"
  # O qemu-guest-agent só sobe se a opção "QEMU Guest Agent" estiver ligada na VM (Proxmox)
  if [ "$GUEST_PKG" = qemu-guest-agent ]; then
    systemctl start qemu-guest-agent 2>/dev/null \
      || echo "Agente instalado. Ligue a opção 'QEMU Guest Agent' na VM (Proxmox: Options) e reinicie a VM."
  fi
fi

# ----------------------------------------------------------------------------- GenieACS
if [ $I_ACS = 1 ]; then
  etapa "Docker e MongoDB ($MONGO_IMAGE)"
  command -v docker >/dev/null || apt-get install -y docker.io
  systemctl enable --now docker
  printf "w /sys/kernel/mm/transparent_hugepage/enabled - - - - never\n" > /etc/tmpfiles.d/mongodb-thp.conf
  systemd-tmpfiles --create /etc/tmpfiles.d/mongodb-thp.conf || true
  if docker ps -a --format '{{.Names}}' | grep -qx mongodb; then
    echo "Contêiner 'mongodb' já existe: mantido (dados preservados)."
    docker start mongodb >/dev/null
  else
    mkdir -p /var/lib/mongodb-docker
    docker run -d --name mongodb --restart unless-stopped -p 127.0.0.1:27017:27017 \
      -v /var/lib/mongodb-docker:/data/db "$MONGO_IMAGE" --wiredTigerCacheSizeGB "$MONGO_CACHE"
  fi
  echo -n "Aguardando o MongoDB"
  for i in $(seq 1 60); do
    docker exec mongodb mongo --quiet --eval 'db.runCommand({ping:1}).ok' 2>/dev/null | grep -q 1 && break
    echo -n "."; sleep 2
    [ $i = 60 ] && falha "MongoDB não respondeu (docker logs mongodb)"
  done
  echo " ok"

  etapa "GenieACS $GENIEACS_VERSION (npm)"
  command -v npm >/dev/null || apt-get install -y npm
  if ! command -v genieacs-cwmp >/dev/null || ! npm ls -g genieacs 2>/dev/null | grep -q "genieacs@$GENIEACS_VERSION"; then
    npm install -g --no-fund --no-audit "genieacs@$GENIEACS_VERSION"
  fi
  BIN=$(dirname "$(command -v genieacs-cwmp)")
  id genieacs >/dev/null 2>&1 || useradd --system --no-create-home --user-group genieacs
  mkdir -p /opt/genieacs/ext /var/log/genieacs

  GENV=/opt/genieacs/genieacs.env
  if [ ! -f $GENV ]; then
    cat > $GENV <<EOF
GENIEACS_CWMP_ACCESS_LOG_FILE=/var/log/genieacs/genieacs-cwmp-access.log
GENIEACS_NBI_ACCESS_LOG_FILE=/var/log/genieacs/genieacs-nbi-access.log
GENIEACS_FS_ACCESS_LOG_FILE=/var/log/genieacs/genieacs-fs-access.log
GENIEACS_UI_ACCESS_LOG_FILE=/var/log/genieacs/genieacs-ui-access.log
GENIEACS_DEBUG_FILE=/var/log/genieacs/genieacs-debug.yaml
GENIEACS_EXT_DIR=/opt/genieacs/ext
GENIEACS_MONGODB_CONNECTION_URL=mongodb://127.0.0.1/genieacs
GENIEACS_UI_JWT_SECRET=$(gerar_segredo 48)
NODE_OPTIONS=--enable-source-maps
EOF
  fi
  set_env $GENV GENIEACS_FS_HOSTNAME "$ACS_HOST"
  set_env $GENV GENIEACS_CWMP_PORT "$ACS_PORTA"

  SGPENV=/opt/genieacs/sgp.env
  do_exemplo "$SRC/acs/sgp.env.example" $SGPENV
  # "nenhum" fica como sgp sem credenciais: a provision marca ERRO_SGP e não mexe em nada
  set_env $SGPENV SISTEMA "$([ "$SISTEMA" = hubsoft ] && echo hubsoft || echo sgp)"
  set_env $SGPENV SGP_HOST "$SGP_HOST"
  set_env $SGPENV SGP_APP "$SGP_APP"
  [ -n "${SGP_TOKEN:-}" ] && set_env $SGPENV SGP_TOKEN "$SGP_TOKEN"
  [ "$SISTEMA" = nenhum ] && set_env $SGPENV SGP_TOKEN ""
  if [ "$SISTEMA" = hubsoft ]; then
    set_env $SGPENV HUBSOFT_URL "$HUBSOFT_URL"
    set_env $SGPENV HUBSOFT_CLIENT_ID "$HUBSOFT_CLIENT_ID"
    set_env $SGPENV HUBSOFT_USUARIO "$HUBSOFT_USUARIO"
    [ -n "${HUBSOFT_CLIENT_SECRET:-}" ] && set_env $SGPENV HUBSOFT_CLIENT_SECRET "$HUBSOFT_CLIENT_SECRET"
    [ -n "${HUBSOFT_SENHA:-}" ] && set_env $SGPENV HUBSOFT_SENHA "$HUBSOFT_SENHA"
    rm -f /opt/genieacs/.hubsoft-token.json      # credenciais podem ter mudado: pega token novo
    # Uma consulta no Hubsoft pode precisar de 3 requisições (token + CPE/patrimônio + serviço)
    set_env $GENV GENIEACS_EXT_TIMEOUT 10000
  fi
  if [ $I_PORTAL = 1 ]; then
    # Portal na mesma máquina: direto no Node (127.0.0.1:3100), sem passar pelo nginx. Pelo IP público, atrás de NAT,
    # o pedido volta pelo roteador com o IP dele (ex.: 192.168.0.254) e o portal recusa (403) — visto na Superi em 25/11/2026.
    set_env $SGPENV WIFI_PORTAL_URL "http://127.0.0.1:3100"
  elif [ -n "${PORTAL_EXT_URL:-}" ]; then
    set_env $SGPENV WIFI_PORTAL_URL "$PORTAL_EXT_URL"
  fi

  cp "$SRC/acs/servidor/limpeza-offline.js" /opt/genieacs/limpeza-offline.js
  sed -i 's/\r$//' /opt/genieacs/limpeza-offline.js
  chown -R genieacs:genieacs /opt/genieacs /var/log/genieacs
  chmod 600 $GENV $SGPENV

  etapa "Serviços systemd do GenieACS"
  for s in cwmp nbi fs ui; do
    cat > /etc/systemd/system/genieacs-$s.service <<EOF
[Unit]
Description=GenieACS $s
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
User=genieacs
EnvironmentFile=/opt/genieacs/genieacs.env
ExecStart=$BIN/genieacs-$s
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  done
  sed 's/\r$//' "$SRC/acs/servidor/genieacs-logrotate" > /etc/logrotate.d/genieacs
  for u in genieacs-restart-semanal genieacs-limpeza-offline; do
    sed 's/\r$//' "$SRC/acs/servidor/$u.service" > /etc/systemd/system/$u.service
    sed 's/\r$//' "$SRC/acs/servidor/$u.timer"   > /etc/systemd/system/$u.timer
  done
  systemctl daemon-reload
  systemctl enable --now genieacs-cwmp genieacs-nbi genieacs-fs genieacs-ui
  if [ $T_RESTART = 1 ]; then systemctl enable --now genieacs-restart-semanal.timer; else systemctl disable --now genieacs-restart-semanal.timer 2>/dev/null || true; fi
  if [ $T_LIMPEZA = 1 ]; then systemctl enable --now genieacs-limpeza-offline.timer; else systemctl disable --now genieacs-limpeza-offline.timer 2>/dev/null || true; fi

  echo -n "Aguardando a API NBI (7557)"
  for i in $(seq 1 30); do
    curl -fs http://127.0.0.1:7557/presets/ >/dev/null && break
    echo -n "."; sleep 2
    [ $i = 30 ] && falha "API NBI não respondeu (journalctl -u genieacs-nbi)"
  done
  echo " ok"

  etapa "Configuração das provisions (acs/acs.env)"
  AENV="$SRC/acs/acs.env"
  do_exemplo "$SRC/acs/acs.env.example" "$AENV"
  if [ -z "${CR_PASS:-}" ]; then
    # Mantém a senha que já estava no acs.env (reinstalação); senão gera uma nova
    CR_PASS=$(awk -F= 'index($0,"CR_PASS=")==1 {sub(/^CR_PASS=/,""); print; exit}' "$AENV")
    [ -z "$CR_PASS" ] && CR_PASS=$(gerar_segredo 18) && echo "Senha do Connection Request gerada automaticamente (fica em $AENV)."
  fi
  set_env "$AENV" NBI_URL "http://127.0.0.1:7557"
  set_env "$AENV" ACS_URL "http://$ACS_HOST:$ACS_PORTA/"
  set_env "$AENV" CR_USER "$CR_USER"
  set_env "$AENV" CR_PASS "$CR_PASS"
  set_env "$AENV" SPEEDTEST_URL "$SPEED_DL"
  set_env "$AENV" NTP_SERVER "$NTP_SERVER"
  set_env "$AENV" GENIEACS_EXT_DIR "/opt/genieacs/ext"
  chmod 600 "$AENV"
  # Confere antes de publicar: nenhuma variável usada nas provisions pode ficar vazia
  VAZIAS=""
  for k in $(cat "$SRC"/acs/provisions/* "$SRC"/acs/presets/* "$SRC"/acs/virtual_parameters/* 2>/dev/null | grep -o '{{[A-Z0-9_]*}}' | tr -d '{}' | sort -u); do
    v=$(awk -F= -v k="$k" 'index($0,k"=")==1 {sub(/^[^=]*=/,""); print; exit}' "$AENV")
    [ -z "$v" ] && VAZIAS+=" $k"
  done
  [ -n "$VAZIAS" ] && falha "variáveis vazias em $AENV:$VAZIAS — preencha (nano $AENV) e rode o instalador de novo."
  echo "acs.env conferido: todas as variáveis das provisions estão preenchidas."

  etapa "Simulação da publicação (nada é gravado)"
  ( cd "$SRC/acs" && node deploy-acs.js --dry-run ) | tee /tmp/globaltech-dryrun.txt
  if whiptail --title "$TITULO" --scrolltext --yesno "Resultado da simulação:\n\n$(cat /tmp/globaltech-dryrun.txt)\n\nPublicar provisions, presets, virtual parameters e extensões agora?" 24 78 </dev/tty >/dev/tty; then
    etapa "Publicando no GenieACS (com backup do que já existia)"
    ( cd "$SRC/acs" && node deploy-acs.js --install-ext )
    chown genieacs:genieacs /opt/genieacs/ext/*
    systemctl restart genieacs-cwmp
    if [ "$SISTEMA" = hubsoft ] && [ -f /opt/genieacs/ext/hubsoft ]; then
      etapa "Teste da extensão com o Hubsoft (como o usuário genieacs)"
      ( cd /opt/genieacs && runuser -u genieacs -- node /opt/genieacs/ext/hubsoft --testar ) \
        || echo "ATENÇÃO: a extensão não conseguiu entrar no Hubsoft. Confira HUBSOFT_* em /opt/genieacs/sgp.env."
    fi
  else
    echo "Publicação pulada. Para publicar depois: cd $SRC/acs && node deploy-acs.js --install-ext"
  fi
  rm -f /tmp/globaltech-dryrun.txt

  if [ $I_SPEED = 1 ]; then
    etapa "Arquivo do teste de velocidade (nginx, porta 80)"
    command -v nginx >/dev/null || apt-get install -y nginx
    mkdir -p /var/www/html
    [ -f /var/www/html/100MB.bin ] || head -c 104857600 /dev/urandom > /var/www/html/100MB.bin
    chmod 644 /var/www/html/100MB.bin
    systemctl enable --now nginx
  fi

  if [ $I_FIREWALL = 1 ]; then
    etapa "Firewall da API NBI (7557) e do backup (7570)"
    command -v iptables >/dev/null || apt-get install -y iptables
    FW=/usr/local/sbin/genieacs-firewall.sh
    [ -f $FW ] && cp $FW "$FW.bak-$(date +%Y%m%d-%H%M%S)"
    {
      echo '#!/bin/sh'
      echo '# Gerado pelo instalador Globaltech: só os IPs abaixo acessam 7557 (NBI) e 7570 (backup)'
      echo 'iptables -N GENIEACS-NBI 2>/dev/null || iptables -F GENIEACS-NBI'
      for ip in 127.0.0.1 $IP_LOCAL ${FW_IPS//,/ }; do echo "iptables -A GENIEACS-NBI -s $ip -j ACCEPT"; done
      echo 'iptables -A GENIEACS-NBI -j DROP'
      echo 'iptables -C INPUT -p tcp -m multiport --dports 7557,7570 -j GENIEACS-NBI 2>/dev/null || iptables -I INPUT -p tcp -m multiport --dports 7557,7570 -j GENIEACS-NBI'
    } > $FW
    chmod 750 $FW
    cat > /etc/systemd/system/genieacs-firewall.service <<EOF
[Unit]
Description=Firewall da API NBI do GenieACS
After=network-online.target docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$FW

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable genieacs-firewall >/dev/null
    systemctl restart genieacs-firewall
  fi
fi

# ----------------------------------------------------------------------------- Portal
if [ $I_PORTAL = 1 ]; then
  etapa "Portal Globaltech (deploy/install.sh)"
  ( cd "$SRC/portal" && PORTAL_PORT="$PORTAL_PORTA" bash deploy/install.sh )
  PENV="$PORTAL_APP/.env"
  set_env "$PENV" NBI_URL "$NBI_URL_PORTAL"
  set_env "$PENV" SGP_URL "$SGP_URL"
  set_env "$PENV" SISTEMA_NOME "$SISTEMA_NOME"
  set_env "$PENV" CLIENTE_URL "${CLIENTE_URL:-}"
  # Hubsoft: o portal grava o Wi-Fi alterado na Documentação de Senhas do serviço
  if [ "$SISTEMA" = hubsoft ] && [ -n "${HUBSOFT_URL:-}" ]; then
    set_env "$PENV" HUBSOFT_URL "$HUBSOFT_URL"
    set_env "$PENV" HUBSOFT_CLIENT_ID "${HUBSOFT_CLIENT_ID:-}"
    set_env "$PENV" HUBSOFT_USUARIO "${HUBSOFT_USUARIO:-}"
    [ -n "${HUBSOFT_CLIENT_SECRET:-}" ] && set_env "$PENV" HUBSOFT_CLIENT_SECRET "$HUBSOFT_CLIENT_SECRET"
    [ -n "${HUBSOFT_SENHA:-}" ] && set_env "$PENV" HUBSOFT_SENHA "$HUBSOFT_SENHA"
  fi
  set_env "$PENV" COOKIE_SECURE "$COOKIE_SECURE"
  # Quem cria o portal pode atualizar o sistema pela página Atualizações (mantém se já foi configurado)
  grep -q "^ATUALIZAR_USUARIOS=" "$PENV" || set_env "$PENV" ATUALIZAR_USUARIOS "$ADMIN_USER"
  set_env "$PENV" SPEEDTEST_DOWNLOAD_URL "$SPEED_DL"
  set_env "$PENV" SPEEDTEST_UPLOAD_BASE "http://$PORTAL_IP:$PORTAL_PORTA/speedtest/upload"
  if [ $I_ACS = 1 ]; then
    set_env "$PENV" WIFI_BACKUP_ALLOW "127.0.0.1,$PORTAL_IP"
  else
    set_env "$PENV" WIFI_BACKUP_ALLOW "$ACS_IP"
    if [ -n "${BACKUP_TOKEN_EXT:-}" ]; then
      set_env "$PENV" BACKUP_AGENT_URL "http://$ACS_IP:7570"
      set_env "$PENV" BACKUP_TOKEN "$BACKUP_TOKEN_EXT"
    fi
  fi
  ADMIN_OK=1
  if [ -n "${ADMIN_PASS:-}" ]; then
    etapa "Usuário \"$ADMIN_USER\" do portal"
    # A senha vai pela entrada padrão (printf é interno do bash: não aparece na lista de processos nem no log)
    if ( cd "$PORTAL_APP" && printf '%s' "$ADMIN_PASS" | runuser -u portal -- node -e '
        const pw = require("fs").readFileSync(0, "utf8");
        if (pw.length < 8) { console.error("Senha vazia ou curta."); process.exit(1); }
        const a = require("./lib/auth"); const u = a.loadUsers();
        const ex = !!u[process.argv[1]];
        u[process.argv[1]] = { name: process.argv[2], hash: a.hashPassword(pw) };
        a.saveUsers(u); console.log(ex ? "Senha do usuário alterada." : "Usuário criado.");' "$ADMIN_USER" "Administrador" ) \
       && ( cd "$PORTAL_APP" && printf '%s' "$ADMIN_PASS" | runuser -u portal -- node -e '
        // Confere: lê o arquivo de novo e testa a senha do mesmo jeito que o login faz
        const c = require("crypto"), fs = require("fs");
        const pw = fs.readFileSync(0, "utf8");
        const u = JSON.parse(fs.readFileSync(require("./lib/env").USERS_FILE, "utf8"))[process.argv[1]];
        const [alg, s, h] = String(u && u.hash).split("$");
        const ok = alg === "scrypt" && c.scryptSync(pw, Buffer.from(s, "hex"), 64).toString("hex") === h;
        console.log(ok ? "Senha conferida: o login vai funcionar." : "A senha gravada NÃO confere.");
        process.exit(ok ? 0 : 1);' "$ADMIN_USER" ); then
      :
    else
      ADMIN_OK=0
      echo "ATENÇÃO: não foi possível criar/conferir o usuário \"$ADMIN_USER\" (veja as mensagens acima)."
    fi
  fi
fi

# ----------------------------------------------------------------------------- Backup
if [ $I_BACKUP = 1 ]; then
  etapa "Backup automático"
  mkdir -p /opt/genieacs-backup /etc/genieacs-backup /var/lib/genieacs-backup
  chmod 700 /etc/genieacs-backup /var/lib/genieacs-backup
  sed 's/\r$//' "$SRC/acs/servidor/backup/genieacs-backup.js" > /opt/genieacs-backup/genieacs-backup.js
  BENV=/etc/genieacs-backup/backup.env
  do_exemplo "$SRC/acs/servidor/backup/backup.env.example" $BENV
  chmod 600 $BENV
  set_env $BENV DESTINO_URL "$BK_URL"
  set_env $BENV DESTINO_USUARIO "$BK_USER"
  set_env $BENV DESTINO_SENHA "$BK_PASS"
  set_env $BENV FTP_TLS "$BK_TLS"
  BK_TOKEN=$(grep -m1 '^TOKEN=' $BENV | cut -d= -f2- || true)
  [ -z "$BK_TOKEN" ] && BK_TOKEN=$(gerar_segredo 40) && set_env $BENV TOKEN "$BK_TOKEN"
  [ $I_PORTAL = 0 ] && [ -n "${PORTAL_EXT_URL:-}" ] && set_env $BENV PORTAL_URL "$PORTAL_EXT_URL"
  if [ $I_PORTAL = 1 ]; then
    set_env $BENV PORTAL_URL "http://127.0.0.1:3100"   # mesma máquina: direto no Node (ver WIFI_PORTAL_URL)
    set_env "$PORTAL_APP/.env" BACKUP_AGENT_URL "http://127.0.0.1:7570"
    set_env "$PORTAL_APP/.env" BACKUP_TOKEN "$BK_TOKEN"
  fi
  if [ ! -f /etc/genieacs-backup/senha ]; then
    printf '%s' "$BK_CRIPTO" > /etc/genieacs-backup/senha
    chmod 600 /etc/genieacs-backup/senha
  fi
  for u in genieacs-backup.service genieacs-backup.timer genieacs-backup-api.service; do
    sed 's/\r$//' "$SRC/acs/servidor/backup/$u" > /etc/systemd/system/$u
  done
  systemctl daemon-reload
  systemctl enable --now genieacs-backup.timer genieacs-backup-api.service
fi

[ $I_PORTAL = 1 ] && systemctl restart globaltech-portal

# ============================================================================= ATUALIZADOR
# Atualizações depois pelo portal (Configuração → Atualizações), a partir das versões marcadas no GitHub.
# O acs.env vai para /etc/globaltech-acs (vale para todas as versões); reinstalar sempre recopia o daqui.
etapa "Atualizador (versões do GitHub)"
mkdir -p /etc/globaltech-acs; chmod 700 /etc/globaltech-acs
[ $I_ACS = 1 ] && [ -f "$SRC/acs/acs.env" ] && install -m 600 "$SRC/acs/acs.env" /etc/globaltech-acs/acs.env
bash "$SRC/atualizador/instalar-atualizador.sh" || echo "AVISO: o atualizador não foi instalado (rode depois: bash $SRC/atualizador/instalar-atualizador.sh)"

# ============================================================================= FIM
trap - ERR
etapa "Conferindo serviços"
OKS=""
for s in genieacs-cwmp genieacs-nbi genieacs-fs genieacs-ui globaltech-portal genieacs-backup-api; do
  systemctl list-unit-files "$s.service" >/dev/null 2>&1 && systemctl is-enabled --quiet "$s" 2>/dev/null || continue
  st=$(systemctl is-active "$s" || true); OKS+="  $s: $st\n"; echo "$s: $st"
done

FIM="Instalação concluída!\n\nServiços:\n$OKS\n"
[ $I_ACS = 1 ] && FIM+="GenieACS (interface): http://$IP_LOCAL:3000  (cria o admin no 1º acesso)\nRoteadores devem apontar para: http://$ACS_HOST:$ACS_PORTA/\n\n"
if [ $I_PORTAL = 1 ]; then
  FIM+="Portal: http://$PORTAL_IP:$PORTAL_PORTA   usuário: $ADMIN_USER\n"
  if [ "${ADMIN_OK:-1}" = 0 ]; then
    FIM+="  !! O usuário NÃO foi criado. Crie com:\n"
  fi
  FIM+="  Criar/trocar senha de usuário do portal:\n    cd $PORTAL_APP && runuser -u portal -- node scripts/add-user.js $ADMIN_USER \"Administrador\"\n"
  [ "${COOKIE_SECURE:-0}" = 1 ] && FIM+="  HTTPS ligado: o login só funciona acessando por https:// (por http o navegador descarta o cookie).\n  Para usar por http: COOKIE_SECURE=0 em $PORTAL_APP/.env e systemctl restart globaltech-portal\n"
  FIM+="\n"
fi
[ $I_BACKUP = 1 ] && FIM+="IMPORTANTE: guarde FORA do servidor a senha de criptografia do backup:\n  cat /etc/genieacs-backup/senha\n\n"
if [ "$MODO" = ACS ]; then
  FIM+="NO SERVIDOR DO PORTAL (rode este instalador lá, opção \"Só o Portal\"):\n"
  FIM+="  IP do GenieACS: $IP_LOCAL\n"
  [ $I_BACKUP = 1 ] && FIM+="  Token do backup: grep ^TOKEN= /etc/genieacs-backup/backup.env (neste servidor)\n"
  [ -z "${PORTAL_EXT_URL:-}" ] && FIM+="  Depois rode este instalador de novo aqui e informe o endereço do portal.\n"
  FIM+="\n"
elif [ "$MODO" = PORTAL ]; then
  FIM+="NO SERVIDOR DO GENIEACS ($ACS_IP), confira:\n"
  FIM+="  - porta 7557 (e 7570 do backup) liberada para este servidor ($PORTAL_IP);\n"
  FIM+="  - /opt/genieacs/sgp.env com WIFI_PORTAL_URL=http://$PORTAL_IP:$PORTAL_PORTA\n"
  FIM+="    (o instalador do ACS faz isso se você informar o endereço do portal).\n\n"
fi
FIM+="Libere no firewall externo as portas usadas (${ACS_PORTA:-}${ACS_PORTA:+ CWMP, }7567 firmware${PORTAL_PORTA:+, $PORTAL_PORTA portal}).\nLog da instalação: $LOG"
whiptail --title "$TITULO" --msgbox "$FIM" 26 78 </dev/tty >/dev/tty || true
echo; echo -e "$FIM"
