const DEFAULT_REPO = "zhyebe/ai-k-agent";
const DEFAULT_CACHE_MS = 120_000;
const ASSET_NAME_PATTERN = /^Axiom-Agent-[0-9A-Za-z._-]+\.(dmg|exe|zip)$/i;

export function sanitizeUpdateAssetName(name) {
  const value = String(name || "").trim();
  return ASSET_NAME_PATTERN.test(value) ? value : "";
}

export function createUpdateFeed({
  fetchImpl = globalThis.fetch,
  repo = DEFAULT_REPO,
  cacheMs = DEFAULT_CACHE_MS,
  userAgent = "AxiomAgent-UpdateProxy",
} = {}) {
  let cache = null;

  async function latestRelease() {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < cacheMs) return cache.release;
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": userAgent,
      },
    });
    if (!response.ok) throw new Error(`UPDATE_FEED_UNAVAILABLE_${response.status}`);
    const payload = await response.json();
    const assets = (payload.assets || [])
      .map((asset) => ({
        name: sanitizeUpdateAssetName(asset.name),
        url: String(asset.browser_download_url || ""),
        size: Number(asset.size || 0) || 0,
      }))
      .filter((asset) => asset.name && asset.url);
    const release = {
      latestVersion: String(payload.tag_name || "").replace(/^v/i, ""),
      releaseUrl: String(payload.html_url || `https://github.com/${repo}/releases/latest`),
      assets,
    };
    if (!release.latestVersion) throw new Error("UPDATE_FEED_EMPTY");
    cache = { fetchedAt: now, release };
    return release;
  }

  async function findAsset(name) {
    const safeName = sanitizeUpdateAssetName(name);
    if (!safeName) return null;
    const release = await latestRelease();
    return release.assets.find((asset) => asset.name === safeName) || null;
  }

  return { latestRelease, findAsset };
}

export async function proxyUpdateAsset(asset, { fetchImpl = globalThis.fetch, userAgent = "AxiomAgent-UpdateProxy" } = {}) {
  if (!asset?.url || !asset?.name) throw new Error("UPDATE_ASSET_NOT_FOUND");
  const response = await fetchImpl(asset.url, {
    redirect: "follow",
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": userAgent,
    },
  });
  if (!response.ok) throw new Error(`UPDATE_UPSTREAM_FAILED_${response.status}`);
  return response;
}
