// CLI: database verifications (fresh database + copy of the development
// database). Never writes to ./attendance.db.
// Usage: npm run db:verify

import path from "node:path";

import { runDatabaseVerification } from "../verify";

const devDb = path.resolve(process.env.DB_PATH ?? "./attendance.db");
runDatabaseVerification(devDb);
