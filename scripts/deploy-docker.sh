#!/usr/bin/env bash
# Deploy API + admin with Docker Compose. Desktop clients are not installed on the server.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source scripts/lib/remote.sh
load_deploy_env
parse_deploy_args "$@" || {
  cat <<'USAGE'
Usage: scripts/deploy-docker.sh --host <public-ip> --password <ssh-password>

Deploys MySQL, MongoDB, API, and the admin page with Docker.
MySQL/Mongo bind the internal IP only. Clients use the public URL.

Example:
  scripts/deploy-docker.sh --host 47.109.95.143 --internal-host 172.19.62.79 --password 'xxx'
USAGE
  exit 2
}
require_deploy_target
open_ssh_master

log "Exporting local MySQL and vault"
bash "$ROOT/scripts/export-local-data.sh"

log "Syncing to ${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH}"
remote_ssh "mkdir -p '$DEPLOY_PATH'"
if remote_ssh "command -v rsync >/dev/null"; then
  remote_rsync "$ROOT/" "$DEPLOY_PATH/"
else
  log "Remote has no rsync; sending a tarball"
  remote_tar_sync "$DEPLOY_PATH"
fi

log "Uploading database import"
remote_ssh "mkdir -p '$DEPLOY_PATH/import' && chmod 700 '$DEPLOY_PATH/import'"
COPYFILE_DISABLE=1 tar -C "$ROOT/.axiom-data/migrate" -czf - . | remote_ssh "tar -xzf - -C '$DEPLOY_PATH/import' && chmod 700 '$DEPLOY_PATH/import' && chmod 600 '$DEPLOY_PATH/import/'* || true"

log "Starting Docker Compose on the server"
remote_ssh "DEPLOY_PATH='$DEPLOY_PATH' DEPLOY_PUBLIC_URL='$DEPLOY_PUBLIC_URL' DEPLOY_INTERNAL_HOST='$DEPLOY_INTERNAL_HOST' DEPLOY_PUBLIC_PORT='${DEPLOY_PUBLIC_PORT:-80}' DEPLOY_CLIENT_PORT='${DEPLOY_CLIENT_PORT:-8787}' bash '$DEPLOY_PATH/scripts/remote/compose-up.sh'"

if remote_ssh "test -f '$DEPLOY_PATH/.first-login'"; then
  log "First login (change these immediately):"
  remote_ssh "cat '$DEPLOY_PATH/.first-login'"
fi

log "Public admin: ${DEPLOY_PUBLIC_URL}/admin.html"
log "Desktop service URL: ${DEPLOY_PUBLIC_URL}  or  ${DEPLOY_PUBLIC_URL}:8787"
log "MySQL/Mongo listen on ${DEPLOY_INTERNAL_HOST} only"
