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

export function higherProbabilityDirection(decision) {
  if (!hasDirectionalProbabilities(decision)) return null;
  const bullish = decision?.bullishProfitProbability;
  const bearish = decision?.bearishProfitProbability;
  if (![bullish, bearish].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)) return null;
  // Decimal probabilities must not make an exact five-point gap look smaller.
  const gap = Math.round(Math.abs(bullish - bearish) * 1e12) / 1e12;
  if (gap === 0 || gap >= 0.05) return null;
  return bullish > bearish ? "BUY" : "SELL";
}
