import assert from "node:assert/strict";
import test from "node:test";
import { createUser, createUserSession, getUserSession, hydrateUsers, listUsers, revokeUserSession, setUserPersistence } from "../server/users.mjs";

test("hydrateUsers restores task assignments from persistence", () => {
  hydrateUsers(
    [{
      id: "user_restore_1",
      username: "operator",
      displayName: "观察员",
      passwordHash: "scrypt$salt$hash",
      status: "ACTIVE",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
    [
      { userId: "user_restore_1", taskId: "task_a" },
      { userId: "user_restore_1", taskId: "task_b" },
    ],
  );
  const [user] = listUsers();
  assert.equal(user.username, "operator");
  assert.deepEqual(user.assignedTaskIds.sort(), ["task_a", "task_b"]);
});

test("hydrateUsers does not drop users when assignment list is empty", () => {
  hydrateUsers(
    [{
      id: "user_restore_2",
      username: "keeper",
      displayName: "保留",
      passwordHash: "scrypt$salt$hash",
      status: "ACTIVE",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
    [],
  );
  const [user] = listUsers();
  assert.equal(user.username, "keeper");
  assert.deepEqual(user.assignedTaskIds, []);
});

test("logout rejects the token immediately while durable session revocation is pending", async (t) => {
  await createUser({ username: "revocation-user", password: "revocation-pass" });
  const session = await createUserSession("revocation-user", "revocation-pass");
  let finish;
  setUserPersistence({ deleteUserSession: () => new Promise((resolve) => { finish = resolve; }) });
  t.after(() => setUserPersistence(null));
  const logout = revokeUserSession(session.token);
  assert.equal(getUserSession(session.token), null);
  finish();
  assert.equal(await logout, true);
});
