#!/usr/bin/env bash
# Instala uma versão já baixada (chamado pelo atualizador.sh, como root): aplicar.sh <pasta-da-versao> <versao> <versao-atual>
# Ordem pensada para não parar o que está funcionando:
#   1. confere tudo ANTES de mexer: sintaxe, o portal novo ligado numa porta de teste (sem rotinas de fundo),
#      simulação da publicação no ACS (acusa variável nova faltando no acs.env);
#   2. migrações da versão (ajustes de configuração, cada uma idempotente e com cópia do que muda);
#   3. cópia do que está instalado (código do portal, extensões e provisions/presets/virtual parameters);
#   4. ACS: extensões (reinicia o genieacs-cwmp só se mudaram) e depois provisions/presets (cada item é trocado de uma vez);
#   5. portal: troca as pastas e reinicia (~1 s; as sessões ficam gravadas, ninguém é desconectado);
#      confere que voltou respondendo com a versão nova.
# Se algo falhar nos passos 4 e 5, volta tudo ao que estava (rollback) e termina com "revertido".
set -euo pipefail

REL="$1"; V="$2"; DE="${3:-dev}"
EST() { node "$REL/atualizador/estado.js" "$@"; }
passo() { EST passo "$*"; }
falha() { EST fim erro "$*"; echo "ERRO: $*"; exit 1; }

TMP=$(mktemp -d /tmp/gt-atualizar.XXXXXX)
BK="$VAR/anterior/$(date +%Y%m%d-%H%M%S)-$DE"
mkdir -p "$BK"; chmod 700 "$VAR/anterior" "$BK"
cleanup() { rm -rf "$TMP"; rm -f "$REL/acs/acs.env"; }
trap cleanup EXIT

# ---------- 1. Conferências (nada muda no servidor) ----------
passo "Conferindo os arquivos da versão nova"
for f in "$REL"/portal/server.js "$REL"/portal/lib/*.js "$REL"/acs/deploy-acs.js "$REL"/atualizador/estado.js; do
  node --check "$f" || falha "erro de sintaxe em ${f#$REL/} (nada foi alterado)"
done
for f in "$REL"/acs/ext/*; do
  cp "$f" "$TMP/ext.js"; node --check "$TMP/ext.js" || falha "erro de sintaxe na extensão ${f#$REL/} (nada foi alterado)"
done
for f in "$REL"/acs/provisions/*.js "$REL"/acs/virtual_parameters/*.js; do
  { echo "(function(){"; cat "$f"; echo; echo "})"; } > "$TMP/prov.js"
  node --check "$TMP/prov.js" || falha "erro de sintaxe em ${f#$REL/} (nada foi alterado)"
done
for f in "$REL"/acs/presets/*.json; do node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$f" || falha "JSON inválido em ${f#$REL/}"; done
for f in "$REL"/atualizador/*.sh "$REL"/atualizador/migracoes/*.sh; do [ -f "$f" ] && { bash -n "$f" || falha "erro de sintaxe em ${f#$REL/}"; }; done

PORTA_PORTAL=3100
if [ "$PORTAL" = 1 ]; then
  [ -d "$PORTAL_APP" ] || falha "portal não encontrado em $PORTAL_APP"
  PORTA_PORTAL=$(grep -m1 '^PORT=' "$PORTAL_APP/.env" 2>/dev/null | cut -d= -f2 | tr -d '"'"'"' \r'); PORTA_PORTAL=${PORTA_PORTAL:-3100}
  passo "Ligando o portal novo numa porta de teste (sem rotinas de fundo)"
  chmod 755 "$TMP"
  STAGE="$TMP/portal"; mkdir -p "$STAGE" "$TMP/dados"
  cp -r "$REL"/portal/server.js "$REL"/portal/package.json "$REL"/portal/lib "$REL"/portal/public "$REL"/portal/scripts "$STAGE"/
  find "$STAGE" -type f \( -name '*.js' -o -name '*.json' -o -name '*.html' -o -name '*.css' \) -exec sed -i 's/\r$//' {} +
  echo "$V" > "$STAGE/VERSAO"
  [ -d "$PORTAL_APP/vendor" ] && ln -s "$PORTAL_APP/vendor" "$STAGE/vendor"
  chown -R portal:portal "$TMP/dados"
  runuser -u portal -- env PORT=3199 HOST=127.0.0.1 PORTAL_VERIFICAR=1 USERS_FILE="$TMP/dados/users.json" \
    ATUALIZADOR_DIR="$TMP/dados" node "$STAGE/server.js" >"$TMP/teste-portal.log" 2>&1 &
  PID=$!
  ok=0
  for _ in $(seq 1 30); do
    sleep 0.5
    if curl -fsS --max-time 2 http://127.0.0.1:3199/api/saude 2>/dev/null | grep -q "\"versao\":\"$V\"" \
      && curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:3199/ && curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:3199/app.js; then ok=1; break; fi
  done
  kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true
  [ $ok = 1 ] || { cat "$TMP/teste-portal.log"; falha "o portal novo não ligou no teste (nada foi alterado)"; }
  passo "Portal novo ligou e respondeu no teste"
fi

if [ "$ACS" = 1 ]; then
  [ -f "$ACS_ENV" ] || falha "falta $ACS_ENV (variáveis das provisions)"
  install -m 600 "$ACS_ENV" "$REL/acs/acs.env"
  passo "Simulando a publicação no ACS"
  node "$REL/acs/deploy-acs.js" --dry-run || falha "a simulação no ACS falhou — veja acima (ex.: variável nova faltando em $ACS_ENV). Nada foi alterado."
fi

# ---------- 2. Migrações da versão ----------
FEITAS=$(EST get migracoes); FEITAS=${FEITAS:-[]}
for m in "$REL"/atualizador/migracoes/*.sh; do
  [ -f "$m" ] || continue
  nome=$(basename "$m")
  echo "$FEITAS" | grep -q "\"$nome\"" && continue
  passo "Ajuste de configuração: $nome"
  BK_MIGRACAO="$BK/migracoes" bash "$m" || falha "o ajuste $nome falhou (código ainda não foi trocado; veja o registro)"
  FEITAS=$(node -e 'const a=JSON.parse(process.argv[1]);a.push(process.argv[2]);console.log(JSON.stringify(a))' "$FEITAS" "$nome")
  EST set migracoes "$FEITAS"
done

# ---------- 3. Cópia do que está instalado ----------
passo "Guardando cópia da versão atual ($DE)"
if [ "$PORTAL" = 1 ]; then
  mkdir -p "$BK/portal"
  for x in server.js package.json lib public scripts VERSAO; do [ -e "$PORTAL_APP/$x" ] && cp -a "$PORTAL_APP/$x" "$BK/portal/"; done
fi
[ "$ACS" = 1 ] && cp -a "$EXT_DIR" "$BK/ext"

MUDOU_EXT=0; PUBLICOU_ACS=0; TROCOU_PORTAL=0
voltar() {
  EST passo "FALHOU: $* — voltando ao que estava"
  if [ $TROCOU_PORTAL = 1 ]; then
    for x in server.js package.json lib public scripts VERSAO; do
      rm -rf "${PORTAL_APP:?}/$x"; [ -e "$BK/portal/$x" ] && cp -a "$BK/portal/$x" "$PORTAL_APP/"
    done
    systemctl restart globaltech-portal || true
  fi
  if [ $PUBLICOU_ACS = 1 ]; then
    for d in "$BK"/acs/*/; do node "$REL/acs/deploy-acs.js" --restaurar "$d" || true; done
  fi
  if [ $MUDOU_EXT = 1 ]; then
    cp -a "$BK/ext/." "$EXT_DIR/"; systemctl restart genieacs-cwmp || true
  fi
  EST fim revertido "$* — o sistema voltou para $DE"
  exit 1
}

