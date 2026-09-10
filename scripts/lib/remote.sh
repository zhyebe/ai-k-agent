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
}

ssh_base_opts() {
  local opts=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -p "$DEPLOY_PORT")
  if [[ -n "${DEPLOY_IDENTITY:-}" ]]; then
    opts+=(-i "$DEPLOY_IDENTITY")
  fi
  printf '%s\n' "${opts[@]}"
}

have_sshpass() { command -v sshpass >/dev/null 2>&1; }

remote_ssh() {
  local opts=()
  while IFS= read -r item; do opts+=("$item"); done < <(ssh_base_opts)
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
    --exclude scripts/deploy.env
    --exclude release
    --exclude electron
    --exclude '*.log'
    --exclude .DS_Store
  )
  local ssh_cmd
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
