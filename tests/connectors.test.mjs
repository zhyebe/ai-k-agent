import assert from "node:assert/strict";
import test from "node:test";
import { adapterCanExecute, discoverConnector, getConnectorAdapter, listConnectorAdapters } from "../server/connectors.mjs";

test("discovers approved demo website adapter", () => {
  const profile = discoverConnector({ type: "website", url: "https://demo.exchange.local", name: "Demo" });
  assert.equal(profile.adapterId, "northstar-web");
  assert.equal(profile.reviewStatus, "APPROVED");
  assert.deepEqual(profile.executionModes, ["PAPER", "SHADOW"]);
  assert.equal(adapterCanExecute(profile.adapterId, "PAPER"), true);
  assert.equal(adapterCanExecute(profile.adapterId, "LIVE"), false);
});

test("keeps unknown targets behind adapter review", () => {
  const website = discoverConnector({ type: "website", url: "https://example.com" });
  const app = discoverConnector({ type: "app", installPath: "/tmp/unknown-app" });
  assert.equal(website.reviewStatus, "REVIEW_REQUIRED");
  assert.equal(app.reviewStatus, "REVIEW_REQUIRED");
  assert.equal(adapterCanExecute(website.adapterId, "PAPER"), false);
  assert.equal(getConnectorAdapter("generic-desktop")?.reviewStatus, "REVIEW_REQUIRED");
  assert.equal(listConnectorAdapters().length >= 3, true);
});

test("rejects non-http website targets", () => {
  assert.throws(() => discoverConnector({ type: "website", url: "javascript:alert(1)" }), /UNSUPPORTED_PROTOCOL/);
});
