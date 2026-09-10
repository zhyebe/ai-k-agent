#!/usr/bin/env bash
# One-time: add a GitHub deploy key, Actions SSH key, and convert the server to a git checkout.
# Does not print private keys or tokens.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source scripts/lib/remote.sh
load_deploy_env
require_deploy_target
open_ssh_master

REPO="${GITHUB_REPOSITORY:-zhyebe/ai-k-agent}"
KEY_TITLE="axiom-server-${DEPLOY_HOST}"
ACTIONS_COMMENT="github-actions-axiom-deploy"

github_token() {
  printf 'protocol=https\nhost=github.com\n\n' | git credential fill | awk -F= '/^password=/{print $2}'
}

github_api() {
  local method="$1"
  local path="$2"
  local data="${3:-}"
  local token
  token="$(github_token)"
  if [[ -n "$data" ]]; then
    curl -sS -X "$method" \
      -H "Authorization: Bearer ${token}" \
      -H "Accept: application/vnd.github+json" \
      -H "Content-Type: application/json" \
      "https://api.github.com${path}" \
      -d "$data"
  else
    curl -sS -X "$method" \
      -H "Authorization: Bearer ${token}" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com${path}"
  fi
}

log "Installing git and creating the server pull key"
remote_ssh 'set -euo pipefail
command -v git >/dev/null || yum install -y git || apt-get install -y git
mkdir -p /root/.ssh
chmod 700 /root/.ssh
if [[ ! -f /root/.ssh/axiom-github ]]; then
  ssh-keygen -t ed25519 -N "" -C "axiom-server-git-pull" -f /root/.ssh/axiom-github >/dev/null
fi
chmod 600 /root/.ssh/axiom-github
cat > /root/.ssh/config <<EOF
Host github.com
  HostName ssh.github.com
  Port 443
  User git
  IdentityFile /root/.ssh/axiom-github
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
EOF
chmod 600 /root/.ssh/config
'

PULL_PUB="$(remote_ssh 'cat /root/.ssh/axiom-github.pub')"
log "Server pull public key ready"

EXISTING_KEYS="$(github_api GET "/repos/${REPO}/keys")"
if python3 - "$EXISTING_KEYS" "$PULL_PUB" <<'PY'
import json, sys
keys = json.loads(sys.argv[1] or "[]")
pub = sys.argv[2].split()[1]
raise SystemExit(0 if any(pub in item.get("key","") for item in keys) else 1)
PY
then
  log "Deploy key already present on GitHub"
else
  log "Adding read-only deploy key ${KEY_TITLE}"
  KEY_RESP="$(github_api POST "/repos/${REPO}/keys" "$(python3 -c 'import json,sys; print(json.dumps({"title":sys.argv[1],"key":sys.argv[2],"read_only":True}))' "$KEY_TITLE" "$PULL_PUB")")"
  python3 -c 'import json,sys; d=json.loads(sys.argv[1]); assert d.get("id"), d; print("deploy key id", d["id"], "read_only", d.get("read_only"))' "$KEY_RESP"
fi

WORKDIR="$(mktemp -d)"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT
ssh-keygen -t ed25519 -N "" -C "$ACTIONS_COMMENT" -f "$WORKDIR/actions" >/dev/null
ACTIONS_PUB="$(cat "$WORKDIR/actions.pub")"
ACTIONS_PRIV="$(cat "$WORKDIR/actions")"
log "Installing Actions deploy SSH key on the server"
remote_ssh "grep -F '$ACTIONS_COMMENT' /root/.ssh/authorized_keys >/dev/null 2>&1 || echo '$ACTIONS_PUB' >> /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys"

log "Writing GitHub Actions secrets"
PUBKEY_JSON="$(github_api GET "/repos/${REPO}/actions/secrets/public-key")"
python3 - "$PUBKEY_JSON" "$ACTIONS_PRIV" "$DEPLOY_HOST" "${DEPLOY_USER:-root}" "${DEPLOY_PORT:-22}" "${DEPLOY_PATH:-/opt/axiom-agent}" "$REPO" <<'PY' > "$WORKDIR/secrets.json"
import base64, json, sys, urllib.request
try:
    from nacl import encoding, public
except ImportError:
    raise SystemExit("python3 -m pip install pynacl")

meta, priv, host, user, port, path, repo = sys.argv[1:8]
meta = json.loads(meta)
box = public.SealedBox(public.PublicKey(meta["key"].encode(), encoding.Base64Encoder()))

def enc(value: str) -> str:
    return base64.b64encode(box.encrypt(value.encode())).decode()

token = None
# token is not passed; caller uses git credential in the shell wrapper below
print(json.dumps({
    "key_id": meta["key_id"],
    "secrets": {
        "DEPLOY_HOST": enc(host),
        "DEPLOY_USER": enc(user),
        "DEPLOY_PORT": enc(port),
        "DEPLOY_PATH": enc(path),
        "DEPLOY_SSH_KEY": enc(priv),
    }
}))
PY

TOKEN="$(github_token)"
python3 - "$WORKDIR/secrets.json" "$TOKEN" "$REPO" <<'PY'
import json, sys, urllib.request
payload = json.load(open(sys.argv[1]))
token, repo = sys.argv[2], sys.argv[3]
for name, encrypted in payload["secrets"].items():
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/actions/secrets/{name}",
        data=json.dumps({"encrypted_value": encrypted, "key_id": payload["key_id"]}).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
        },
        method="PUT",
    )
    with urllib.request.urlopen(req) as resp:
        print(f"secret {name} HTTP {resp.status}")
PY

log "Converting /opt/axiom-agent into a git checkout"
remote_ssh "set -euo pipefail
cd '${DEPLOY_PATH}'
if [[ ! -d .git ]]; then
  git init
  git remote add origin git@github.com:${REPO}.git || git remote set-url origin git@github.com:${REPO}.git
fi
export GIT_SSH_COMMAND='ssh -i /root/.ssh/axiom-github -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new'
git fetch --tags origin
git checkout -f -B main origin/main
test -f .env
git rev-parse --short HEAD
git log -1 --oneline
"

log "Git deploy is ready. Publish a GitHub Release or run Actions: Deploy API"
