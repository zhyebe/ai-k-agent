#!/usr/bin/env bash
set -euo pipefail

CURRENT_API="${1:?Current API image required}"
CURRENT_ADMIN="${2:?Current admin image required}"
PREVIOUS_API="${3:-}"
PREVIOUS_ADMIN="${4:-}"
docker image inspect "$CURRENT_API" "$CURRENT_ADMIN" >/dev/null

# Only project release images; keep the current and previous images for rollback.
# Never remove volumes or force removal of an image referenced by a container.
while read -r REF IMAGE_ID; do
  case "$REF" in axiom-agent-api:*|axiom-agent-nginx:*) ;; *) continue ;; esac
  if [[ "$REF" == "$CURRENT_API" || "$REF" == "$CURRENT_ADMIN" || \
        "$IMAGE_ID" == "$PREVIOUS_API" || "$IMAGE_ID" == "$PREVIOUS_ADMIN" ]]; then
    continue
  fi
  docker image rm "$REF" || echo "Could not remove image; retained: $REF" >&2
done < <(docker image ls --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}')
