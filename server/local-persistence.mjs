import fs from "node:fs/promises";
import path from "node:path";

const collections = ["tasks", "skills", "providers", "connectors", "credentials", "orders", "events", "users", "sessions", "assignments"];

// One local snapshot, serialized writes and atomic replacement. A failed write
// leaves both the last committed snapshot and the in-memory adapter unchanged.
export async function createLocalPersistence({ directory, compactTaskRuntime }) {
  if (!directory) throw new Error("LOCAL_DATA_DIR_REQUIRED");
  const file = path.join(path.resolve(directory), "workspace.json");
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let data = { schemaVersion: 1, ...Object.fromEntries(collections.map(key => [key, []])) };
  let exists = false;
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (parsed.schemaVersion !== 1 || collections.some(key => !Array.isArray(parsed[key]))) {
      throw new Error("LOCAL_DATA_FORMAT_INVALID");
    }
    data = parsed;
    exists = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`LOCAL_DATA_READ_FAILED: ${error.message}`);
  }
  let queue = Promise.resolve();
  let writeError = null;
  function change(update) {
    const operation = queue.then(async () => {
      const next = structuredClone(data);
      update(next);
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        const handle = await fs.open(temporary, "w", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(next)}\n`, "utf8");
          await handle.sync();
        } finally { await handle.close(); }
        await fs.rename(temporary, file);
        data = next;
        exists = true;
        writeError = null;
      } catch (error) {
        writeError = error;
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw new Error(`LOCAL_DATA_WRITE_FAILED: ${error.message}`);
      }
    });
    queue = operation.catch(() => {});
    return operation;
  }
  const upsert = (collection, value, key = "id", limit = 0) => {
    const record = structuredClone(value);
    return change(next => {
      next[collection] = [record, ...next[collection].filter(item => item[key] !== record[key])];
      if (limit) next[collection] = next[collection].slice(0, limit);
    });
  };
  const remove = (collection, value, key = "id") => change(next => { next[collection] = next[collection].filter(item => item[key] !== value); });
  const read = async key => { await queue; return structuredClone(data[key]); };
  return {
    mode: "file", get available() { return !writeError; }, detail: "本机文件存储",
    async health() { await queue; return { mode: "file", available: !writeError, detail: writeError ? `本机保存失败：${writeError.message}` : "本机文件存储" }; },
    async loadState() { await queue; return exists ? structuredClone(data) : null; },
    loadCredentials: () => read("credentials"),
    loadUsers: () => read("users"),
    loadUserSessions: () => read("sessions"),
    loadAssignments: () => read("assignments"),
    loadEvents: () => read("events"),
    saveTask(task) {
      const { providerId, ...saved } = task;
      return upsert("tasks", { ...saved, ...compactTaskRuntime(task) });
    },
    deleteTaskData({ taskId, ownerUserId }) {
      return change(next => {
        if (!next.tasks.some(task => task.id === taskId && task.ownerUserId === ownerUserId)) throw new Error("TASK_NOT_FOUND");
        next.tasks = next.tasks.filter(task => task.id !== taskId);
        next.assignments = next.assignments.filter(item => item.taskId !== taskId);
        next.orders = next.orders.filter(item => item.taskId !== taskId);
        next.events = next.events.filter(item => item.metadata?.taskId !== taskId);
      });
    },
    saveSkill: skill => upsert("skills", skill),
    deleteSkill: id => remove("skills", id),
    saveProvider: provider => upsert("providers", provider),
    deleteProvider: id => remove("providers", id),
    saveConnector: connector => upsert("connectors", connector, "connectorId"),
    deleteConnector: id => remove("connectors", id, "connectorId"),
    saveCredential: credential => upsert("credentials", credential),
    saveOrder: order => upsert("orders", order, "id", 200),
    recordAudit: event => upsert("events", event, "id", 200),
    // Large analysis/DOM payloads remain session-local, as in the existing adapters.
    async saveAnalysis() {}, async saveAgentRun() {}, async saveAgentOutput() {},
    saveUser: user => upsert("users", user),
    saveUserSession: session => upsert("sessions", session, "tokenHash"),
    deleteUserSession: token => remove("sessions", token, "tokenHash"),
    clearTaskAssignments: () => change(next => { next.assignments = []; }),
    saveAssignment: assignment => change(next => {
      if (!next.assignments.some(item => item.userId === assignment.userId && item.taskId === assignment.taskId)) next.assignments.push({ ...assignment });
    }),
    deleteAssignment: assignment => change(next => {
      next.assignments = next.assignments.filter(item => item.userId !== assignment.userId || item.taskId !== assignment.taskId);
    }),
    async close() { await queue; if (writeError) throw new Error(`LOCAL_DATA_WRITE_FAILED: ${writeError.message}`); },
  };
}
