#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source scripts/lib/remote.sh
load_deploy_env
parse_deploy_args "$@" || true
require_deploy_target
remote_ssh "curl -fsS http://127.0.0.1:8787/api/health && systemctl is-active '$DEPLOY_SERVICE'"
log "Admin URL: ${DEPLOY_PUBLIC_URL}/admin.html"
