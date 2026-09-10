import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { safeCloseSocket } = require("../electron/ai-runtime.cjs");

function createConnectingSocket() {
  const listeners = { error: [], open: [], message: [], close: [] };
  return {
    readyState: 0,
    on(event, fn) {
      (listeners[event] ||= []).push(fn);
    },
    removeAllListeners(event) {
      if (event) listeners[event] = [];
      else Object.keys(listeners).forEach((key) => { listeners[key] = []; });
    },
    close() {
      process.nextTick(() => {
        const error = new Error("WebSocket was closed before the connection was established");
        if (!listeners.error.length) {
          throw error;
        }
        for (const fn of listeners.error) fn(error);
      });
    },
    terminate() {
      this.close();
    },
  };
}

test("closing a connecting desktop AI socket does not throw later", async () => {
  const socket = createConnectingSocket();
  safeCloseSocket(socket);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(socket.readyState, 0);
});
