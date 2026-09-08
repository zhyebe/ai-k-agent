import readline from "node:readline";
import { callTool, toolDefinitions } from "../server/tools.mjs";

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function response(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

for await (const line of input) {
  if (!line.trim()) continue;
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (request.method === "notifications/initialized") continue;
  if (request.method === "initialize") {
    response(request.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "axiom-local-tools", version: "0.1.0" },
    });
    continue;
  }
  if (request.method === "tools/list") {
    response(request.id, { tools: toolDefinitions });
    continue;
  }
  if (request.method === "tools/call") {
    const result = await callTool(request.params?.name, request.params?.arguments || {});
    response(request.id, { content: [{ type: "text", text: JSON.stringify(result) }], isError: result.ok === false && !result.requiresApproval });
    continue;
  }
  response(request.id, { error: { code: -32601, message: "Method not found" } });
}
