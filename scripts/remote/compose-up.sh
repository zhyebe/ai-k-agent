#!/usr/bin/env bash
# Runs on the API host. Starts MySQL, Mongo, API, and admin via Docker Compose.
set -euo pipefail

APP_DIR="${DEPLOY_PATH:-/opt/axiom-agent}"
PUBLIC_URL="${DEPLOY_PUBLIC_URL:-http://127.0.0.1}"
INTERNAL_HOST="${DEPLOY_INTERNAL_HOST:-172.19.62.79}"
PUBLIC_PORT="${DEPLOY_PUBLIC_PORT:-80}"
CLIENT_PORT="${DEPLOY_CLIENT_PORT:-8787}"

cd "$APP_DIR"

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo "Installing Docker and compose plugin"
  if command -v yum >/dev/null 2>&1; then
    yum install -y docker docker-client docker-compose-plugin
  elif command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y docker.io docker-compose-v2 || apt-get install -y docker.io docker-compose-plugin
  else
    echo "No supported package manager to install Docker" >&2
    exit 1
  fi
fi

mkdir -p /etc/docker
if [[ ! -f /etc/docker/daemon.json ]]; then
  cat > /etc/docker/daemon.json <<'JSON'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io"
  ]
}
JSON
fi
systemctl enable --now docker
docker compose version >/dev/null
command -v curl >/dev/null 2>&1 || yum install -y curl || apt-get install -y curl || true
if systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http || true
  firewall-cmd --permanent --add-port="${PUBLIC_PORT}/tcp" || true
  if [[ "$CLIENT_PORT" != "$PUBLIC_PORT" ]]; then
    firewall-cmd --permanent --add-port="${CLIENT_PORT}/tcp" || true
  fi
  firewall-cmd --reload || true
fi

# Avoid `grep -q` + pipefail: SIGPIPE from `ip` looks like "address missing".
if [[ "$(ip -4 -o addr show 2>/dev/null || true)" != *"${INTERNAL_HOST}/"* ]]; then
  echo "INTERNAL_HOST ${INTERNAL_HOST} is not assigned on this host:" >&2
  ip -4 addr show >&2 || true
  exit 1
fi

ORIGIN="${PUBLIC_URL%/}"
PUBLIC_HOST="${ORIGIN#*://}"
PUBLIC_HOST="${PUBLIC_HOST%%[:/]*}"
if [[ "$PUBLIC_PORT" != "80" && "$ORIGIN" != *":${PUBLIC_PORT}" ]]; then
  ORIGIN="${ORIGIN}:${PUBLIC_PORT}"
fi
CLIENT_ORIGIN="http://${PUBLIC_HOST}"
if [[ "$CLIENT_PORT" != "80" ]]; then
  CLIENT_ORIGIN="http://${PUBLIC_HOST}:${CLIENT_PORT}"
fi
CORS_ORIGINS="${ORIGIN}"
if [[ "$CLIENT_ORIGIN" != "$ORIGIN" ]]; then
  CORS_ORIGINS="${ORIGIN},${CLIENT_ORIGIN}"
fi
if [[ "$INTERNAL_HOST" != "$PUBLIC_HOST" ]]; then
  CORS_ORIGINS="${CORS_ORIGINS},http://${INTERNAL_HOST},http://${INTERNAL_HOST}:${CLIENT_PORT}"
fi
CORS_HOSTS="${PUBLIC_HOST},${INTERNAL_HOST}"

read_import() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  tr -d '\n\r' < "$file"
}

if [[ ! -f .env ]]; then
  MYSQL_ROOT_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)"
  MYSQL_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)"
  APP_SECRET="$(read_import import/app-secret)"
  [[ -n "$APP_SECRET" ]] || APP_SECRET="$(openssl rand -hex 32)"
  ADMIN_USERNAME="$(read_import import/admin-username)"
  [[ -n "$ADMIN_USERNAME" ]] || ADMIN_USERNAME=admin
  ADMIN_PASSWORD="$(read_import import/admin-password)"
  [[ -n "$ADMIN_PASSWORD" ]] || ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | head -c 16)"
  DESKTOP_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | head -c 16)"
  cat > .env <<ENV
