#!/usr/bin/env bash
# Atualizador do Globaltech ACS (roda como root). Instalado em /opt/globaltech-atualizador por instalar-atualizador.sh.
#   globaltech-atualizar verificar          consulta as versões marcadas no GitHub (v2026.11.25, v2026.11.25-2 ...)
#   globaltech-atualizar aplicar <versao>   baixa a versão e instala (portal e/ou ACS, o que houver neste servidor)
#   globaltech-atualizar voltar             reinstala a versão anterior
#   globaltech-atualizar estado             mostra o estado
#   globaltech-atualizar pedido             executa o pedido deixado pelo portal (chamado pelo systemd)
#   globaltech-atualizar seguir             ACS separado: instala a versão em que o portal está (timer a cada 2 min)
# A instalação em si fica em atualizador/aplicar.sh DA VERSÃO NOVA: correções no processo valem já na atualização seguinte.
set -euo pipefail

CONF=/etc/globaltech-acs/atualizador.conf
BASE=/opt/globaltech-atualizador
export VAR=/var/lib/globaltech-atualizador
[ "$(id -u)" = 0 ] || { echo "Rode como root."; exit 1; }
[ -f "$CONF" ] || { echo "Falta $CONF (rode atualizador/instalar-atualizador.sh)."; exit 1; }
# shellcheck disable=SC1090
. "$CONF"
export REPO CANAL="${CANAL:-versoes}" PORTAL="${PORTAL:-0}" ACS="${ACS:-0}"
export PORTAL_APP="${PORTAL_APP:-/opt/globaltech-portal}" ACS_ENV="${ACS_ENV:-/etc/globaltech-acs/acs.env}" EXT_DIR="${EXT_DIR:-/opt/genieacs/ext}"
EST() { node "$BASE/estado.js" "$@"; }
VERSAO_RE='^v[0-9]{4}\.[0-9]{2}\.[0-9]{2}(-[0-9]{1,3})?$'

# Uma execução por vez (pedido do portal, verificação diária e linha de comando)
exec 9>/run/globaltech-atualizador.lock
flock -w 30 9 || { echo "Outra execução do atualizador está em andamento."; exit 75; }

verificar() {
  local tags
  if ! tags=$(timeout 60 git ls-remote --tags --refs "$REPO" 'v*' 2>&1); then
    EST erro-verificacao "não consegui consultar o GitHub: $(echo "$tags" | tail -1)"
    echo "Erro ao consultar $REPO"; return 1
  fi
  echo "$tags" | awk '{print $2}' | sed 's#^refs/tags/##' | EST disponiveis
}

aplicar() {
  local v="$1" quem="${2:-linha de comando}" acao="${3:-aplicar}"
  if ! [[ "$v" =~ $VERSAO_RE ]] && ! { [ "$v" = main ] && [ "$CANAL" = teste ]; }; then
    echo "Versão inválida: $v"; return 1
  fi
  local de; de=$(EST get instalada); de=${de:-dev}
  EST inicio "$acao" "$v" "$quem"
  local rel="$BASE/versoes/$v"
  # main muda a cada commit: baixa de novo sempre
  [ "$v" = main ] && rm -rf "$rel"
  if [ ! -f "$rel/atualizador/aplicar.sh" ]; then
    EST passo "Baixando $v do GitHub"
    rm -rf "$rel.tmp"
    if ! timeout 300 git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$v" "$REPO" "$rel.tmp" >>"$VAR/execucao.log" 2>&1; then
      rm -rf "$rel.tmp"; EST fim erro "não consegui baixar $v do GitHub (nada foi alterado)"; return 1
    fi
    chmod 700 "$rel.tmp"; mv "$rel.tmp" "$rel"
  fi
  local commit; commit=$(git -C "$rel" rev-parse --short HEAD 2>/dev/null || echo "?")
  EST passo "Versão $v (commit $commit) pronta para instalar"
  # O processo de instalação é o da versão nova
  if bash "$rel/atualizador/aplicar.sh" "$rel" "$v" "$de" >>"$VAR/execucao.log" 2>&1; then
    EST set anterior "\"$de\""
    EST set instalada "\"$v\""
    EST set commit "\"$commit\""
    # Atualizador e serviços também vêm da versão nova
    bash "$rel/atualizador/instalar-atualizador.sh" --so-arquivos >>"$VAR/execucao.log" 2>&1 || EST passo "Aviso: não atualizei os arquivos do próprio atualizador"
    EST fim ok "instalada $v (antes: $de)"
    # Mantém só as 3 versões mais recentes baixadas (nunca a instalada nem a anterior)
    for d in $(ls -1 "$BASE/versoes" 2>/dev/null | sort -V | head -n -3); do
      [ "$d" = "$v" ] || [ "$d" = "$de" ] || rm -rf "${BASE:?}/versoes/$d"
    done
    verificar >/dev/null 2>&1 || true
  else
    # aplicar.sh já voltou o que tinha mudado e gravou o fim (revertido/erro); se não gravou, marca erro
    local est; est=$(node -e 'try{console.log(require(process.argv[1]).estado)}catch{}' "$VAR/execucao.json")
    [ "$est" = rodando ] && EST fim erro "a instalação falhou (veja o registro)"
    return 1
  fi
}

