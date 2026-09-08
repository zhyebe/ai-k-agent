import assert from "node:assert/strict";
import test from "node:test";
import { createAdminSession, getAdminSession, revokeAdminSession } from "../server/auth.mjs";

test("admin sessions require credentials and can be revoked", () => {
  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD || "local-admin";
  assert.equal(createAdminSession(username, "wrong-password"), null);
  const session = createAdminSession(username, password);
  assert.ok(session?.token);
  assert.equal(getAdminSession(session.token)?.username, username);
  assert.equal(revokeAdminSession(session.token), true);
  assert.equal(getAdminSession(session.token), null);
});
