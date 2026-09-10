import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { emptyUpdateState, reduceUpdateState, updateIntent } = require("../electron/update-state.cjs");

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

test("installing does not fall back to retry-check when Squirrel emits error", () => {
  const installing = reduceUpdateState(emptyUpdateState("0.2.3"), {
    status: "installing",
    downloadedVersion: "0.2.4",
  });
  const afterError = reduceUpdateState(installing, { status: "error", error: "Cannot pipe update" });
  assert.equal(afterError.status, "downloaded");
  assert.equal(updateIntent(afterError), "install");
});

test("a later not-available check cannot hide a downloaded package", () => {
  const downloaded = reduceUpdateState(emptyUpdateState("0.2.3"), {
    status: "downloaded",
    downloadedVersion: "0.2.4",
  });
  const afterCheck = reduceUpdateState(downloaded, { status: "not-available", availableVersion: null });
  assert.equal(afterCheck.status, "downloaded");
  assert.equal(updateIntent(afterCheck), "install");
});

test("error without a package still retries the check", () => {
  const failed = reduceUpdateState(emptyUpdateState("0.2.3"), { status: "error", error: "latest-mac.yml missing" });
  assert.equal(failed.status, "error");
  assert.equal(updateIntent(failed), "check");
});
