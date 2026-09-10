function emptyUpdateState(currentVersion = "dev") {
  return {
    status: "disabled",
    currentVersion,
    availableVersion: null,
    downloadedVersion: null,
    progress: 0,
    error: null,
  };
}

function hasDownloadedPackage(state) {
  return Boolean(state?.downloadedVersion) || state?.status === "downloaded" || state?.status === "installing";
}

function reduceUpdateState(current, patch = {}) {
  const previous = current || emptyUpdateState();
  const next = { ...previous, ...patch };
  const downloadedVersion = next.downloadedVersion || previous.downloadedVersion || null;
  const downloadInFlight = previous.status === "downloading" || previous.status === "available";

  if (downloadedVersion && !downloadInFlight && ["error", "not-available", "idle", "checking"].includes(next.status)) {
    next.status = "downloaded";
    next.downloadedVersion = downloadedVersion;
  }

  if (next.status === "downloaded" || next.status === "installing") {
    next.downloadedVersion = downloadedVersion || next.availableVersion || previous.downloadedVersion;
  }

  return next;
}

function updateIntent(state) {
  if (!state || ["disabled", "unsupported"].includes(state.status)) return "none";
  if (["checking", "downloading", "installing", "not-available"].includes(state.status)) return "wait";
  if (hasDownloadedPackage(state)) return "install";
  if (state.status === "available") return "download";
  return "check";
}

module.exports = {
  emptyUpdateState,
  hasDownloadedPackage,
  reduceUpdateState,
  updateIntent,
};
