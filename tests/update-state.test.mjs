import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  emptyUpdateState,
  reduceUpdateState,
  shouldSkipUpdateCheck,
  supportsDesktopAutoUpdate,
  selectInstallerAsset,
  windowsInstallScript,
  compareVersions,
  updateIntent,
} = require("../electron/update-state.cjs");

test("downloaded update stays installable after a later error", () => {
  const downloaded = reduceUpdateState(emptyUpdateState("0.2.3"), {
    status: "downloaded",
    downloadedVersion: "0.2.4",
    progress: 100,
  });
  assert.equal(updateIntent(downloaded), "install");

  const afterError = reduceUpdateState(downloaded, { status: "error", error: "net::ERR_FAILED" });
  assert.equal(afterError.status, "downloaded");
  assert.equal(afterError.downloadedVersion, "0.2.4");
  assert.equal(afterError.error, "net::ERR_FAILED");
  assert.equal(updateIntent(afterError), "install");
});

test("Mac Squirrel pipe errors and Windows installer spawn errors keep the package installable", () => {
  for (const message of ["Cannot pipe update", "Cannot run installer: error code: UNKNOWN"]) {
    const installing = reduceUpdateState(emptyUpdateState("0.2.3"), {
      status: "installing",
      downloadedVersion: "0.2.4",
    });
    const afterError = reduceUpdateState(installing, { status: "error", error: message });
    assert.equal(afterError.status, "downloaded");
    assert.equal(updateIntent(afterError), "install");
  }
});

test("Windows installer is the setup exe, never the portable build", () => {
  const assets = [
    { name: "Axiom-Agent-0.2.6-x64-portable.exe", url: "https://example.com/portable.exe" },
    { name: "Axiom-Agent-0.2.6-x64-setup.exe", url: "https://example.com/setup.exe" },
  ];
  const selected = selectInstallerAsset(assets, { platform: "win32", arch: "x64" });
  assert.equal(selected.name, "Axiom-Agent-0.2.6-x64-setup.exe");
});

test("macOS installer is the dmg for the current architecture", () => {
  const assets = [
    { name: "Axiom-Agent-0.2.6-arm64.zip", url: "https://example.com/app.zip" },
    { name: "Axiom-Agent-0.2.6-x64.dmg", url: "https://example.com/x64.dmg" },
    { name: "Axiom-Agent-0.2.6-arm64.dmg", url: "https://example.com/arm64.dmg" },
  ];
  assert.equal(selectInstallerAsset(assets, { platform: "darwin", arch: "arm64" }).name, "Axiom-Agent-0.2.6-arm64.dmg");
  assert.equal(selectInstallerAsset(assets, { platform: "darwin", arch: "x64" }).name, "Axiom-Agent-0.2.6-x64.dmg");
});

test("Windows install script kills this process before starting setup", () => {
  const script = windowsInstallScript({
    pid: 4242,
    installerPath: "C:\\Users\\me\\Downloads\\Axiom Agent Updates\\Axiom-Agent-0.2.6-x64-setup.exe",
  });
  assert.match(script, /taskkill \/F \/PID 4242 \/T/);
  assert.match(script, /start "" "C:\\Users\\me\\Downloads\\Axiom Agent Updates\\Axiom-Agent-0.2.6-x64-setup.exe"/);
  assert.ok(script.indexOf("taskkill") < script.indexOf("start \"\""));
});

test("packaged Mac and Windows can update; Windows portable cannot", () => {
  assert.equal(supportsDesktopAutoUpdate({ isPackaged: true, platform: "darwin" }), true);
  assert.equal(supportsDesktopAutoUpdate({ isPackaged: true, platform: "win32" }), true);
  assert.equal(supportsDesktopAutoUpdate({ isPackaged: false, platform: "darwin" }), false);
  assert.equal(supportsDesktopAutoUpdate({ isPackaged: false, platform: "win32" }), false);
  assert.equal(supportsDesktopAutoUpdate({
    isPackaged: true,
    platform: "win32",
    env: { PORTABLE_EXECUTABLE_DIR: "C:\\Axiom Agent" },
  }), false);
  assert.equal(compareVersions("0.2.7", "0.2.6") > 0, true);
});

test("checking and not-available stay as check, not install", () => {
  const checking = reduceUpdateState(emptyUpdateState("0.2.4"), { status: "checking" });
  assert.equal(checking.status, "checking");
  assert.equal(updateIntent(checking), "wait");
  assert.equal(shouldSkipUpdateCheck(checking), false);

  const latest = reduceUpdateState(checking, { status: "not-available", availableVersion: null });
  assert.equal(latest.status, "not-available");
  assert.equal(latest.downloadedVersion, null);
  assert.equal(updateIntent(latest), "check");
  assert.equal(shouldSkipUpdateCheck(latest), false);
});

test("a later not-available result does not rewrite an already-downloaded package", () => {
  const downloaded = reduceUpdateState(emptyUpdateState("0.2.3"), {
    status: "downloaded",
    downloadedVersion: "0.2.4",
  });
  assert.equal(shouldSkipUpdateCheck(downloaded), true);

  const afterCheck = reduceUpdateState(downloaded, { status: "not-available", availableVersion: null });
  assert.equal(afterCheck.status, "not-available");
  assert.equal(afterCheck.downloadedVersion, "0.2.4");
  assert.equal(updateIntent(afterCheck), "check");
  assert.equal(shouldSkipUpdateCheck(afterCheck), false);
});

test("error without a package still retries the check on both update feeds", () => {
  for (const message of ["latest-mac.yml missing", "latest.yml missing"]) {
    const failed = reduceUpdateState(emptyUpdateState("0.2.3"), { status: "error", error: message });
    assert.equal(failed.status, "error");
    assert.equal(updateIntent(failed), "check");
    assert.equal(shouldSkipUpdateCheck(failed), false);
  }
});
