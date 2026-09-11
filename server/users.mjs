import crypto from "node:crypto";

const users = new Map();
const sessions = new Map();
const assignments = new Map();
let persistence = null;

const sessionTtlMs = Math.max(5 * 60 * 1000, Number(process.env.USER_SESSION_TTL_SEC || 30 * 24 * 60 * 60) * 1000);

function sameSecret(left, right) {
  const leftValue = Buffer.from(String(left || ""));
  const rightValue = Buffer.from(String(right || ""));
  return leftValue.length === rightValue.length && crypto.timingSafeEqual(leftValue, rightValue);
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  if (String(password || "").length < 8) throw new Error("USER_PASSWORD_TOO_SHORT");
  return `scrypt$${salt}$${crypto.scryptSync(String(password), salt, 64).toString("hex")}`;
}

function verifyPassword(password, encoded) {
  const [scheme, salt, expected] = String(encoded || "").split("$");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  try { return sameSecret(crypto.scryptSync(String(password || ""), salt, 64).toString("hex"), expected); } catch { return false; }
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    status: user.status,
    assignedTaskIds: [...(assignments.get(user.id) || [])],
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export function setUserPersistence(adapter) {
  persistence = adapter;
}

export function hydrateUsers(records = [], taskAssignments = []) {
  users.clear();
  assignments.clear();
  for (const record of Array.isArray(records) ? records : []) {
    if (!record?.id || !record?.username || !record?.passwordHash) continue;
    users.set(record.id, { ...record, username: normalizeUsername(record.username) });
  }
  for (const record of Array.isArray(taskAssignments) ? taskAssignments : []) {
    if (!record?.userId || !record?.taskId) continue;
    if (!assignments.has(record.userId)) assignments.set(record.userId, new Set());
    assignments.get(record.userId).add(record.taskId);
  }
}

export function listUsers() {
  return [...users.values()].map(publicUser).sort((left, right) => left.username.localeCompare(right.username));
}

export function getUser(userId) {
  return users.get(String(userId || "")) || null;
}

export async function createUser({ username, password, displayName = "" } = {}) {
  const normalized = normalizeUsername(username);
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(normalized)) throw new Error("USER_USERNAME_INVALID");
  if (usersHasUsername(normalized)) throw new Error("USER_ALREADY_EXISTS");
  const now = new Date().toISOString();
  const user = {
    id: `user_${crypto.randomUUID()}`,
    username: normalized,
    displayName: String(displayName || normalized).trim().slice(0, 120),
    passwordHash: hashPassword(password),
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  };
  if (persistence?.saveUser) await persistence.saveUser(user);
  users.set(user.id, user);
  return publicUser(user);
}

function usersHasUsername(username) {
  return [...users.values()].some((user) => user.username === username);
}

export async function updateUser(userId, { status, password, displayName } = {}) {
  const user = getUser(userId);
  if (!user) throw new Error("USER_NOT_FOUND");
  if (status !== undefined && !["ACTIVE", "DISABLED"].includes(status)) throw new Error("USER_STATUS_INVALID");
  const passwordChanged = Boolean(password);
  const updated = {
    ...user,
    status: status === undefined ? user.status : status,
    displayName: displayName === undefined ? user.displayName : String(displayName || user.username).trim().slice(0, 120),
    passwordHash: password ? hashPassword(password) : user.passwordHash,
    updatedAt: new Date().toISOString(),
  };
  if (persistence?.saveUser) await persistence.saveUser(updated);
  Object.assign(user, updated);
  if (user.status === "DISABLED" || passwordChanged) await revokeUserSessions(user.id);
  return publicUser(user);
}

export async function assignTask(userId, taskId) {
  const user = getUser(userId);
  if (!user) throw new Error("USER_NOT_FOUND");
  const normalizedTaskId = String(taskId || "").trim();
  if (!normalizedTaskId) throw new Error("TASK_ID_REQUIRED");
  if (persistence?.saveAssignment) await persistence.saveAssignment({ userId: user.id, taskId: normalizedTaskId });
  if (!assignments.has(user.id)) assignments.set(user.id, new Set());
  assignments.get(user.id).add(normalizedTaskId);
  return publicUser(user);
}

