import { decryptSecret, encryptSecret, maskSecret } from "./crypto.mjs";

const defaultSystemPrompt = `You are a constrained market analysis agent. Return JSON only with action BUY, SELL, or HOLD. Never change risk limits, permissions, or capital allocation. When evidence is missing or stale, return HOLD.`;

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error("PROVIDER_URL_INVALID"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("PROVIDER_URL_INVALID");
  return parsed.toString().replace(/\/$/, "");
}

export function publicProvider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    model: provider.model,
    baseUrl: provider.baseUrl,
    configured: Boolean(provider.encryptedKey),
    keyPreview: provider.keyPreview || maskSecret(decryptSecret(provider.encryptedKey)),
    status: provider.status || "未验证",
  };
}

export function createProvider(payload, existing = null) {
  const hasApiKey = Object.prototype.hasOwnProperty.call(payload, "apiKey");
  const key = hasApiKey ? String(payload.apiKey || "").trim() : decryptSecret(existing?.encryptedKey);
  const baseUrl = normalizeBaseUrl(payload.baseUrl ?? existing?.baseUrl);
  return {
    id: payload.id || existing?.id || `provider_${Date.now()}`,
    name: String(payload.name ?? existing?.name ?? "自定义 Provider").trim(),
    model: String(payload.model ?? existing?.model ?? "default").trim(),
    baseUrl,
    encryptedKey: key ? encryptSecret(key) : "",
    keyPreview: key ? maskSecret(key) : "",
    status: key ? "待验证" : "未配置",
  };
}

export async function verifyProvider(provider, { timeoutMs = 8000 } = {}) {
  const apiKey = decryptSecret(provider?.encryptedKey);
  const baseUrl = normalizeBaseUrl(provider?.baseUrl);
  if (!apiKey || !baseUrl) return { ok: false, code: "PROVIDER_NOT_READY", status: "未配置" };
  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(Math.min(15000, Math.max(1000, Number(timeoutMs) || 8000))),
    });
    if (response.ok) return { ok: true, code: "PROVIDER_OK", status: "已验证", httpStatus: response.status };
    if (response.status === 401 || response.status === 403) return { ok: false, code: "PROVIDER_AUTH_FAILED", status: "Endpoint 可达，Key 无效", httpStatus: response.status };
    return { ok: false, code: "PROVIDER_HTTP_ERROR", status: `Endpoint 返回 HTTP ${response.status}`, httpStatus: response.status };
  } catch (error) {
    return { ok: false, code: "PROVIDER_UNREACHABLE", status: "Endpoint 不可达", message: error?.message || "请求失败" };
  }
}

function normalizeDecision(value) {
  const action = ["BUY", "SELL", "HOLD"].includes(value?.action) ? value.action : "HOLD";
  const confidence = Math.min(1, Math.max(0, Number(value?.confidence) || 0));
  const ttl = Math.min(3600, Math.max(30, Number(value?.decision_ttl_sec) || 300));
  return {
    action,
    targetPositionPct: Math.min(100, Math.max(0, Number(value?.target_position_pct) || 0)),
    maxOrderValuePct: Math.min(100, Math.max(0, Number(value?.max_order_value_pct) || 0)),
    confidence,
    decisionTtlSec: ttl,
    reasonCodes: Array.isArray(value?.reason_codes) ? value.reason_codes.slice(0, 8) : [],
    evidenceIds: Array.isArray(value?.evidence_ids) ? value.evidence_ids.slice(0, 8) : [],
    invalidation: String(value?.invalidation || "数据过期或风险超限时失效"),
    riskFlags: Array.isArray(value?.risk_flags) ? value.risk_flags.slice(0, 8) : [],
  };
}

export async function requestDecision(provider, context, options = {}) {
  if (!provider?.encryptedKey || options.demo === true) {
    return normalizeDecision({
      action: context.market?.trend === "up" ? "BUY" : "HOLD",
      target_position_pct: context.market?.trend === "up" ? 24 : 0,
      max_order_value_pct: 8,
      confidence: context.market?.trend === "up" ? 0.78 : 0.42,
      decision_ttl_sec: 300,
      reason_codes: ["EMA_SLOPE_POSITIVE", "VOLUME_CONFIRMATION"],
      evidence_ids: context.evidenceIds || [],
      invalidation: "15m 收盘跌破 EMA20 或数据延迟超过 5 秒",
      risk_flags: [],
    });
  }

  const apiKey = decryptSecret(provider.encryptedKey);
  if (!apiKey || !provider.baseUrl) return normalizeDecision({ action: "HOLD", risk_flags: ["PROVIDER_NOT_READY"] });
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: provider.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: defaultSystemPrompt },
        { role: "user", content: JSON.stringify(context) },
      ],
    }),
    signal: AbortSignal.timeout(options.timeoutMs || 12000),
  });
  if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) return normalizeDecision({ action: "HOLD", risk_flags: ["EMPTY_MODEL_RESPONSE"] });
  try {
    return normalizeDecision(JSON.parse(content));
  } catch {
    return normalizeDecision({ action: "HOLD", risk_flags: ["INVALID_MODEL_JSON"] });
  }
}
