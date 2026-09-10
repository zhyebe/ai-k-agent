#!/usr/bin/env bash
# First-time server setup: API + admin page only. Desktop clients download the installer themselves.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source scripts/lib/remote.sh
load_deploy_env
parse_deploy_args "$@" || {
  cat <<'USAGE'
Usage: scripts/bootstrap-server.sh --host <ip> --password <ssh-password>

Installs Node API, MySQL, Nginx, and the admin page on Ubuntu/Debian.
Does not install the desktop client on the server.

Example:
  scripts/bootstrap-server.sh --host 1.2.3.4 --user root --password 'xxx'
USAGE
  exit 2
}
require_deploy_target

log "Building admin page locally"
npm ci
npm run build

log "Syncing API + admin files to ${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH}"
remote_ssh "mkdir -p '$DEPLOY_PATH'"
remote_rsync "$ROOT/" "$DEPLOY_PATH/"

log "Provisioning server packages and services"
remote_ssh "DEPLOY_PATH='$DEPLOY_PATH' DEPLOY_PUBLIC_URL='$DEPLOY_PUBLIC_URL' DEPLOY_INSTALL_MYSQL='${DEPLOY_INSTALL_MYSQL:-1}' DEPLOY_INSTALL_CHROME='${DEPLOY_INSTALL_CHROME:-1}' DEPLOY_SERVICE='$DEPLOY_SERVICE' bash '$DEPLOY_PATH/scripts/remote/provision.sh'"

log "Checking API health"
remote_ssh "curl -fsS http://127.0.0.1:8787/api/health"

if remote_ssh "test -f /root/axiom-first-login.txt"; then
  log "First login (change these immediately):"
  remote_ssh "cat /root/axiom-first-login.txt"
fi

log "Admin: ${DEPLOY_PUBLIC_URL}/admin.html"
log "Users download the desktop app from GitHub Releases and set the service URL to ${DEPLOY_PUBLIC_URL}"
