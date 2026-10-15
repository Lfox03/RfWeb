// CLI: apply pending migrations on ./attendance.db (or DB_PATH).
// Usage: npm run db:migrate

import { getSchemaVersion, openDatabase, TARGET_SCHEMA_VERSION } from "../database";
import { runMigrations } from "../migrations";

const db = openDatabase();
const applied = runMigrations(db);
const version = getSchemaVersion(db);

console.log(
    applied.length > 0
        ? `[DB] Migrations applied: ${applied.join(", ")} — version ${version}/${TARGET_SCHEMA_VERSION}.`
        : `[DB] No pending migration (version ${version}/${TARGET_SCHEMA_VERSION}).`,
);

db.close();
