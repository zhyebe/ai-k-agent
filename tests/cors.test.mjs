import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedCorsOrigin, parseCsv } from "../server/cors.mjs";

test("allows missing origin, Electron null, and local Vite", () => {
  assert.equal(isAllowedCorsOrigin(""), true);
  assert.equal(isAllowedCorsOrigin(undefined), true);
  assert.equal(isAllowedCorsOrigin("null"), true);
  assert.equal(isAllowedCorsOrigin("http://127.0.0.1:5173"), true);
});

test("allows public or internal host on any client port", () => {
  const options = { extraHosts: ["47.109.95.143", "172.19.62.79"] };
  assert.equal(isAllowedCorsOrigin("http://47.109.95.143", options), true);
  assert.equal(isAllowedCorsOrigin("http://47.109.95.143:8787", options), true);
  assert.equal(isAllowedCorsOrigin("http://47.109.95.143:8080", options), true);
  assert.equal(isAllowedCorsOrigin("http://172.19.62.79", options), true);
  assert.equal(isAllowedCorsOrigin("https://evil.example", options), false);
});

test("parseCsv trims empty entries", () => {
  assert.deepEqual(parseCsv(" http://a , ,http://b "), ["http://a", "http://b"]);
});
