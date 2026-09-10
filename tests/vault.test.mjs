import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-vault-test-"));
process.env.AXIOM_DATA_DIR = directory;
process.env.AXIOM_SECRET_FILE = path.join(directory, "secret");
const vault = await import("../server/vault.mjs");

test("stores and resolves credentials without exposing plaintext", async () => {
  await vault.initVault();
  const stored = await vault.storeCredential({
    username: "tester@example.com",
    password: "vault-only-password",
    label: "test",
    target: { type: "website", url: "https://demo.exchange.local", adapterId: "northstar-web" },
  });
  assert.equal(stored.accountLabel, "tes***com");
  assert.equal("password" in stored, false);
  const resolved = vault.getCredential(stored.credentialRef);
  assert.equal(resolved.username, "tester@example.com");
  assert.equal(resolved.password, "vault-only-password");
  const source = await fs.readFile(path.join(directory, "credentials.vault.json"), "utf8");
  assert.equal(source.includes("tester@example.com"), false);
  assert.equal(source.includes("vault-only-password"), false);
});

test("upserts the same owner's credential for the same website host", async () => {
  await vault.initVault();
  const first = await vault.storeCredential({
    username: "haohan-user",
    password: "first-pass",
    ownerUserId: "user_owner_1",
    target: { type: "website", url: "https://smyw.haohandahan.cn/client/#/transcc", adapterId: "haohan-readonly" },
  });
  const second = await vault.storeCredential({
    username: "haohan-user",
    password: "second-pass",
    ownerUserId: "user_owner_1",
    target: { type: "website", url: "https://smyw.haohandahan.cn/client/#/other", adapterId: "haohan-readonly" },
  });
  assert.equal(first.credentialRef, second.credentialRef);
  assert.equal(vault.getCredential(second.credentialRef, { ownerUserId: "user_owner_1" }).password, "second-pass");
  assert.equal(vault.findOwnedCredential({ ownerUserId: "user_owner_2", target: { type: "website", url: "https://smyw.haohandahan.cn/" } }), null);
  const owned = vault.findOwnedCredential({ ownerUserId: "user_owner_1", target: { type: "website", url: "https://smyw.haohandahan.cn/foo" } });
  assert.equal(owned.credentialRef, first.credentialRef);
});
