#!/usr/bin/env bash
# Pull a git ref on the API host and rebuild Docker services. Keeps .env and database volumes.
set -euo pipefail

APP_DIR="${DEPLOY_PATH:-/opt/axiom-agent}"
REF="${1:-main}"
PUBLIC_URL="${DEPLOY_PUBLIC_URL:-http://47.109.95.143}"
INTERNAL_HOST="${DEPLOY_INTERNAL_HOST:-172.19.62.79}"
PUBLIC_PORT="${DEPLOY_PUBLIC_PORT:-80}"
CLIENT_PORT="${DEPLOY_CLIENT_PORT:-8787}"

if [[ ! "$REF" =~ ^[A-Za-z0-9._/-]+$ ]]; then
  echo "invalid git ref: $REF" >&2
  exit 2
fi

cd "$APP_DIR"
if [[ ! -d .git ]]; then
  echo "$APP_DIR is not a git checkout. Run scripts/setup-git-deploy.sh first." >&2
  exit 1
fi

export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -i /root/.ssh/axiom-github -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new}"
git fetch --tags --prune origin
if git rev-parse --verify "refs/remotes/origin/${REF}" >/dev/null 2>&1; then
  git checkout -f -B "$REF" "origin/${REF}"
elif git rev-parse --verify "refs/tags/${REF}" >/dev/null 2>&1; then
  git checkout -f --detach "$REF"
elif git rev-parse --verify "$REF" >/dev/null 2>&1; then
  git checkout -f --detach "$REF"
else
  echo "ref not found after fetch: $REF" >&2
  exit 1
fi

git rev-parse --short HEAD
git log -1 --oneline

DEPLOY_PATH="$APP_DIR" \
  DEPLOY_PUBLIC_URL="$PUBLIC_URL" \
  DEPLOY_INTERNAL_HOST="$INTERNAL_HOST" \
  DEPLOY_PUBLIC_PORT="$PUBLIC_PORT" \
  DEPLOY_CLIENT_PORT="$CLIENT_PORT" \
  bash "$APP_DIR/scripts/remote/compose-up.sh"
