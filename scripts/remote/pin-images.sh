#!/usr/bin/env bash
# Keep ordinary Compose restarts on the release that passed its health check.
set -euo pipefail

IMAGE_VERSION="${1:?Release commit SHA required}"
ENV_FILE="${2:-.env}"
[[ "$IMAGE_VERSION" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid release commit SHA' >&2; exit 1; }
test -f "$ENV_FILE"

PIN_TEMP="$(mktemp "${ENV_FILE}.pin.XXXXXX")"
trap 'rm -f -- "$PIN_TEMP"' EXIT
chmod 600 "$PIN_TEMP"
awk '!/^(AXIOM_API_IMAGE|AXIOM_ADMIN_IMAGE)=/' "$ENV_FILE" > "$PIN_TEMP"
printf '\nAXIOM_API_IMAGE=axiom-agent-api:%s\nAXIOM_ADMIN_IMAGE=axiom-agent-nginx:%s\n' \
  "$IMAGE_VERSION" "$IMAGE_VERSION" >> "$PIN_TEMP"
mv -f -- "$PIN_TEMP" "$ENV_FILE"
