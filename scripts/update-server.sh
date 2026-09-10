#!/usr/bin/env bash
# SSH to the API host and pull + rebuild. Usage: scripts/update-server.sh [ref]
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source scripts/lib/remote.sh
load_deploy_env
require_deploy_target
open_ssh_master
REF="${1:-main}"
log "Updating ${DEPLOY_HOST} to ${REF}"
remote_ssh "DEPLOY_PATH='$DEPLOY_PATH' DEPLOY_PUBLIC_URL='$DEPLOY_PUBLIC_URL' DEPLOY_INTERNAL_HOST='$DEPLOY_INTERNAL_HOST' bash '$DEPLOY_PATH/scripts/remote/update.sh' '$REF'"
