#!/usr/bin/env bash
# Instala ou atualiza o Portal Globaltech ACS (Debian 12 / Ubuntu 22.04+).
# Uso, como root, dentro da pasta "portal" do repositório:
#   bash deploy/install.sh                 # porta 8080 no nginx (padrão)
#   PORTAL_PORT=80 bash deploy/install.sh  # outra porta
# Não altera outros sites do nginx. Rodar de novo atualiza o código e mantém .env e data/.
set -euo pipefail

APP=/opt/globaltech-portal
SRC="$(cd "$(dirname "$0")/.." && pwd)"
PORTAL_PORT="${PORTAL_PORT:-8080}"
CHART_VERSION=4.4.1
CHART_SHA512="sha512-C74QN1bxwV1v2PEujhmKjOZ7iUM4w6BWs23Md/6aOZZSlwMzeCIDGuZay++rBgChYru7/+QFeoQW0fQoP534Dg=="

[ "$(id -u)" = 0 ] || { echo "Rode como root."; exit 1; }

echo "==> Pacotes (só nodejs e nginx; o portal não usa npm)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends nodejs nginx ca-certificates
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' \
  || { echo "Precisa de Node.js 18 ou mais novo."; exit 1; }

echo "==> Usuário de sistema"
id portal >/dev/null 2>&1 || useradd --system --home-dir "$APP" --no-create-home --shell /usr/sbin/nologin portal

echo "==> Código em $APP"
mkdir -p "$APP/vendor" "$APP/data"
cp -r "$SRC"/server.js "$SRC"/package.json "$SRC"/lib "$SRC"/public "$SRC"/scripts "$APP"/
find "$APP" -type f \( -name '*.js' -o -name '*.json' -o -name '*.html' -o -name '*.css' \) -not -path "$APP/data/*" -exec sed -i 's/\r$//' {} +

echo "==> Chart.js $CHART_VERSION (registro oficial do npm, com conferência de integridade)"
if [ ! -f "$APP/vendor/chart.umd.js" ]; then
  TMP=$(mktemp -d)
  ( cd "$TMP" && node -e '
    const fs = require("fs"), crypto = require("crypto");
    (async () => {
      const r = await fetch(`https://registry.npmjs.org/chart.js/-/chart.js-${process.argv[1]}.tgz`);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      const sum = "sha512-" + crypto.createHash("sha512").update(buf).digest("base64");
      if (sum !== process.argv[2]) throw new Error("Integridade do Chart.js não confere");
      fs.writeFileSync("chart.tgz", buf);
    })().catch((e) => { console.error(e.message); process.exit(1); });' "$CHART_VERSION" "$CHART_SHA512"
    tar xzf chart.tgz package/dist/chart.umd.js )
  cp "$TMP/package/dist/chart.umd.js" "$APP/vendor/chart.umd.js"
  rm -rf "$TMP"
fi

if [ ! -f "$APP/.env" ]; then
  echo "==> Criando $APP/.env a partir do exemplo (revise os endereços!)"
  sed 's/\r$//' "$SRC/.env.example" > "$APP/.env"
fi

chown -R root:root "$APP"
chown -R portal:portal "$APP/data"; chmod 700 "$APP/data"
chgrp portal "$APP/.env"; chmod 640 "$APP/.env"

echo "==> Serviço systemd"
sed 's/\r$//' "$SRC/deploy/globaltech-portal.service" > /etc/systemd/system/globaltech-portal.service
systemctl daemon-reload
systemctl enable globaltech-portal >/dev/null
systemctl restart globaltech-portal

echo "==> nginx (site próprio na porta $PORTAL_PORT)"
SITE=/etc/nginx/sites-available/globaltech-portal
[ -f "$SITE" ] && cp "$SITE" "$SITE.bak-$(date +%Y%m%d-%H%M%S)"
sed "s/\r$//; s/listen 8080;/listen $PORTAL_PORT;/; s/listen \[::\]:8080;/listen [::]:$PORTAL_PORT;/" \
  "$SRC/deploy/nginx-portal-8080.conf" > "$SITE"
ln -sf "$SITE" /etc/nginx/sites-enabled/globaltech-portal
if nginx -t; then
  systemctl reload nginx
else
  rm -f /etc/nginx/sites-enabled/globaltech-portal
  echo "nginx -t falhou: site desativado, nada recarregado."; exit 1
fi

sleep 2
systemctl is-active --quiet globaltech-portal && echo "==> Portal rodando: http://$(hostname -I | awk '{print $1}'):$PORTAL_PORT"
echo
echo "Próximos passos:"
echo "  1. Revise $APP/.env (NBI_URL, URLs do teste de velocidade) e rode: systemctl restart globaltech-portal"
echo "  2. Crie o primeiro usuário:  cd $APP && runuser -u portal -- node scripts/add-user.js admin \"Administrador\""
echo "  3. Libere a porta $PORTAL_PORT no firewall, se houver (ufw/firewalld)."
