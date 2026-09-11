const DEFAULT_PACKAGED_API_URL = "http://47.109.95.143";

function isLoopbackApiUrl(value) {
  try {
    const host = new URL(String(value || "")).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_PACKAGED_API_URL,
  isLoopbackApiUrl,
};
