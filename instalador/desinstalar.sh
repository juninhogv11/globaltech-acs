#!/usr/bin/env bash
# =============================================================================
#  Desinstalador — Globaltech ACS
#  Remove o que o instalador (instalador/instalar.sh) colocou no servidor:
#  GenieACS + MongoDB (Docker), Portal, backup automático, firewall da NBI e timers.
#
#  Uso, como root:
#    bash instalador/desinstalar.sh            # pergunta antes e oferece salvar uma cópia
#    bash instalador/desinstalar.sh --sim      # sem perguntas (salva a cópia em /root mesmo assim)
#
#  Não remove pacotes do sistema (Docker, Node.js, nginx, curl), que o instalador reaproveita,
#  nem os outros sites do nginx.
# =============================================================================
set -uo pipefail

TITULO="Desinstalador Globaltech ACS"
SEM_PERGUNTAS=0; [ "${1:-}" = "--sim" ] && SEM_PERGUNTAS=1
DATA=$(date +%Y%m%d-%H%M%S)
COPIA_DIR="/root/globaltech-copia-$DATA"
LOG=/var/log/globaltech-desinstalador.log

[ "$(id -u)" = 0 ] || { echo "Rode como root (entre com 'su -' e depois: bash $0)"; exit 1; }
command -v whiptail >/dev/null || SEM_PERGUNTAS_TELA=1

perguntar_sim() {   # perguntar_sim "texto" [altura] [nao]
  [ $SEM_PERGUNTAS = 1 ] && return 0
  if [ -z "${SEM_PERGUNTAS_TELA:-}" ]; then
    whiptail --title "$TITULO" ${3:+--defaultno} --yesno "$1" "${2:-12}" 76
  else
    local r; echo -e "$1"; read -r -p "[s/N] " r; [[ "$r" =~ ^[sS] ]]
  fi
}

# ----------------------------------------------------------------------------- o que existe
existe() { [ -e "$1" ]; }
ACHADO=""
existe /opt/genieacs                 && ACHADO+="  - GenieACS (/opt/genieacs, serviços genieacs-*)\n"
docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx mongodb && ACHADO+="  - MongoDB em Docker (contêiner 'mongodb', dados em /var/lib/mongodb-docker)\n"
existe /opt/globaltech-portal        && ACHADO+="  - Portal (/opt/globaltech-portal: usuários, fotos, cópias de Wi-Fi)\n"
existe /etc/genieacs-backup          && ACHADO+="  - Backup automático (/etc/genieacs-backup, inclui a SENHA de criptografia)\n"
existe /usr/local/sbin/genieacs-firewall.sh && ACHADO+="  - Firewall da API NBI (7557/7570)\n"
existe /etc/globaltech-instalador    && ACHADO+="  - Respostas salvas do instalador\n"

if [ -z "$ACHADO" ]; then
  echo "Nada do Globaltech ACS instalado neste servidor."; exit 0
fi

perguntar_sim "Serão REMOVIDOS deste servidor:\n\n$ACHADO\nOs equipamentos cadastrados no GenieACS e os dados do portal serão apagados.\nDocker, Node.js e nginx continuam instalados.\n\nContinuar?" 20 nao \
  || { echo "Nada foi removido."; exit 1; }

# Confirmação forte: digitar REMOVER
if [ $SEM_PERGUNTAS = 0 ]; then
  if [ -z "${SEM_PERGUNTAS_TELA:-}" ]; then
    conf=$(whiptail --title "$TITULO" --inputbox "Para confirmar, digite REMOVER (em maiúsculas):" 10 60 3>&1 1>&2 2>&3) || conf=""
  else
    read -r -p "Para confirmar, digite REMOVER: " conf
  fi
  [ "$conf" = "REMOVER" ] || { echo "Confirmação não digitada. Nada foi removido."; exit 1; }
fi

SALVAR=1
perguntar_sim "Salvar uma CÓPIA antes de remover?\n\nEm $COPIA_DIR (só root lê):\n  - banco do GenieACS (mongodump)\n  - dados e .env do portal\n  - /opt/genieacs (genieacs.env, sgp.env, extensões)\n  - configuração e senha do backup\n\nRecomendado." 16 || SALVAR=0

clear 2>/dev/null || true
exec > >(tee -a "$LOG") 2>&1
echo "===== $(date '+%d/%m/%Y %H:%M:%S') — desinstalação iniciada"
etapa() { echo; echo "==> $*"; }

