# Shared SSH helpers. Source from other scripts. Never print passwords.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

load_deploy_env() {
  if [[ -f "$ROOT/scripts/deploy.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$ROOT/scripts/deploy.env"
    set +a
  fi
}

parse_deploy_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --host) DEPLOY_HOST="$2"; shift 2 ;;
      --user) DEPLOY_USER="$2"; shift 2 ;;
      --port) DEPLOY_PORT="$2"; shift 2 ;;
      --password) DEPLOY_PASSWORD="$2"; shift 2 ;;
      --identity) DEPLOY_IDENTITY="$2"; shift 2 ;;
      --path) DEPLOY_PATH="$2"; shift 2 ;;
      --url|--public-url) DEPLOY_PUBLIC_URL="$2"; shift 2 ;;
      --internal-host) DEPLOY_INTERNAL_HOST="$2"; shift 2 ;;
      --public-port) DEPLOY_PUBLIC_PORT="$2"; shift 2 ;;
      --client-port) DEPLOY_CLIENT_PORT="$2"; shift 2 ;;
      --skip-build) DEPLOY_SKIP_BUILD=1; shift ;;
      -h|--help) return 2 ;;
      *) die "unknown argument: $1" ;;
    esac
  done
}

require_deploy_target() {
  DEPLOY_HOST="${DEPLOY_HOST:-}"
  DEPLOY_USER="${DEPLOY_USER:-root}"
  DEPLOY_PORT="${DEPLOY_PORT:-22}"
  DEPLOY_PATH="${DEPLOY_PATH:-/opt/axiom-agent}"
  DEPLOY_SERVICE="${DEPLOY_SERVICE:-axiom-api}"
  [[ -n "$DEPLOY_HOST" ]] || die "set DEPLOY_HOST or pass --host"
  [[ "$DEPLOY_HOST" =~ ^[A-Za-z0-9._:-]+$ ]] || die "DEPLOY_HOST looks invalid"
  DEPLOY_PUBLIC_URL="${DEPLOY_PUBLIC_URL:-http://${DEPLOY_HOST}}"
  DEPLOY_INTERNAL_HOST="${DEPLOY_INTERNAL_HOST:-172.19.62.79}"
  DEPLOY_PUBLIC_PORT="${DEPLOY_PUBLIC_PORT:-80}"
  DEPLOY_CLIENT_PORT="${DEPLOY_CLIENT_PORT:-8787}"
  SSH_CONTROL_PATH="${TMPDIR:-/tmp}/axiom-ssh-${DEPLOY_HOST}.sock"
}

ssh_base_opts() {
  local opts=(-F /dev/null -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o GlobalKnownHostsFile=/dev/null -o ConnectTimeout=20 -p "$DEPLOY_PORT")
  if [[ -n "${DEPLOY_IDENTITY:-}" ]]; then
    opts+=(-i "$DEPLOY_IDENTITY")
  fi
  if [[ -n "${SSH_CONTROL_PATH:-}" && -S "$SSH_CONTROL_PATH" ]]; then
    opts+=(-o ControlMaster=no -o ControlPath="$SSH_CONTROL_PATH")
  fi
  printf '%s\n' "${opts[@]}"
}

open_ssh_master() {
  [[ -n "${DEPLOY_PASSWORD:-}" ]] || return 0
  if [[ -S "${SSH_CONTROL_PATH:-}" ]]; then
    if ssh -F /dev/null -O check -o ControlPath="$SSH_CONTROL_PATH" \
      -o ControlMaster=no "${DEPLOY_USER}@${DEPLOY_HOST}" >/dev/null 2>&1; then
      return 0
    fi
    ssh -F /dev/null -O exit -o ControlPath="$SSH_CONTROL_PATH" \
      "${DEPLOY_USER}@${DEPLOY_HOST}" >/dev/null 2>&1 || true
    rm -f "$SSH_CONTROL_PATH"
  fi
  command -v expect >/dev/null 2>&1 || die "password login needs expect"
  expect "$ROOT/scripts/lib/ssh-with-password.exp" "$DEPLOY_PASSWORD" \
    ssh -F /dev/null -M -o ControlMaster=yes -o ControlPersist=600 \
    -o ControlPath="$SSH_CONTROL_PATH" \
    -o StrictHostKeyChecking=accept-new \
    -o UserKnownHostsFile=/dev/null \
    -o GlobalKnownHostsFile=/dev/null \
    -o ConnectTimeout=20 -p "$DEPLOY_PORT" \
    "${DEPLOY_USER}@${DEPLOY_HOST}" true
  [[ -S "$SSH_CONTROL_PATH" ]] || die "failed to open SSH control master"
}

