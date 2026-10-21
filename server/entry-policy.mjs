// Legacy signal-label/API value. Entry routing is AI-action driven; this is no
// longer a hard execution threshold.
export const MIN_PROFIT_PROBABILITY = 0.4;

export function normalizeMarketRegime(value) {
  const regime = String(value || "").trim().toUpperCase();
  return ["UP", "DOWN", "RANGE"].includes(regime) ? regime : "UNKNOWN";
}

export function hasDirectionalProbabilities(decision) {
  if (decision?.directionalProbabilitiesComplete === false) return false;
  return [decision?.bullishProfitProbability, decision?.bearishProfitProbability].every((value) => {
    if (typeof value !== "number" && typeof value !== "string") return false;
    const text = String(value).trim();
    if (!text) return false;
    const numeric = Number(text.replace(/[%％]/g, "").trim());
    const unit = /[%％]/.test(text) || numeric > 1 ? numeric / 100 : numeric;
    return Number.isFinite(unit) && unit >= 0 && unit <= 1;
  });
}
