import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chunkDocument } from "./rag.mjs";

const previousSkillId = "skill_04ef36d5-3002-40fd-b51f-3914867e29f1";
const previousContentHash = "b445d8efad9f8abdef1d275103465c59bd40b2e622ffbd8e36f2d1d1955b6214";

// Upgrade only the exact reviewed project experience, never users' later edits.
// The persistence adapter applies this with an atomic old-content/version check
// and reloads the database record before hydrating the runtime knowledge index.
export async function tradingSkillUpgrade(skill) {
  if (skill?.id !== previousSkillId || skill.status !== "APPROVED" || skill.version !== "v0.3.76") return null;
  const hash = createHash("sha256").update(String(skill.content || "").trim()).digest("hex");
  if (hash !== previousContentHash) return null;
  const content = (await readFile(new URL("../skills/dgkz-dgjj-entry-exit-analysis/SKILL.md", import.meta.url), "utf8")).trim();
  if (!content) throw new Error("BUNDLED_TRADING_SKILL_EMPTY");
  return {
    content,
    version: "v0.3.84",
    summary: content.slice(0, 120),
    chunks: process.env.AXIOM_REQUIRE_DESKTOP_BROWSER === "1" ? 0 : chunkDocument(content).length,
    updatedAt: new Date().toISOString(),
  };
}
