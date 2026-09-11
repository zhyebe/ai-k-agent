import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupStaleChromiumProfileLocks } from "../server/browser.mjs";

function profileFixture(lockTarget, { socketExists = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-browser-lock-"));
  const profile = path.join(root, "profile");
  const socket = path.join(root, "SingletonSocketTarget");
  fs.mkdirSync(profile);
  fs.symlinkSync(lockTarget, path.join(profile, "SingletonLock"));
  fs.symlinkSync("cookie", path.join(profile, "SingletonCookie"));
  fs.symlinkSync(socket, path.join(profile, "SingletonSocket"));
  if (socketExists) fs.writeFileSync(socket, "");
  return { root, profile };
}

test("stale Chromium lock from a replaced container is removed", () => {
  const fixture = profileFixture("old-container-18");
  try {
    const removed = cleanupStaleChromiumProfileLocks(fixture.profile, {
      hostname: "new-container",
      isProcessRunning: () => false,
    });
    assert.equal(removed, true);
    for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      assert.equal(fs.existsSync(path.join(fixture.profile, name)), false);
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("live Chromium lock for this container is preserved", () => {
  const fixture = profileFixture("current-container-57");
  try {
    const removed = cleanupStaleChromiumProfileLocks(fixture.profile, {
      hostname: "current-container",
      isProcessRunning: (pid) => pid === 57,
    });
    assert.equal(removed, false);
    assert.equal(fs.lstatSync(path.join(fixture.profile, "SingletonLock")).isSymbolicLink(), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("unknown lock is preserved while its singleton socket exists", () => {
  const fixture = profileFixture("unexpected-lock-format", { socketExists: true });
  try {
    const removed = cleanupStaleChromiumProfileLocks(fixture.profile, {
      hostname: "current-container",
      isProcessRunning: () => false,
    });
    assert.equal(removed, false);
    assert.equal(fs.lstatSync(path.join(fixture.profile, "SingletonLock")).isSymbolicLink(), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
