import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { decryptSecret, encryptSecret, maskSecret } from "./crypto.mjs";

let vaultFile = "";
let records = new Map();
let ready = false;
let writeQueue = Promise.resolve();
let persistence = null;

function ownerIdOf(record) {
  return String(record?.ownerUserId || record?.target?.ownerUserId || "");
}

function ownerAllowed(record, options = {}) {
  const normalized = typeof options === "string" ? { ownerUserId: options } : options || {};
  const ownerUserId = String(normalized.ownerUserId || "");
  const ownerUserIds = Array.isArray(normalized.ownerUserIds) ? normalized.ownerUserIds.map((value) => String(value)) : [];
  if (!ownerUserId && !ownerUserIds.length) return true;
  const allowed = new Set([ownerUserId, ...ownerUserIds].filter(Boolean));
  const recordOwner = ownerIdOf(record);
  return Boolean(recordOwner && allowed.has(recordOwner));
}

export function setVaultPersistence(adapter) {
  persistence = adapter;
}

function resolveVaultFile() {
  if (process.env.AXIOM_VAULT_FILE) return path.resolve(process.env.AXIOM_VAULT_FILE);
  const dataDir = process.env.AXIOM_DATA_DIR || path.join(os.homedir(), ".axiom-agent");
  return path.join(path.resolve(dataDir), "credentials.vault.json");
}

async function persist() {
  const payload = JSON.stringify([...records.values()], null, 2);
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(path.dirname(vaultFile), { recursive: true });
    const temporaryFile = `${vaultFile}.${process.pid}.tmp`;
    await fs.writeFile(temporaryFile, payload, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryFile, vaultFile);
    try { await fs.chmod(vaultFile, 0o600); } catch {}
  });
  return writeQueue;
}

export async function initVault({ persistedRecords = [] } = {}) {
  if (ready) return { file: vaultFile, count: records.size };
  vaultFile = resolveVaultFile();
  try {
    const source = await fs.readFile(vaultFile, "utf8");
    const parsed = JSON.parse(source);
    if (Array.isArray(parsed)) {
      records = new Map(parsed.filter((item) => item?.id && item?.username && item?.password).map((item) => [item.id, item]));
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(`VAULT_READ_FAILED: ${error.message}`);
  }
  for (const item of persistedRecords) if (item?.id && item?.username && item?.password) records.set(item.id, item);
  ready = true;
  return { file: vaultFile, count: records.size };
}

async function ensureReady() {
  if (!ready) await initVault();
}

export async function storeCredential({ username, password, target = {}, label = "", ownerUserId = "" }) {
  await ensureReady();
  const normalizedUsername = String(username || "").trim();
  const normalizedPassword = String(password || "");
  if (!normalizedUsername || !normalizedPassword) throw new Error("CREDENTIALS_REQUIRED");
  const id = `cred_${crypto.randomUUID()}`;
  const record = {
    id,
    ownerUserId: String(ownerUserId || ""),
    username: encryptSecret(normalizedUsername),
    password: encryptSecret(normalizedPassword),
    target: {
      type: target.type === "app" ? "app" : "website",
      url: String(target.url || ""),
      installPath: String(target.installPath || ""),
      adapterId: String(target.adapterId || ""),
    },
    label: String(label || ""),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  records.set(id, record);
  await persist();
  if (persistence?.saveCredential) await persistence.saveCredential(record);
  return publicCredential(record);
}

export function getCredential(credentialRef, options = {}) {
  const record = records.get(String(credentialRef || ""));
  if (!record || !ownerAllowed(record, options)) return null;
  const username = decryptSecret(record.username);
  const password = decryptSecret(record.password);
  if (!username || !password) return null;
  return { credentialRef: record.id, username, password, target: record.target, label: record.label };
}

export function credentialExists(credentialRef, options = {}) {
  return Boolean(getCredential(credentialRef, options));
}

export function publicCredential(record) {
  const username = decryptSecret(record.username);
  return {
    credentialRef: record.id,
    accountLabel: maskSecret(username),
    ownerUserId: ownerIdOf(record),
    target: record.target,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function listCredentials(options = {}) {
  return [...records.values()].filter((record) => ownerAllowed(record, options)).map(publicCredential);
}

export async function removeCredential(credentialRef, options = {}) {
  await ensureReady();
  const record = records.get(String(credentialRef || ""));
  const deleted = Boolean(record && ownerAllowed(record, options) && records.delete(String(credentialRef || "")));
  if (deleted) await persist();
  return deleted;
}

export function vaultStatus() {
  return { configured: Boolean(vaultFile), count: records.size, file: vaultFile ? path.basename(vaultFile) : "" };
}
