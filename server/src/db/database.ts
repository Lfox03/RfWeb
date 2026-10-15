// SQLite database opening + migration application on first import.
//
// Location: ./attendance.db relative to the working directory (like the legacy
// one), overridable with the DB_PATH environment variable (absolute path
// recommended). Run the commands from the repository root.

import Database from "better-sqlite3";

import { logger } from "../core/logger";
import { runMigrations, TARGET_SCHEMA_VERSION, getSchemaVersion } from "./migrations";

const dbLog = logger.child({ component: "db" });

export type DatabaseHandle = Database.Database;

// Path of the most recently opened database (needed by the restore flow,
// which swaps the live file on disk then reopens the very same path).
let lastOpenedPath = "./attendance.db";

export function getCurrentDbPath(): string {
    return lastOpenedPath;
}

export function openDatabase(filePath?: string): DatabaseHandle {
    const dbPath = filePath ?? process.env.DB_PATH ?? "./attendance.db";
    lastOpenedPath = dbPath;
    const db: DatabaseHandle = new Database(dbPath);

    db.pragma("journal_mode = WAL"); // like db/database.js (legacy)
    db.pragma("foreign_keys = ON");  // FK enforcement per connection

    const applied = runMigrations(db);
    if (applied.length > 0) {
        dbLog.info("db.schema_upgraded", { version: getSchemaVersion(db), applied: applied.length, path: dbPath });
    } else {
        dbLog.info("db.schema_up_to_date", {
            version: getSchemaVersion(db),
            target: TARGET_SCHEMA_VERSION,
            path: dbPath,
        });
    }

    return db;
}

export { getSchemaVersion, TARGET_SCHEMA_VERSION } from "./migrations";