# ACS em servidor separado do portal: segue a versão do portal (o administrador atualiza o portal pelo botão e o ACS
# instala a mesma versão em até 2 min). Só avança (nunca volta sozinho) e não repete uma versão que já falhou aqui.
# Endereço do portal: PORTAL_URL no atualizador.conf ou, se não houver, WIFI_PORTAL_URL do sgp.env.
url_portal() {
  local u="${PORTAL_URL:-}"
  [ -z "$u" ] && u=$(grep -m1 '^WIFI_PORTAL_URL=' "${SGP_ENV:-/opt/genieacs/sgp.env}" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' \r' || true)
  echo "${u%/}"
}
seguir() {
  [ "$ACS" = 1 ] && [ "$PORTAL" = 0 ] || return 0
  local url; url=$(url_portal)
  [ -n "$url" ] || return 0
  local pv inst
  pv=$(EST versao-portal "$url")
  inst=$(EST get instalada); inst=${inst:-dev}
  if [ -n "$pv" ] && [ "$(EST compara "$pv" "$inst")" = 1 ] && [ "$(EST get seguirFalhou)" != "$pv" ]; then
    # Enquanto instala, manda o andamento ao portal a cada 5 s
    ( exec 9>&-; while sleep 5; do EST relatar "$url" 2>/dev/null; done ) &
    local rel=$!
    if aplicar "$pv" "portal (automático)"; then EST set seguirFalhou null; else EST set seguirFalhou "\"$pv\""; fi
    kill "$rel" 2>/dev/null || true; wait "$rel" 2>/dev/null || true
  fi
  EST relatar "$url"
}

case "${1:-}" in
  verificar) verificar ;;
  seguir) seguir ;;
  aplicar) aplicar "${2:?informe a versão, ex.: v2026.11.25}" "linha de comando" ;;
  voltar)
    ant=$(EST get anterior)
    [ -n "$ant" ] && [ "$ant" != dev ] || { echo "Não há versão anterior registrada."; exit 1; }
    aplicar "$ant" "linha de comando" voltar ;;
  estado) cat "$VAR/estado.json"; echo; [ -f "$VAR/execucao.json" ] && cat "$VAR/execucao.json" ;;
  pedido)
    P="$VAR/pedidos/pedido.json"
    [ -f "$P" ] || exit 0
    # Lê e apaga o pedido antes de executar (um pedido = uma execução). Só aceita os campos esperados.
    read -r acao versao usuario < <(node -e '
      const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const ok = (s, re) => (typeof s === "string" && re.test(s) ? s : "-");
      console.log(ok(p.acao, /^(verificar|aplicar|voltar)$/), ok(p.versao, /^(v\d{4}\.\d{2}\.\d{2}(-\d{1,3})?|main)$/), ok(p.usuario, /^[A-Za-z0-9_.-]{1,32}$/));
    ' "$P" 2>/dev/null || echo "- - -")
    rm -f "$P"
    case "$acao" in
      verificar) verificar ;;
      aplicar) aplicar "$versao" "$usuario (portal)" ;;
      voltar)
        ant=$(EST get anterior)
        [ -n "$ant" ] && [ "$ant" != dev ] || { EST inicio voltar "" "$usuario"; EST fim erro "não há versão anterior registrada"; exit 1; }
        aplicar "$ant" "$usuario (portal)" voltar ;;
      *) echo "Pedido inválido ignorado." ;;
    esac ;;
  *) sed -n '2,8p' "$0"; exit 2 ;;
esac
