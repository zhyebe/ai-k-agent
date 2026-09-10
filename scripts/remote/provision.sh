#!/usr/bin/env bash
# Runs on the Ubuntu/Debian API host. Installs API + admin page only.
set -euo pipefail

APP_DIR="${DEPLOY_PATH:-/opt/axiom-agent}"
PUBLIC_URL="${DEPLOY_PUBLIC_URL:-http://127.0.0.1}"
INSTALL_MYSQL="${DEPLOY_INSTALL_MYSQL:-1}"
INSTALL_CHROME="${DEPLOY_INSTALL_CHROME:-1}"
SERVICE_NAME="${DEPLOY_SERVICE:-axiom-api}"

if [[ ! -f /etc/os-release ]] || ! grep -Eqi 'ubuntu|debian' /etc/os-release; then
  echo "This provision script supports Ubuntu/Debian only." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg nginx rsync

if ! command -v node >/dev/null 2>&1 || ! node -v | grep -qE '^v2[0-9]'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if [[ "$INSTALL_MYSQL" == "1" ]] && ! command -v mysql >/dev/null 2>&1; then
  apt-get install -y mysql-server
  systemctl enable --now mysql
fi

if [[ "$INSTALL_CHROME" == "1" ]]; then
  if ! command -v google-chrome >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1; then
    apt-get install -y chromium-browser || apt-get install -y chromium || true
  fi
fi

id -u axiom >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin axiom
mkdir -p "$APP_DIR" /var/lib/axiom-agent
chown -R axiom:axiom "$APP_DIR" /var/lib/axiom-agent

if [[ "$INSTALL_MYSQL" == "1" ]]; then
  if [[ ! -f "$APP_DIR/.env" ]]; then
    MYSQL_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)"
  else
    MYSQL_PASSWORD="$(grep -E '^MYSQL_URL=' "$APP_DIR/.env" | sed -n 's#.*://axiom:\([^@]*\)@.*#\1#p')"
  fi
  mysql --protocol=socket -uroot <<SQL
CREATE DATABASE IF NOT EXISTS axiom_agent CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'axiom'@'localhost' IDENTIFIED BY '${MYSQL_PASSWORD}';
ALTER USER 'axiom'@'localhost' IDENTIFIED BY '${MYSQL_PASSWORD}';
GRANT ALL PRIVILEGES ON axiom_agent.* TO 'axiom'@'localhost';
FLUSH PRIVILEGES;
SQL
  mysql --protocol=socket -uroot axiom_agent < "$APP_DIR/db/mysql/schema.sql"
fi

if [[ ! -f "$APP_DIR/.env" ]]; then
  APP_SECRET="$(openssl rand -hex 32)"
  ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | head -c 16)"
  DESKTOP_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | head -c 16)"
  ORIGIN="${PUBLIC_URL%/}"
  cat > "$APP_DIR/.env" <<ENV
HOST=127.0.0.1
PORT=8787
APP_SECRET=${APP_SECRET}
AXIOM_DATA_DIR=/var/lib/axiom-agent
AXIOM_SECRET_FILE=/var/lib/axiom-agent/.axiom-secret
AXIOM_VAULT_FILE=/var/lib/axiom-agent/credentials.vault.json
DB_MODE=mysql
MYSQL_URL=mysql://axiom:${MYSQL_PASSWORD}@127.0.0.1:3306/axiom_agent
ALLOW_MEMORY_FALLBACK=0
BROWSER_ALLOWED_DOMAINS=localhost,127.0.0.1,smyw.haohandahan.cn
ADMIN_USERNAME=admin
ADMIN_PASSWORD=${ADMIN_PASSWORD}
ADMIN_SESSION_TTL_SEC=28800
DESKTOP_USERNAME=operator
DESKTOP_PASSWORD=${DESKTOP_PASSWORD}
DESKTOP_DISPLAY_NAME=观察员
HAOHAN_ANALYSIS_TIMEFRAMES=1m,1h,1d,1mo
HAOHAN_KLINE_COUNT=2000
CORS_ALLOWED_ORIGINS=${ORIGIN}
ENV
  chmod 600 "$APP_DIR/.env"
  cat > /root/axiom-first-login.txt <<INFO
Axiom 后台已初始化，请立刻改密并删除本文件。
后台地址: ${ORIGIN}/admin.html
管理账号: admin
管理密码: ${ADMIN_PASSWORD}
首个桌面账号: operator
桌面密码: ${DESKTOP_PASSWORD}
桌面端请从 GitHub Releases 自行下载，登录页填写服务地址: ${ORIGIN}
INFO
  chmod 600 /root/axiom-first-login.txt
fi

chown axiom:axiom "$APP_DIR/.env"
cd "$APP_DIR"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

install -m 644 "$APP_DIR/scripts/remote/axiom-api.service" /etc/systemd/system/${SERVICE_NAME}.service
sed -i "s#WorkingDirectory=/opt/axiom-agent#WorkingDirectory=${APP_DIR}#" /etc/systemd/system/${SERVICE_NAME}.service
sed -i "s#EnvironmentFile=/opt/axiom-agent/.env#EnvironmentFile=${APP_DIR}/.env#" /etc/systemd/system/${SERVICE_NAME}.service

install -m 644 "$APP_DIR/scripts/remote/nginx-axiom.conf" /etc/nginx/sites-available/axiom
sed -i "s#root /opt/axiom-agent/dist#root ${APP_DIR}/dist#" /etc/nginx/sites-available/axiom
ln -sfn /etc/nginx/sites-available/axiom /etc/nginx/sites-enabled/axiom
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
systemctl reload nginx

echo "Provision finished. Admin: ${PUBLIC_URL}/admin.html"
if [[ -f /root/axiom-first-login.txt ]]; then
  echo "First-login file: /root/axiom-first-login.txt"
fi
