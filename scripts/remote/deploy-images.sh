#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${DEPLOY_PATH:-/opt/axiom-agent}"
ARCHIVE="${1:?Built image archive required}"
cd "$APP_DIR"
test -f .env
test -s "$ARCHIVE"
IMAGE_VERSION="$(git rev-parse HEAD)"
export AXIOM_API_IMAGE="axiom-agent-api:${IMAGE_VERSION}"
export AXIOM_ADMIN_IMAGE="axiom-agent-nginx:${IMAGE_VERSION}"

if ! docker info >/dev/null 2>&1; then
  systemctl restart docker >/dev/null 2>&1 || systemctl start docker >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    docker info >/dev/null 2>&1 && break
    sleep 2
  done
fi
docker info >/dev/null

# Recover data services first. `--no-deps` below keeps image deployment isolated,
# but a previously stopped MySQL/Mongo would otherwise leave the API in a crash loop.
docker compose up -d --no-build mysql mongo
for _ in $(seq 1 40); do
  MYSQL_STATE="$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q mysql)" 2>/dev/null || true)"
  MONGO_STATE="$(docker inspect --format '{{.State.Running}}' "$(docker compose ps -q mongo)" 2>/dev/null || true)"
  if [[ "$MYSQL_STATE" == "healthy" && "$MONGO_STATE" == "true" ]]; then break; fi
  sleep 3
done
if [[ "$MYSQL_STATE" != "healthy" || "$MONGO_STATE" != "true" ]]; then
  docker compose ps -a
  docker compose logs --tail=80 mysql mongo
  exit 1
fi

# Release the old API process before loading images.
docker compose stop -t 30 api
docker load -i "$ARCHIVE"
docker image inspect "$AXIOM_API_IMAGE" "$AXIOM_ADMIN_IMAGE" >/dev/null
docker compose up -d --no-build --no-deps api nginx

for _ in $(seq 1 40); do
  if curl --max-time 5 -fsS http://127.0.0.1/api/health; then
    rm -f "$ARCHIVE"
    docker compose ps api nginx
    API_CONTAINER="$(docker compose ps -q api)"
    for SAMPLE in $(seq 1 11); do
      date -u +%FT%TZ
      uptime
      free -m
      docker stats --no-stream --format '{{.Name}} CPU={{.CPUPerc}} MEM={{.MemUsage}} PIDS={{.PIDs}}'
      test "$(docker inspect --format '{{.State.Running}} {{.State.OOMKilled}} {{.RestartCount}}' "$API_CONTAINER")" = 'true false 0'
      if docker top "$API_CONTAINER" -eo comm | grep -Eiq 'chromium|chrome|electron'; then
        echo 'Unexpected browser process in production API' >&2
        exit 1
      fi
      curl --max-time 5 -fsS http://127.0.0.1/api/health
      if [ "$SAMPLE" -lt 11 ]; then sleep 30; fi
    done
    exit 0
  fi
  sleep 3
done
docker compose ps -a
docker compose logs --tail=80 api nginx mysql mongo
exit 1
