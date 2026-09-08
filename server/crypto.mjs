import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const configuredSecret = String(process.env.APP_SECRET || "").trim();
let persistentSecret = Boolean(configuredSecret);

function resolveSecret() {
  if (configuredSecret) return configuredSecret;
  const secretFile = String(process.env.AXIOM_SECRET_FILE || "").trim();
  if (secretFile) {
    try {
      const existing = fs.readFileSync(secretFile, "utf8").trim();
      if (existing) {
        persistentSecret = true;
        return existing;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") return `axiom-ephemeral-${process.pid}-${crypto.randomBytes(16).toString("hex")}`;
    }
    try {
      fs.mkdirSync(path.dirname(secretFile), { recursive: true });
      const generated = crypto.randomBytes(32).toString("base64url");
      fs.writeFileSync(secretFile, `${generated}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      persistentSecret = true;
      return generated;
    } catch {
      try {
        const existing = fs.readFileSync(secretFile, "utf8").trim();
        if (existing) {
          persistentSecret = true;
          return existing;
        }
      } catch {
        return `axiom-ephemeral-${process.pid}-${crypto.randomBytes(16).toString("hex")}`;
      }
    }
  }
  return `axiom-ephemeral-${process.pid}-${crypto.randomBytes(16).toString("hex")}`;
}

const secret = resolveSecret();
const key = crypto.createHash("sha256").update(secret).digest();

export function encryptSecret(value) {
  if (!value) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptSecret(payload) {
  if (!payload) return "";
  const [ivValue, tagValue, encryptedValue] = payload.split(".");
  if (!ivValue || !tagValue || !encryptedValue) return "";
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return "";
  }
}

export function maskSecret(value) {
  if (!value) return "未配置";
  if (value.length <= 6) return "***";
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

export function hasPersistentSecret() {
  return persistentSecret;
}
