#!/usr/bin/env bash
# Update an existing server: API + admin page only.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source scripts/lib/remote.sh
load_deploy_env
parse_deploy_args "$@" || {
  cat <<'USAGE'
Usage: scripts/deploy.sh --host <ip> --password <ssh-password>

Updates API code and the admin page. Does not publish the desktop client.

Example:
  scripts/deploy.sh --host 1.2.3.4 --user root --password 'xxx'
USAGE
  exit 2
}
require_deploy_target

if [[ "${DEPLOY_SKIP_BUILD:-0}" != "1" ]]; then
  log "Building admin page"
  npm ci
  npm run build
fi

log "Syncing to ${DEPLOY_HOST}:${DEPLOY_PATH}"
remote_ssh "mkdir -p '$DEPLOY_PATH'"
remote_rsync "$ROOT/" "$DEPLOY_PATH/"
remote_ssh "chown -R axiom:axiom '$DEPLOY_PATH' || true"
remote_ssh "cd '$DEPLOY_PATH' && npm ci --omit=dev"
remote_ssh "systemctl restart '$DEPLOY_SERVICE'"
remote_ssh "curl -fsS http://127.0.0.1:8787/api/health"

log "Updated. Admin: ${DEPLOY_PUBLIC_URL}/admin.html"
log "Desktop users keep their downloaded app and the same service URL."
