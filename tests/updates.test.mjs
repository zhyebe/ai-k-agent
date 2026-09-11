import assert from "node:assert/strict";
import test from "node:test";
import { createUpdateFeed, proxyUpdateAsset, sanitizeUpdateAssetName, updateAssetUrls } from "../server/updates.mjs";

test("update asset names reject path traversal", () => {
  assert.equal(sanitizeUpdateAssetName("Axiom-Agent-0.2.9-arm64.dmg"), "Axiom-Agent-0.2.9-arm64.dmg");
  assert.equal(sanitizeUpdateAssetName("Axiom-Agent-0.2.9-x64-setup.exe"), "Axiom-Agent-0.2.9-x64-setup.exe");
  assert.equal(sanitizeUpdateAssetName("../secret.exe"), "");
  assert.equal(sanitizeUpdateAssetName("Axiom-Agent-0.2.9-arm64.dmg/../../etc/passwd"), "");
  assert.equal(sanitizeUpdateAssetName(""), "");
});

test("update feed caches GitHub latest and finds a named asset", async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.match(String(url), /\/releases\/latest$/);
    return {
      ok: true,
      json: async () => ({
        tag_name: "v0.2.9",
        html_url: "https://github.com/zhyebe/ai-k-agent/releases/tag/v0.2.9",
        assets: [
          { name: "Axiom-Agent-0.2.9-arm64.dmg", browser_download_url: "https://example.com/arm64.dmg", size: 12 },
          { name: "../escape.exe", browser_download_url: "https://example.com/escape.exe", size: 3 },
        ],
      }),
    };
  };
  const feed = createUpdateFeed({ fetchImpl, cacheMs: 60_000 });
  const first = await feed.latestRelease();
  const second = await feed.latestRelease();
  assert.equal(calls, 1);
  assert.equal(first.latestVersion, "0.2.9");
  assert.deepEqual(first.assets.map((asset) => asset.name), ["Axiom-Agent-0.2.9-arm64.dmg"]);
  assert.equal(second.latestVersion, first.latestVersion);
  assert.equal((await feed.findAsset("Axiom-Agent-0.2.9-arm64.dmg"))?.url, "https://example.com/arm64.dmg");
  assert.equal(await feed.findAsset("../escape.exe"), null);
});

test("installer proxy tries streaming mirrors before unreachable GitHub", async () => {
  const official = "https://github.com/zhyebe/ai-k-agent/releases/download/v0.3.0/Axiom-Agent-0.3.0-universal.dmg";
  const urls = updateAssetUrls(official, ["https://mirror-one.example/", "https://mirror-two.example"]);
  assert.deepEqual(urls, [
    `https://mirror-one.example/${official}`,
    `https://mirror-two.example/${official}`,
    official,
  ]);
  const calls = [];
  const response = await proxyUpdateAsset(
    { name: "Axiom-Agent-0.3.0-universal.dmg", url: official },
    {
      mirrors: ["https://mirror-one.example/", "https://mirror-two.example/"],
      fetchImpl: async (url) => {
        calls.push(String(url));
        if (calls.length === 1) return { ok: false, status: 502, body: { cancel: async () => {} } };
        return { ok: true, status: 200 };
      },
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, urls.slice(0, 2));
});