# ----------------------------------------------------------------------------- cópia
if [ $SALVAR = 1 ]; then
  etapa "Cópia de segurança em $COPIA_DIR"
  mkdir -p "$COPIA_DIR"; chmod 700 "$COPIA_DIR"
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx mongodb; then
    if docker exec mongodb mongodump --quiet --db genieacs --gzip --archive > "$COPIA_DIR/genieacs.archive.gz"; then
      echo "Banco salvo: genieacs.archive.gz"
    else
      echo "ATENÇÃO: não consegui salvar o banco (mongodump falhou)."
      rm -f "$COPIA_DIR/genieacs.archive.gz"
      if [ $SEM_PERGUNTAS = 0 ] && ! perguntar_sim "A cópia do BANCO falhou.\n\nContinuar a remoção mesmo assim?" 10 nao; then
        echo "Parado. Nada foi removido (a cópia parcial ficou em $COPIA_DIR)."; exit 1
      fi
    fi
  fi
  ARQS=()
  for p in opt/genieacs opt/globaltech-portal/data opt/globaltech-portal/.env etc/genieacs-backup etc/globaltech-instalador; do
    [ -e "/$p" ] && ARQS+=("$p")
  done
  [ ${#ARQS[@]} -gt 0 ] && tar czf "$COPIA_DIR/arquivos.tar.gz" -C / "${ARQS[@]}" && echo "Arquivos salvos: arquivos.tar.gz (${ARQS[*]})"
  chmod 600 "$COPIA_DIR"/* 2>/dev/null
fi

# ----------------------------------------------------------------------------- remoção
etapa "Parando e removendo os serviços"
UNIDADES="genieacs-cwmp genieacs-nbi genieacs-fs genieacs-ui globaltech-portal genieacs-backup-api genieacs-firewall
genieacs-backup.timer genieacs-restart-semanal.timer genieacs-limpeza-offline.timer"
for u in $UNIDADES; do systemctl disable --now "$u" >/dev/null 2>&1 && echo "parado: $u"; done
rm -f /etc/systemd/system/genieacs-*.service /etc/systemd/system/genieacs-*.timer /etc/systemd/system/globaltech-portal.service
rm -f /etc/systemd/system/multi-user.target.wants/genieacs-* /etc/systemd/system/timers.target.wants/genieacs-*
systemctl daemon-reload

etapa "MongoDB (contêiner e dados)"
docker rm -f mongodb >/dev/null 2>&1 && echo "contêiner mongodb removido"
rm -rf /var/lib/mongodb-docker

etapa "GenieACS"
command -v npm >/dev/null && npm ls -g genieacs >/dev/null 2>&1 && npm uninstall -g genieacs >/dev/null 2>&1 && echo "pacote genieacs removido"
rm -rf /opt/genieacs /var/log/genieacs /var/lib/genieacs-limpeza
rm -f /etc/logrotate.d/genieacs /etc/tmpfiles.d/mongodb-thp.conf

etapa "Portal"
rm -rf /opt/globaltech-portal
if [ -e /etc/nginx/sites-available/globaltech-portal ] || [ -e /etc/nginx/sites-enabled/globaltech-portal ]; then
  rm -f /etc/nginx/sites-enabled/globaltech-portal /etc/nginx/sites-available/globaltech-portal*
  if command -v nginx >/dev/null && nginx -t >/dev/null 2>&1; then systemctl reload nginx && echo "site do portal removido do nginx"; fi
fi

etapa "Backup automático"
rm -rf /opt/genieacs-backup /etc/genieacs-backup /var/lib/genieacs-backup

etapa "Firewall da API NBI"
if command -v iptables >/dev/null; then
  while iptables -D INPUT -p tcp -m multiport --dports 7557,7570 -j GENIEACS-NBI 2>/dev/null; do :; done
  iptables -F GENIEACS-NBI 2>/dev/null; iptables -X GENIEACS-NBI 2>/dev/null && echo "regras removidas"
fi
rm -f /usr/local/sbin/genieacs-firewall.sh /usr/local/sbin/genieacs-firewall.sh.bak-*

etapa "Usuários de sistema e respostas do instalador"
id portal   >/dev/null 2>&1 && userdel portal   && echo "usuário portal removido"
id genieacs >/dev/null 2>&1 && userdel genieacs && echo "usuário genieacs removido"
rm -rf /etc/globaltech-instalador

# ----------------------------------------------------------------------------- conferência
etapa "Conferindo"
SOBROU=""
for u in genieacs-cwmp genieacs-nbi globaltech-portal; do systemctl is-active --quiet "$u" 2>/dev/null && SOBROU+=" $u"; done
docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx mongodb && SOBROU+=" mongodb"
for p in /opt/genieacs /opt/globaltech-portal /var/lib/mongodb-docker; do [ -e "$p" ] && SOBROU+=" $p"; done

echo
if [ -z "$SOBROU" ]; then
  echo "Desinstalação concluída: nada do Globaltech ACS ficou no servidor."
else
  echo "ATENÇÃO: ainda sobrou:$SOBROU"
fi
[ $SALVAR = 1 ] && echo "Cópia de segurança: $COPIA_DIR  (restaurar banco: docker exec -i mongodb mongorestore --gzip --archive --drop < $COPIA_DIR/genieacs.archive.gz)"
echo "Para instalar de novo: bash instalador/instalar.sh   (log desta remoção: $LOG)"
