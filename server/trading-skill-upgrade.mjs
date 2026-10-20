import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chunkDocument } from "./rag.mjs";

const previousSkillId = "skill_04ef36d5-3002-40fd-b51f-3914867e29f1";
const previousContentHashes = new Map([
  ["v0.3.107", "cb0e4bd03d9dc445c9ac6a7fa7bd5172bdf483e5b73f9f4fc317111e3e4172c7"],
  ["v0.3.102", "f3cdcdb24b5d13a9add4917d370a5303d4c25d02f38d9aa9c85b944f6df67120"],
  ["v0.3.101", "e9d0e3680f8e7e71bc2c99907fb04fa04ee2aafc1c1dd08901d36702384f4f8f"],
  ["v0.3.99", "3eaac252d29592708ba16c7bee3a610d07f7e525cc590acbaea6e82d6f91cd7b"],
  ["v0.3.98", "da9c24a5c6bc36f9d547d1968b07dba3cbfceef21a67e5c8b2be0a767fba023b"],
  ["v0.3.76", "b445d8efad9f8abdef1d275103465c59bd40b2e622ffbd8e36f2d1d1955b6214"],
  ["v0.3.84", "9bbda8f1ff57d4f36284915d009dca42660ef6bfde2d2fc6fe7aca4b730ef053"],
  ["v0.3.85", "3cc0c177613869780ad1516090d9f10c49b8b8cadb98fc245460a58821ba9ca7"],
  ["v0.3.86", "e1d1c98e5a1c70a320eef9fc466fdcfac44125bc26d7a7e4a9bffd871074e6fa"],
  ["v0.3.87", "42b8a628920f659d83d180eebb90bdc15c3e8105643ee09cedac7bba68a639c9"],
  ["v0.3.88", "d9f86e86f92aff3a9d659ca69efa6306179ace714956cd08ab46fc21d6040ae6"],
  ["v0.3.90", "60e053411ea4859d68031ae53d862da8599066fa30ac389dfbf729bf4219aeab"],
]);

// Upgrade only the exact reviewed project experience, never users' later edits.
// The persistence adapter applies this with an atomic old-content/version check
// and reloads the database record before hydrating the runtime knowledge index.
export async function tradingSkillUpgrade(skill) {
  if (skill?.id !== previousSkillId || skill.status !== "APPROVED" || !previousContentHashes.has(skill.version)) return null;
  const hash = createHash("sha256").update(String(skill.content || "").trim()).digest("hex");
  if (hash !== previousContentHashes.get(skill.version)) return null;
  const content = (await readFile(new URL("../skills/dgkz-dgjj-entry-exit-analysis/SKILL.md", import.meta.url), "utf8")).trim();
  if (!content) throw new Error("BUNDLED_TRADING_SKILL_EMPTY");
  return {
    content,
    version: "v0.3.108",
    summary: content.slice(0, 120),
    chunks: process.env.AXIOM_REQUIRE_DESKTOP_BROWSER === "1" ? 0 : chunkDocument(content).length,
    updatedAt: new Date().toISOString(),
  };
}
