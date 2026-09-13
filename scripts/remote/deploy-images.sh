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

# Release the old browser processes before loading images. Data services stay running.
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
docker compose logs --tail=60 api nginx
exit 1