# ---------- 4. ACS ----------
if [ "$ACS" = 1 ]; then
  DONO=$(stat -c %U:%G "$EXT_DIR")
  for f in "$REL"/acs/ext/*; do
    dst="$EXT_DIR/$(basename "$f")"
    sed 's/\r$//' "$f" > "$TMP/ext.novo"
    if ! cmp -s "$TMP/ext.novo" "$dst" 2>/dev/null; then
      install -m 644 -o "${DONO%:*}" -g "${DONO#*:}" "$TMP/ext.novo" "$dst"; MUDOU_EXT=1
      passo "Extensão atualizada: $(basename "$f")"
    fi
  done
  if [ $MUDOU_EXT = 1 ]; then
    systemctl restart genieacs-cwmp; sleep 2
    systemctl is-active --quiet genieacs-cwmp || voltar "o genieacs-cwmp não voltou depois de trocar as extensões"
  fi
  passo "Publicando provisions, presets e virtual parameters"
  PUBLICOU_ACS=1
  node "$REL/acs/deploy-acs.js" --backup-dir "$BK/acs" || voltar "a publicação no ACS falhou"
fi

# ---------- 5. Portal ----------
if [ "$PORTAL" = 1 ]; then
  passo "Trocando o portal (reinicia em ~1 s; ninguém é desconectado)"
  TROCOU_PORTAL=1
  for x in server.js package.json lib public scripts VERSAO; do
    rm -rf "${PORTAL_APP:?}/$x.novo"; cp -a "$STAGE/$x" "$PORTAL_APP/$x.novo"
  done
  for x in server.js package.json lib public scripts VERSAO; do
    rm -rf "${PORTAL_APP:?}/$x"; mv "$PORTAL_APP/$x.novo" "$PORTAL_APP/$x"
  done
  chown -R root:root "$PORTAL_APP/server.js" "$PORTAL_APP/package.json" "$PORTAL_APP/lib" "$PORTAL_APP/public" "$PORTAL_APP/scripts" "$PORTAL_APP/VERSAO"
  UNIT=/etc/systemd/system/globaltech-portal.service
  sed 's/\r$//' "$REL/portal/deploy/globaltech-portal.service" > "$TMP/unit"
  if ! cmp -s "$TMP/unit" "$UNIT"; then cp "$UNIT" "$BK/" 2>/dev/null || true; install -m 644 "$TMP/unit" "$UNIT"; systemctl daemon-reload; passo "Serviço do portal atualizado"; fi
  R0=$(systemctl show -p NRestarts --value globaltech-portal 2>/dev/null || echo 0)
  systemctl restart globaltech-portal
  ok=0
  for _ in $(seq 1 40); do
    sleep 0.5
    curl -fsS --max-time 2 "http://127.0.0.1:$PORTA_PORTAL/api/saude" 2>/dev/null | grep -q "\"versao\":\"$V\"" && { ok=1; break; }
    # Caindo e sendo religado pelo systemd: não espera os 20 s para voltar
    [ "$(systemctl show -p NRestarts --value globaltech-portal 2>/dev/null || echo 0)" -gt "$R0" ] && { journalctl -u globaltech-portal -n 15 --no-pager; break; }
  done
  [ $ok = 1 ] || voltar "o portal não voltou respondendo depois da troca"
  passo "Portal respondendo na versão $V"
fi

# Guarda só as 5 cópias mais recentes
ls -1d "$VAR"/anterior/*/ 2>/dev/null | sort | head -n -5 | xargs -r rm -rf
echo "OK: $V instalada"
