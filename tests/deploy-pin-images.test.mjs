import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/remote/pin-images.sh", import.meta.url)).replaceAll("\\", "/");

test("release pin survives repeated deployment while preserving database settings", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "axiom-release-pin-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const envFile = join(directory, ".env").replaceAll("\\", "/");
  const retained = "# production\nMYSQL_PASSWORD='literal-$value'\nAPP_SECRET=keep-me\n";
  writeFileSync(envFile, `${retained}AXIOM_API_IMAGE=axiom-agent-api:latest\nAXIOM_ADMIN_IMAGE=axiom-agent-nginx:latest\n`);
  for (const sha of ["a".repeat(40), "b".repeat(40), "b".repeat(40)]) {
    const result = spawnSync("bash", [script, sha, envFile], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const content = readFileSync(envFile, "utf8");
    assert.ok(content.startsWith(retained));
    assert.deepEqual(content.match(/^AXIOM_API_IMAGE=.*$/gm), [`AXIOM_API_IMAGE=axiom-agent-api:${sha}`]);
    assert.deepEqual(content.match(/^AXIOM_ADMIN_IMAGE=.*$/gm), [`AXIOM_ADMIN_IMAGE=axiom-agent-nginx:${sha}`]);
    if (process.platform !== "win32") assert.equal(statSync(envFile).mode & 0o777, 0o600);
  }
  const before = readFileSync(envFile, "utf8");
  assert.notEqual(spawnSync("bash", [script, "latest", envFile]).status, 0);
  assert.equal(readFileSync(envFile, "utf8"), before);
});

test("release cleanup retains rollback, unrelated and in-use images without forcing deletion", { skip: process.platform === "win32" }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "axiom-release-prune-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const docker = join(directory, "docker");
  const calls = join(directory, "calls");
  writeFileSync(docker, `#!/usr/bin/env bash
set -eu
case "$*" in
  'image inspect axiom-agent-api:current axiom-agent-nginx:current') exit 0 ;;
  'image ls --no-trunc --format '* )
    printf '%s\\n' \\
      'axiom-agent-api:current sha256:api-current' \\
      'axiom-agent-nginx:current sha256:admin-current' \\
      'axiom-agent-api:previous sha256:api-previous' \\
      'axiom-agent-nginx:previous sha256:admin-previous' \\
      'axiom-agent-api:old sha256:api-old' \\
      'axiom-agent-nginx:old sha256:admin-old' \\
      'axiom-agent-api:in-use sha256:in-use' \\
      'mysql:8.4 sha256:mysql' \\
      'another-service:latest sha256:other' \\
      '<none>:<none> sha256:unknown'
    ;;
  'image rm axiom-agent-api:in-use') printf '%s\\n' "$*" >> "$PRUNE_CALLS"; exit 1 ;;
  'image rm axiom-agent-api:old'|'image rm axiom-agent-nginx:old') printf '%s\\n' "$*" >> "$PRUNE_CALLS" ;;
  *) echo "Unexpected Docker operation: $*" >&2; exit 99 ;;
esac
`);
  chmodSync(docker, 0o700);
  const prune = fileURLToPath(new URL("../scripts/remote/prune-release-images.sh", import.meta.url));
  const result = spawnSync("bash", [prune, "axiom-agent-api:current", "axiom-agent-nginx:current", "sha256:api-previous", "sha256:admin-previous"], {
    encoding: "utf8", env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, PRUNE_CALLS: calls },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [
    "image rm axiom-agent-api:old", "image rm axiom-agent-nginx:old", "image rm axiom-agent-api:in-use",
  ]);
  assert.match(result.stderr, /retained: axiom-agent-api:in-use/);
  assert.doesNotMatch(result.stderr, /Unexpected Docker operation/);
});
