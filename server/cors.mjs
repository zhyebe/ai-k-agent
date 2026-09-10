export function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isAllowedCorsOrigin(origin, { extraOrigins = [], extraHosts = [] } = {}) {
  if (!origin) return true;
  const origins = new Set([
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "http://127.0.0.1:8787",
    "http://localhost:8787",
    "null",
    ...extraOrigins,
  ]);
  if (origins.has(origin)) return true;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return false;
  const hosts = new Set(["127.0.0.1", "localhost", ...extraHosts]);
  return hosts.has(parsed.hostname);
}