have_sshpass() { command -v sshpass >/dev/null 2>&1; }

remote_ssh() {
  local opts=()
  while IFS= read -r item; do opts+=("$item"); done < <(ssh_base_opts)
  if [[ -S "${SSH_CONTROL_PATH:-}" ]]; then
    ssh "${opts[@]}" "${DEPLOY_USER}@${DEPLOY_HOST}" "$@"
    return
  fi
  if [[ -n "${DEPLOY_PASSWORD:-}" ]] && have_sshpass; then
    SSHPASS="$DEPLOY_PASSWORD" sshpass -e ssh "${opts[@]}" "${DEPLOY_USER}@${DEPLOY_HOST}" "$@"
    return
  fi
  if [[ -n "${DEPLOY_PASSWORD:-}" ]]; then
    command -v expect >/dev/null 2>&1 || die "password login needs sshpass or expect"
    expect "$ROOT/scripts/lib/ssh-with-password.exp" "$DEPLOY_PASSWORD" \
      ssh "${opts[@]}" "${DEPLOY_USER}@${DEPLOY_HOST}" "$@"
    return
  fi
  ssh "${opts[@]}" "${DEPLOY_USER}@${DEPLOY_HOST}" "$@"
}

remote_rsync() {
  local src="$1"
  local dest="$2"
  local opts=()
  while IFS= read -r item; do opts+=("$item"); done < <(ssh_base_opts)
  local excludes=(
    --exclude .git
    --exclude node_modules
    --exclude .axiom-data
    --exclude .env
    --exclude .first-login
    --exclude scripts/deploy.env
    --exclude release
    --exclude electron
    --exclude '*.log'
    --exclude .DS_Store
  )
  local ssh_cmd
  if [[ -S "${SSH_CONTROL_PATH:-}" ]]; then
    rsync -az --delete "${excludes[@]}" -e "ssh $(printf '%q ' "${opts[@]}")" \
      "$src" "${DEPLOY_USER}@${DEPLOY_HOST}:${dest}"
    return
  fi
  if [[ -n "${DEPLOY_PASSWORD:-}" ]] && have_sshpass; then
    ssh_cmd="sshpass -e ssh $(printf '%q ' "${opts[@]}")"
    SSHPASS="$DEPLOY_PASSWORD" rsync -az --delete "${excludes[@]}" -e "$ssh_cmd" \
      "$src" "${DEPLOY_USER}@${DEPLOY_HOST}:${dest}"
    return
  fi
  if [[ -n "${DEPLOY_PASSWORD:-}" ]]; then
    ssh_cmd="expect $(printf '%q' "$ROOT/scripts/lib/ssh-with-password.exp") $(printf '%q' "$DEPLOY_PASSWORD") ssh $(printf '%q ' "${opts[@]}")"
    rsync -az --delete "${excludes[@]}" -e "$ssh_cmd" \
      "$src" "${DEPLOY_USER}@${DEPLOY_HOST}:${dest}"
    return
  fi
  rsync -az --delete "${excludes[@]}" -e "ssh $(printf '%q ' "${opts[@]}")" \
    "$src" "${DEPLOY_USER}@${DEPLOY_HOST}:${dest}"
}

remote_tar_sync() {
  local dest="$1"
  COPYFILE_DISABLE=1 tar -C "$ROOT" -czf - \
    --exclude .git \
    --exclude node_modules \
    --exclude .axiom-data \
    --exclude .env \
    --exclude .first-login \
    --exclude scripts/deploy.env \
    --exclude release \
    --exclude electron \
    --exclude '*.log' \
    --exclude .DS_Store \
    . | remote_ssh "mkdir -p '$dest' && tar -xzf - -C '$dest'"
}
