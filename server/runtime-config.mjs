import path from "node:path";
import dotenv from "dotenv";

// Desktop startup must never inherit a previous cloud/database .env file.
if (process.env.AXIOM_STANDALONE === "1") {
  if (!process.env.AXIOM_DATA_DIR || !process.env.AXIOM_LOCAL_TOKEN) throw new Error("LOCAL_RUNTIME_CONFIG_REQUIRED");
  process.env.HOST = "127.0.0.1";
  process.env.DB_MODE = "file";
  process.env.ALLOW_MEMORY_FALLBACK = "0";
  process.env.APP_SECRET = "";
  process.env.AXIOM_SECRET_FILE = path.join(process.env.AXIOM_DATA_DIR, ".axiom-secret");
  process.env.AXIOM_VAULT_FILE = path.join(process.env.AXIOM_DATA_DIR, "credentials.vault.json");
  process.env.AXIOM_REQUIRE_DESKTOP_AI = "1";
  process.env.AXIOM_REQUIRE_DESKTOP_BROWSER = "1";
} else {
  dotenv.config();
}