export async function unassignTask(userId, taskId) {
  const user = getUser(userId);
  if (!user) throw new Error("USER_NOT_FOUND");
  const taskSet = assignments.get(user.id);
  const normalizedTaskId = String(taskId || "");
  const removed = Boolean(taskSet?.has(normalizedTaskId));
  if (removed && persistence?.deleteAssignment) await persistence.deleteAssignment({ userId: user.id, taskId: normalizedTaskId });
  if (removed) taskSet.delete(normalizedTaskId);
  return publicUser(user);
}

export function assignedTaskIds(userId) {
  return [...(assignments.get(String(userId || "")) || [])];
}

export function canAccessTask(userId, taskId) {
  return assignments.get(String(userId || ""))?.has(String(taskId || "")) === true;
}

export function userIdsForTask(taskId) {
  const normalizedTaskId = String(taskId || "");
  return [...assignments.entries()]
    .filter(([, taskIds]) => taskIds.has(normalizedTaskId))
    .map(([userId]) => userId);
}

export async function createUserSession(username, password) {
  const normalized = normalizeUsername(username);
  const user = [...users.values()].find((item) => item.username === normalized);
  if (!user || user.status !== "ACTIVE" || !verifyPassword(password, user.passwordHash)) return null;
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenKey = tokenHash(token);
  const expiresAt = Date.now() + sessionTtlMs;
  const record = { tokenHash: tokenKey, userId: user.id, expiresAt };
  if (persistence?.saveUserSession) await persistence.saveUserSession(record);
  sessions.set(tokenKey, record);
  return { token, user: publicUser(user), expiresAt: new Date(expiresAt).toISOString() };
}

export function getUserSession(token) {
  const key = tokenHash(token);
  const session = sessions.get(key);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) {
      sessions.delete(key);
      persistence?.deleteUserSession?.(key).catch(() => {});
    }
    return null;
  }
  const user = getUser(session.userId);
  if (!user || user.status !== "ACTIVE") return null;
  if (session.expiresAt - Date.now() < sessionTtlMs / 2) {
    session.expiresAt = Date.now() + sessionTtlMs;
    persistence?.saveUserSession?.(session).catch(() => {});
  }
  return { user: publicUser(user), expiresAt: new Date(session.expiresAt).toISOString() };
}

export async function revokeUserSession(token) {
  const key = tokenHash(token);
  const removed = sessions.has(key);
  if (removed && persistence?.deleteUserSession) await persistence.deleteUserSession(key);
  if (removed) sessions.delete(key);
  return removed;
}

export async function revokeUserSessions(userId) {
  const keys = [];
  for (const [key, session] of sessions) {
    if (session.userId === String(userId)) keys.push(key);
  }
  if (persistence?.deleteUserSession) {
    for (const key of keys) await persistence.deleteUserSession(key);
  }
  for (const key of keys) sessions.delete(key);
}

export function removeUserState(userId) {
  const key = String(userId || "");
  if (!key) return false;
  for (const [token, session] of sessions) {
    if (session.userId === key) sessions.delete(token);
  }
  assignments.delete(key);
  return users.delete(key);
}

export function removeTaskAssignmentState(taskId) {
  const key = String(taskId || "");
  if (!key) return;
  for (const taskIds of assignments.values()) taskIds.delete(key);
}

export function clearTaskAssignmentState() {
  assignments.clear();
}

export function userTokenFromRequest(request) {
  const value = request.headers?.["x-user-token"];
  return Array.isArray(value) ? value[0] : value;
}

export async function requireUser(request, reply) {
  const session = getUserSession(userTokenFromRequest(request));
  if (!session) return reply.code(401).send({ error: "USER_AUTH_REQUIRED" });
  request.userSession = session;
  request.user = session.user;
}

export function hydrateUserSessions(records = []) {
  sessions.clear();
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.tokenHash && record?.userId && Number(record.expiresAt) > Date.now()) sessions.set(record.tokenHash, { tokenHash: record.tokenHash, userId: record.userId, expiresAt: Number(record.expiresAt) });
  }
}

export function userAuthStatus() {
  return { users: users.size, activeUsers: [...users.values()].filter((user) => user.status === "ACTIVE").length, sessionTtlSec: Math.round(sessionTtlMs / 1000) };
}

export function serializeUsers() {
  return [...users.values()];
}

export function serializeAssignments() {
  return [...assignments.entries()].flatMap(([userId, taskIds]) => [...taskIds].map((taskId) => ({ userId, taskId })));
}
