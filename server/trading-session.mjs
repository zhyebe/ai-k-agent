export const TRADING_SESSION_CLOSED_MESSAGE = "不在开盘期间，不能使用";

const SHANGHAI_OFFSET_MS = 8 * 3600000;

function shanghaiDate(now) {
  return new Date(now + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function shiftShanghaiDate(date, days) {
  return shanghaiDate(Date.parse(`${date}T00:00:00+08:00`) + days * 86400000);
}

function minuteIso(value) {
  const text = String(value ?? "").trim();
  const wallClock = text.match(/^(\d{4}-\d{2}-\d{2})[T ]([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  if (wallClock) {
    const parsed = Date.parse(`${wallClock[1]}T${wallClock[2]}:${wallClock[3]}:00+08:00`);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  return new Date(Math.floor(parsed / 60000) * 60000).toISOString();
}

export function defaultTradingSession(now = Date.now()) {
  const today = shanghaiDate(now);
  const openDay = now < Date.parse(`${today}T16:00:00+08:00`) ? shiftShanghaiDate(today, -1) : today;
  return {
    opensAt: new Date(Date.parse(`${openDay}T18:30:00+08:00`)).toISOString(),
    closesAt: new Date(Date.parse(`${shiftShanghaiDate(openDay, 1)}T16:00:00+08:00`)).toISOString(),
  };
}

export function parseTradingSession(value) {
  if (!value || typeof value !== "object") return null;
  const opensAt = minuteIso(value.opensAt);
  const closesAt = minuteIso(value.closesAt);
  if (!opensAt || !closesAt || Date.parse(closesAt) <= Date.parse(opensAt)) return null;
  return { opensAt, closesAt };
}

export function effectiveTradingSession(saved, now = Date.now()) {
  return parseTradingSession(saved) || defaultTradingSession(now);
}

export function assertTradingSessionOpen(saved, now = Date.now()) {
  const session = effectiveTradingSession(saved, now);
  const nowMs = Number(now);
  if (!(nowMs >= Date.parse(session.opensAt) && nowMs < Date.parse(session.closesAt))) {
    throw new Error(TRADING_SESSION_CLOSED_MESSAGE);
  }
  return session;
}

export function tradingSessionFromEnv(env = process.env) {
  const raw = String(env.AXIOM_TRADING_SESSION || "").trim();
  if (!raw) return null;
  try { return parseTradingSession(JSON.parse(raw)); } catch { return null; }
}
