import crypto from "node:crypto";

const adminUsername = String(process.env.ADMIN_USERNAME || "admin");
const adminPassword = String(process.env.ADMIN_PASSWORD || "local-admin");
const sessionTtlMs = Math.max(5 * 60 * 1000, Number(process.env.ADMIN_SESSION_TTL_SEC || 28800) * 1000);
const sessions = new Map();

function sameSecret(left, right) {
  const leftValue = Buffer.from(String(left || ""));
  const rightValue = Buffer.from(String(right || ""));
  return leftValue.length === rightValue.length && crypto.timingSafeEqual(leftValue, rightValue);
}

export function createAdminSession(username, password) {
  if (!sameSecret(username, adminUsername) || !sameSecret(password, adminPassword)) return null;
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + sessionTtlMs;
  sessions.set(token, { username: adminUsername, expiresAt });
  return { token, username: adminUsername, expiresAt: new Date(expiresAt).toISOString() };
}

export function getAdminSession(token) {
  const value = sessions.get(String(token || ""));
  if (!value) return null;
  if (value.expiresAt <= Date.now()) {
    sessions.delete(String(token || ""));
    return null;
  }
  return { username: value.username, expiresAt: new Date(value.expiresAt).toISOString() };
}

export function revokeAdminSession(token) {
  return sessions.delete(String(token || ""));
}

export function adminTokenFromRequest(request) {
  const value = request.headers?.["x-admin-token"];
  return Array.isArray(value) ? value[0] : value;
}

export async function requireAdmin(request, reply) {
  const session = getAdminSession(adminTokenFromRequest(request));
  if (!session) return reply.code(401).send({ error: "ADMIN_AUTH_REQUIRED" });
  request.adminSession = session;
}

export function adminAuthStatus() {
  return { username: adminUsername, passwordConfigured: Boolean(process.env.ADMIN_PASSWORD), ttlSec: Math.round(sessionTtlMs / 1000) };
}
