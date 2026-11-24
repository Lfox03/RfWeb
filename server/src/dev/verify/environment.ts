// Test environment of `npm run api:verify` — imported FIRST by the entry
// (server/src/dev/verifyApi.ts), before any application module is loaded.
// Always works on a temporary SQLite database (never ./attendance.db), with
// a simulated offline reader and ephemeral ports.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rfweb-api-verify-"));
process.env.DB_PATH = path.join(tmpDir, "verify.db");
process.env.RFID_DISABLED = "1"; // simulated offline reader
process.env.HTTP_HOST = "127.0.0.1";
process.env.WS_PORT = "0"; // ephemeral port
// Backups (section 19) stay in the temp tree — never alongside the repo.
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
// Proxy trust ON for the suite: the rate-limit section simulates a second
// client with X-Forwarded-For (per-IP isolation). Defaults of the limiter
// themselves are asserted in section 17 (a .env override fails that check).
process.env.TRUST_PROXY = "1";