HOST=0.0.0.0
PORT=8787
PUBLIC_PORT=${PUBLIC_PORT}
CLIENT_PORT=${CLIENT_PORT}
APP_SECRET=${APP_SECRET}
AXIOM_DATA_DIR=/var/lib/axiom-agent
AXIOM_SECRET_FILE=/var/lib/axiom-agent/.axiom-secret
AXIOM_VAULT_FILE=/var/lib/axiom-agent/credentials.vault.json
DB_MODE=mysql
MYSQL_ROOT_PASSWORD=${MYSQL_ROOT_PASSWORD}
MYSQL_PASSWORD=${MYSQL_PASSWORD}
MYSQL_URL=mysql://axiom:${MYSQL_PASSWORD}@mysql:3306/axiom_agent
MONGO_URL=mongodb://mongo:27017
MONGO_DB=axiom_agent
ALLOW_MEMORY_FALLBACK=0
INTERNAL_HOST=${INTERNAL_HOST}
BROWSER_ALLOWED_DOMAINS=localhost,127.0.0.1,smyw.haohandahan.cn
AXIOM_BROWSER_NO_SANDBOX=1
AXIOM_TRADING_ENABLED=1
AXIOM_REQUIRE_DESKTOP_AI=1
ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
ADMIN_SESSION_TTL_SEC=28800
DESKTOP_USERNAME=operator
DESKTOP_PASSWORD=${DESKTOP_PASSWORD}
DESKTOP_DISPLAY_NAME=观察员
USER_SESSION_TTL_SEC=2592000
HAOHAN_ANALYSIS_TIMEFRAMES=1m,1h,1d,1mo
HAOHAN_KLINE_COUNT=2000
CORS_ALLOWED_ORIGINS=${CORS_ORIGINS}
CORS_ALLOWED_HOSTS=${CORS_HOSTS}
ENV
  chmod 600 .env
  cat > .first-login <<INFO
Axiom Docker 已初始化，请立刻改密并删除本文件。
后台: ${ORIGIN}/admin.html
备用入口: ${CLIENT_ORIGIN}/admin.html
管理账号: ${ADMIN_USERNAME}
管理密码: ${ADMIN_PASSWORD}
桌面端服务地址（不要加 /api）: ${ORIGIN}
桌面端也可填: ${CLIENT_ORIGIN}
已导入本地库时，桌面账号以数据库为准，不会重建。
MySQL（仅内网）: ${INTERNAL_HOST}:3306 用户 axiom
MongoDB（仅内网）: ${INTERNAL_HOST}:27017
INFO
  chmod 600 .first-login
fi

if ! grep -q '^INTERNAL_HOST=' .env; then
  echo "INTERNAL_HOST=${INTERNAL_HOST}" >> .env
fi
if ! grep -q '^CORS_ALLOWED_HOSTS=' .env; then
  echo "CORS_ALLOWED_HOSTS=${CORS_HOSTS}" >> .env
fi
if ! grep -q '^PUBLIC_PORT=' .env; then
  echo "PUBLIC_PORT=${PUBLIC_PORT}" >> .env
fi
if ! grep -q '^CLIENT_PORT=' .env; then
  echo "CLIENT_PORT=${CLIENT_PORT}" >> .env
fi
if ! grep -q '^USER_SESSION_TTL_SEC=' .env; then
  echo "USER_SESSION_TTL_SEC=2592000" >> .env
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

echo "Building images sequentially to avoid host OOM"
docker compose build api
docker compose build nginx
echo "Starting MySQL/Mongo first"
docker compose up -d mysql mongo

echo "Waiting for MySQL..."
mysql_ok=0
for _ in $(seq 1 60); do
  if docker compose exec -T mysql mysqladmin ping -h127.0.0.1 -uroot -p"${MYSQL_ROOT_PASSWORD}" --silent >/dev/null 2>&1; then
    mysql_ok=1
    break
  fi
  sleep 3
done
if [[ "$mysql_ok" != "1" ]]; then
  docker compose logs --tail=80 mysql
  echo "MySQL did not become ready" >&2
  exit 1
fi

if [[ -f import/mysql.sql && ! -f import/.imported ]]; then
  echo "Importing MySQL dump"
  docker compose exec -T mysql mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" axiom_agent < import/mysql.sql
  if [[ -f import/credentials.vault.json ]]; then
    docker compose run --rm --no-deps -v "$APP_DIR/import:/import:ro" api \
      sh -c 'mkdir -p /var/lib/axiom-agent && cp /import/credentials.vault.json /var/lib/axiom-agent/credentials.vault.json && chmod 600 /var/lib/axiom-agent/credentials.vault.json'
  fi
  date -u +"%Y-%m-%dT%H:%M:%SZ" > import/.imported
  chmod 600 import/.imported
fi

echo "Starting API and admin"
docker compose up -d api nginx

echo "Waiting for API health..."
ok=0
for _ in $(seq 1 80); do
  if curl -fsS "http://127.0.0.1:${PUBLIC_PORT}/api/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  if curl -fsS http://127.0.0.1/api/health >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 3
done
if [[ "$ok" != "1" ]]; then
  docker compose ps
  docker compose logs --tail=80
  echo "API health check failed" >&2
  exit 1
fi
curl -fsS "http://127.0.0.1:${PUBLIC_PORT}/api/health" || curl -fsS http://127.0.0.1/api/health
echo
echo "Admin: ${ORIGIN}/admin.html"
echo "Desktop URL: ${ORIGIN}  or  ${CLIENT_ORIGIN}"
if [[ -f .first-login ]]; then
  echo "First-login file: ${APP_DIR}/.first-login"
fi
