#!/usr/bin/env bash
# 001 — Instalação "tudo junto": o ACS passa a falar com o portal direto na própria máquina (127.0.0.1:<porta do Node>).
# Pelo IP público, atrás de NAT, o pedido volta pelo roteador com o IP dele e o portal recusa (403): a cópia do Wi-Fi
# não chegava na restauração após reset nem no backup diário (visto na Superi em 25/11/2026).
# Migrações: rodam uma vez por servidor (registradas em estado.json), antes de trocar o código; guardam cópia em $BK_MIGRACAO.
set -euo pipefail
[ "${PORTAL:-0}" = 1 ] && [ "${ACS:-0}" = 1 ] || { echo "001: não é instalação tudo junto, nada a fazer"; exit 0; }
PORTA=$(grep -m1 '^PORT=' "$PORTAL_APP/.env" 2>/dev/null | cut -d= -f2 | tr -d ' "\r'); PORTA=${PORTA:-3100}
URL="http://127.0.0.1:$PORTA"
for item in /opt/genieacs/sgp.env:WIFI_PORTAL_URL /etc/genieacs-backup/backup.env:PORTAL_URL; do
  arq=${item%%:*}; k=${item#*:}
  [ -f "$arq" ] || continue
  grep -q "^$k=$URL\$" "$arq" && continue
  mkdir -p "$BK_MIGRACAO"; cp -p "$arq" "$BK_MIGRACAO/$(basename "$arq")"
  if grep -q "^$k=" "$arq"; then sed -i "s|^$k=.*|$k=$URL|" "$arq"; else echo "$k=$URL" >> "$arq"; fi
  echo "001: $arq -> $k=$URL"
done
