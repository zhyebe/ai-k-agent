#!/usr/bin/env bash
# Dump local MySQL plus vault/secret files for server import. Does not print secrets.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/.axiom-data/migrate}"
mkdir -p "$OUT"
chmod 700 "$OUT"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

MYSQL_URL="${MYSQL_URL:-mysql://root:password@127.0.0.1:3306/axiom_agent}"
python3 - "$MYSQL_URL" "$OUT/mysql.sql" <<'PY'
import os, subprocess, sys, urllib.parse
url = urllib.parse.urlparse(sys.argv[1])
out = sys.argv[2]
user = urllib.parse.unquote(url.username or "root")
password = urllib.parse.unquote(url.password or "")
host = url.hostname or "127.0.0.1"
port = str(url.port or 3306)
db = (url.path or "/axiom_agent").lstrip("/") or "axiom_agent"
cmd = [
    "mysqldump", f"-h{host}", f"-P{port}", f"-u{user}", f"-p{password}",
    "--single-transaction", "--routines", "--add-drop-table",
    "--default-character-set=utf8mb4", db,
]
with open(out, "wb") as handle:
    result = subprocess.run(cmd, stdout=handle, stderr=subprocess.PIPE)
if result.returncode != 0:
    sys.stderr.write(result.stderr.decode("utf-8", "replace"))
    raise SystemExit(result.returncode)
print(f"mysql dump {os.path.getsize(out)} bytes")
PY

if [[ -n "${APP_SECRET:-}" ]]; then
  printf '%s' "$APP_SECRET" > "$OUT/app-secret"
  chmod 600 "$OUT/app-secret"
fi
if [[ -n "${ADMIN_USERNAME:-}" ]]; then
  printf '%s' "$ADMIN_USERNAME" > "$OUT/admin-username"
  chmod 600 "$OUT/admin-username"
fi
if [[ -n "${ADMIN_PASSWORD:-}" ]]; then
  printf '%s' "$ADMIN_PASSWORD" > "$OUT/admin-password"
  chmod 600 "$OUT/admin-password"
fi
if [[ -f "$ROOT/.axiom-data/credentials.vault.json" ]]; then
  cp "$ROOT/.axiom-data/credentials.vault.json" "$OUT/credentials.vault.json"
  chmod 600 "$OUT/credentials.vault.json"
fi
echo "export ready"
