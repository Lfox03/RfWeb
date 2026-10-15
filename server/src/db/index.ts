// Entry point of the new database layer.
// Importing this module opens ./attendance.db (or DB_PATH) and applies the
// migrations — so any later import of the legacy modules (db/queries.js via
// db/legacy.ts) finds the migrated schema and its compatibility views.

import { getCurrentDbPath, openDatabase } from "./database";
import type { DatabaseHandle } from "./database";
import { createAttendanceRepository } from "./repositories/attendances";
import { createAuthSessionRepository } from "./repositories/authSessions";
import { createCardRepository } from "./repositories/cards";
import { createGroupRepository } from "./repositories/groups";
import { createSessionRepository } from "./repositories/sessions";
import { createSessionParticipantRepository } from "./repositories/sessionParticipants";
import { createSessionRosterRepository } from "./repositories/sessionRoster";
import { createSessionSeriesRepository } from "./repositories/sessionSeries";
import { createStudentRepository } from "./repositories/students";
import { createUserRepository } from "./repositories/users";

// Single application database (the legacy db/database.js connection opens the
// same file in parallel, WAL mode).
//
// `let` (not `const`) on purpose: the admin database RESTORE closes the live
// connection, swaps the file on disk, then calls reopenDatabase() below.
// These exports are CommonJS live bindings — every consumer that references
// db / the repositories AT CALL TIME (which is what services do) transparently
// sees the reopened connection and freshly built repositories.
export let db = openDatabase();

export let userRepository = createUserRepository(db);
export let groupRepository = createGroupRepository(db);
export let studentRepository = createStudentRepository(db);
export let cardRepository = createCardRepository(db);
export let sessionRepository = createSessionRepository(db);
export let attendanceRepository = createAttendanceRepository(db);
export let authSessionRepository = createAuthSessionRepository(db);
export let sessionSeriesRepository = createSessionSeriesRepository(db);
export let sessionParticipantRepository = createSessionParticipantRepository(db);
export let sessionRosterRepository = createSessionRosterRepository(db);

// Close the current connection and reopen the same file (or `filePath`), then
// rebuild every repository on the new handle. The file swap itself is done by
// the caller (services/backupService) BETWEEN the close and this call — keep
// those two steps adjacent and synchronous.
export function reopenDatabase(filePath?: string): DatabaseHandle {
    try {
        db.close();
    } catch {
        /* already closed (restore closed it on purpose) */
    }
    db = openDatabase(filePath ?? getCurrentDbPath());
    userRepository = createUserRepository(db);
    groupRepository = createGroupRepository(db);
    studentRepository = createStudentRepository(db);
    cardRepository = createCardRepository(db);
    sessionRepository = createSessionRepository(db);
    attendanceRepository = createAttendanceRepository(db);
    authSessionRepository = createAuthSessionRepository(db);
    sessionSeriesRepository = createSessionSeriesRepository(db);
    sessionParticipantRepository = createSessionParticipantRepository(db);
    sessionRosterRepository = createSessionRosterRepository(db);
    return db;
}

export { openDatabase, getSchemaVersion, getCurrentDbPath, TARGET_SCHEMA_VERSION } from "./database";
export type { DatabaseHandle } from "./database";

export { createUserRepository } from "./repositories/users";
export { createGroupRepository } from "./repositories/groups";
export { createStudentRepository } from "./repositories/students";
export { createCardRepository } from "./repositories/cards";
export { createSessionRepository } from "./repositories/sessions";
export { createAttendanceRepository } from "./repositories/attendances";
export { createAuthSessionRepository } from "./repositories/authSessions";
export { createSessionSeriesRepository } from "./repositories/sessionSeries";
export { createSessionParticipantRepository } from "./repositories/sessionParticipants";
export { createSessionRosterRepository } from "./repositories/sessionRoster";

export type { UserRepository } from "./repositories/users";
export type { GroupRepository } from "./repositories/groups";
export type { StudentRepository } from "./repositories/students";
export type { CardRepository } from "./repositories/cards";
export type { SessionRepository } from "./repositories/sessions";
export type { AttendanceRepository } from "./repositories/attendances";
export type { AuthSessionRepository } from "./repositories/authSessions";
export type { SessionSeriesRepository } from "./repositories/sessionSeries";
export type { SessionParticipantRepository } from "./repositories/sessionParticipants";
export type { SessionRosterRepository } from "./repositories/sessionRoster";

export * from "./types";
