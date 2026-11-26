#!/usr/bin/env bash
# Instala (ou atualiza) o atualizador neste servidor. Rodar como root, de dentro do repositório:
#   bash atualizador/instalar-atualizador.sh                       detecta o que há aqui (portal e/ou ACS) e instala
#   CANAL=teste bash atualizador/instalar-atualizador.sh           servidor de teste: oferece também o branch main
#   VERSAO_ATUAL=v2026.11.25 bash atualizador/instalar-atualizador.sh   informa a versão que já está instalada
#   bash atualizador/instalar-atualizador.sh --so-arquivos         só troca scripts e serviços (usado depois de cada atualização)
# Não mexe no portal, no ACS nem nas configurações deles; só cria /opt/globaltech-atualizador,
# /var/lib/globaltech-atualizador, /etc/globaltech-acs/atualizador.conf e os serviços globaltech-atualizador*.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
BASE=/opt/globaltech-atualizador
VAR=/var/lib/globaltech-atualizador
ETC=/etc/globaltech-acs
CONF=$ETC/atualizador.conf
[ "$(id -u)" = 0 ] || { echo "Rode como root."; exit 1; }
command -v git >/dev/null || { echo "Instalando git"; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git >/dev/null; }

# Troca de arquivo por rename: o atualizador.sh pode estar rodando agora (o bash lê o script aos poucos)
trocar() { local tmp; tmp=$(mktemp "$2.XXXXXX"); sed 's/\r$//' "$1" > "$tmp"; chmod "$3" "$tmp"; mv -f "$tmp" "$2"; }

mkdir -p "$BASE/versoes" "$ETC"
chmod 755 "$BASE"; chmod 700 "$BASE/versoes" "$ETC"
trocar "$SRC/atualizador/atualizador.sh" "$BASE/atualizador.sh" 755
trocar "$SRC/atualizador/estado.js" "$BASE/estado.js" 644
ln -sf "$BASE/atualizador.sh" /usr/local/sbin/globaltech-atualizar
for u in "$SRC"/atualizador/systemd/*; do trocar "$u" "/etc/systemd/system/$(basename "$u")" 644; done
systemctl daemon-reload

# ACS em servidor separado do portal: segue a versão do portal (timer a cada 2 min). Liga também nas atualizações.
ligar_seguir() {
  if [ "${ACS:-0}" = 1 ] && [ "${PORTAL:-0}" = 0 ]; then
    systemctl enable --now globaltech-atualizador-seguir.timer >/dev/null 2>&1 && echo "ACS separado: segue a versão do portal (a cada 2 min)."
  else
    systemctl disable --now globaltech-atualizador-seguir.timer >/dev/null 2>&1 || true
  fi
}

if [ "${1:-}" = "--so-arquivos" ]; then
  # shellcheck disable=SC1090
  [ -f "$CONF" ] && { . "$CONF"; ligar_seguir; }
  echo "Arquivos do atualizador atualizados."
  exit 0
fi

# ---------- Configuração (só na primeira vez; depois edite $CONF) ----------
PORTAL_APP=/opt/globaltech-portal
EXT_DIR=/opt/genieacs/ext
if [ ! -f "$CONF" ]; then
  PORTAL=0; ACS=0
  [ -f "$PORTAL_APP/server.js" ] && PORTAL=1
  [ -d "$EXT_DIR" ] && systemctl list-unit-files genieacs-cwmp.service >/dev/null 2>&1 && ACS=1
  cat > "$CONF" <<EOF
# Atualizador do Globaltech ACS (criado por instalar-atualizador.sh em $(date +%F))
REPO=https://github.com/juninhogv11/globaltech-acs.git
# versoes = só versões marcadas (produção); teste = também o branch main (servidor de teste)
CANAL=${CANAL:-versoes}
# Partes instaladas NESTE servidor (1 = sim)
PORTAL=$PORTAL
PORTAL_APP=$PORTAL_APP
ACS=$ACS
ACS_ENV=$ETC/acs.env
EXT_DIR=$EXT_DIR
# ACS separado do portal: endereço do portal que ele segue (vazio = WIFI_PORTAL_URL do /opt/genieacs/sgp.env)
PORTAL_URL=
EOF
  chmod 600 "$CONF"
  echo "Criado $CONF (portal=$PORTAL, ACS=$ACS, canal=${CANAL:-versoes})."
fi
# shellcheck disable=SC1090
. "$CONF"

# acs.env (variáveis das provisions) fica fora da pasta do código, para valer em todas as versões
if [ "${ACS:-0}" = 1 ] && [ ! -f "$ACS_ENV" ]; then
  for c in "$SRC/acs/acs.env" /root/globaltech-acs/acs/acs.env; do
    if [ -f "$c" ]; then install -m 600 "$c" "$ACS_ENV"; echo "acs.env copiado de $c para $ACS_ENV"; break; fi
  done
  [ -f "$ACS_ENV" ] || echo "AVISO: falta $ACS_ENV (copie o acs.env usado nas provisions para lá antes de atualizar)."
fi

# ---------- Pasta de estado: o portal lê (grupo portal) e deixa pedidos em pedidos/ ----------
GRUPO=root
getent group portal >/dev/null && GRUPO=portal
mkdir -p "$VAR/pedidos" "$VAR/anterior"
chown root:"$GRUPO" "$VAR" "$VAR/pedidos"
chmod 2750 "$VAR"; chmod 2770 "$VAR/pedidos"; chmod 700 "$VAR/anterior"
if [ ! -f "$VAR/estado.json" ]; then
  V="${VERSAO_ATUAL:-}"
  [ -z "$V" ] && V=$(git -C "$SRC" describe --tags --exact-match 2>/dev/null || true)
  [ -z "$V" ] && V=dev
  node -e '
    const fs = require("fs");
    fs.writeFileSync(process.argv[1], JSON.stringify({ instalada: process.argv[2], anterior: null, canal: process.argv[3],
      partes: { portal: process.argv[4] === "1", acs: process.argv[5] === "1" }, disponiveis: [], historico: [], migracoes: [] }, null, 2), { mode: 0o640 });
  ' "$VAR/estado.json" "$V" "${CANAL:-versoes}" "${PORTAL:-0}" "${ACS:-0}"
  echo "Versão registrada como instalada: $V"
  # Portal instalado à mão: grava o arquivo VERSAO para o portal mostrar
  [ "${PORTAL:-0}" = 1 ] && [ ! -f "$PORTAL_APP/VERSAO" ] && echo "$V" > "$PORTAL_APP/VERSAO"
fi
chgrp "$GRUPO" "$VAR"/*.json 2>/dev/null || true

systemctl enable --now globaltech-atualizador-verificar.timer >/dev/null
[ "${PORTAL:-0}" = 1 ] && systemctl enable --now globaltech-atualizador.path >/dev/null
ligar_seguir
echo "Consultando versões no GitHub…"
"$BASE/atualizador.sh" verificar || echo "AVISO: não consegui consultar o GitHub agora (tenta de novo todo dia)."
echo
echo "Atualizador instalado. Comandos: globaltech-atualizar verificar | aplicar <versao> | voltar | estado"
[ "${PORTAL:-0}" = 1 ] && echo "No portal: Configuração → Atualizações."
exit 0
