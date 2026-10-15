// SQLite database migration system (better-sqlite3).
//
// Principles :
//   - the schema version number is stored in PRAGMA user_version ;
//   - migrations are numbered, deterministic and executed exactly once,
//     each one in a transaction ;
//   - no migration deletes data : the old legacy tables are renamed to
//     legacy_* (archiving preserved) ;
//   - a fresh database reaches the latest schema with no legacy data ;
//     an existing database is completed (row copy) without loss.
//
// Target schema (physical tables) :
//   users, groups, app_students, cards, app_sessions, session_groups,
//   app_attendances, card_scans, auth_sessions, session_series,
//   session_series_groups, session_series_participants, session_participants,
//   session_roster
//
// Since migration 002, a session carries MULTIPLE groups via the
// session_groups association table (one course can gather several classes).
// app_sessions.group_id is kept but is no longer read by the server :
// simply a historical column (mirror of the first group) for compatibility.
//
// Since migration 003, the "kiosk" role (kiosk terminal account, read-only)
// joins ('admin', 'teacher') in the users.role CHECK — rebuild of the
// users table (SQLite cannot modify a CHECK in place).
//
// Since migration 004, the scan result "out_of_group" (student
// scanned while belonging to none of the session's groups — presence
// not counted) joins ('accepted', 'duplicate', 'unknown', 'expired') in
// the card_scans.result CHECK — rebuild of the card_scans table.
//
// Since migration 005, the "manual" result (presence entered
// manually by a teacher during a session — no card, uid
// NULL) joins the card_scans.result CHECK list — rebuild of
// the card_scans table.
//
// Since migration 006, authentication sessions are persistent in the
// auth_sessions table (one row per active session, keyed by the SHA-256
// hash of the opaque token — the raw token is never stored), so logins
// survive a server restart.
//
// Since migration 007, app_sessions carries created_by (the user who
// created the session, FK users ON DELETE SET NULL — sessions of a
// deleted user stay readable, creator displayed as unknown).
//
// Since migration 008, sessions can belong to a RECURRING SERIES :
// session_series (the recurrence template : label, daily|weekly pattern
// + weekday, local start time + IANA timezone, duration, inclusive local
// date range, active|paused|cancelled) with session_series_groups (group
// scope) and session_series_participants (individual inclusion/exclusion
// deltas). app_sessions gains the occurrence columns : series_id (FK
// ON DELETE SET NULL — deleting a series never destroys the already
// generated occurrences, they become standalone history), occurrence_date
// (local calendar date identifying the occurrence within its series —
// UNIQUE(series_id, occurrence_date) is the generation idempotency key),
// local_time + timezone (preserved local scheduling; timezone NOT NULL
// DEFAULT 'UTC' : truthful for every pre-existing row because all stored
// timestamps are UTC) and roster_frozen_at (when the attendance roster
// was snapshotted at start). session_participants holds per-occurrence
// inclusion/exclusion deltas ; session_roster is the IMMUTABLE participant
// snapshot captured when a session starts (denormalized names survive
// student renames/deletions ; BEFORE UPDATE/DELETE guards refuse any
// explicit mutation while still letting the FK actions run — SQLite fires
// row triggers for FK CASCADE/SET NULL, so the WHEN clauses exempt exactly
// those two shapes). Entirely additive : every pre-existing session stays
// standalone (series_id, occurrence_date, local_time NULL ;
// roster_frozen_at NULL ; timezone 'UTC').
//
// Since migration 009, session_groups and session_participants carry an
// `inherited` flag : 1 = the row is a copy of the series' scope written by
// generation (a series edit « this and following » may rewrite it), 0 = an
// explicit per-occurrence row (manual write, or any row created before this
// migration — the conservative default). Series membership edits therefore
// propagate to future scheduled occurrences WITHOUT ever silently rewriting
// an explicit override.
//
// Why the app_ prefix on students/sessions/attendances :
//   the legacy code (db/queries.js, unmodified) hardcodes the table names
//   students / sessions / attendances. After migration, these names become
//   compatibility VIEWS (with INSTEAD OF triggers) layered on top of the new
//   tables, which lets the RFID scanLoop keep working without a rewrite. The
//   real tables are therefore app_students / app_sessions / app_attendances ;
//   they will be renamed without the prefix in Phase 3, when the legacy is removed.

import type Database from "better-sqlite3";

import { logger } from "../core/logger";

const migrationsLog = logger.child({ component: "db" });

type DatabaseHandle = Database.Database;

export const TARGET_SCHEMA_VERSION = 9;

export interface Migration {
    version: number;
    name: string;
    up: (db: DatabaseHandle) => void;
}

// Current timestamp in ISO-8601 UTC format, in SQLite (same rendering as
// new Date().toISOString() on the JS side).
const NOW_ISO = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

// Converts a legacy timestamp ('YYYY-MM-DD HH:MM:SS' UTC from datetime('now'))
// or an already-conform ISO one into ISO-8601 UTC with milliseconds.
function toIso(column: string): string {
    return `strftime('%Y-%m-%dT%H:%M:%fZ', ${column})`;
}

function toIsoOrNow(column: string): string {
    return `COALESCE(${toIso(column)}, ${NOW_ISO})`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Target schema
// ═══════════════════════════════════════════════════════════════════════════════

const SCHEMA_SQL = `
-- Application users (schema only : authentication comes
-- in Phase 3). password_hash remains a placeholder until hashing is
-- implemented ; the NOT NULL constraint requires writing a value there.
CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'teacher'
                            CHECK (role IN ('admin', 'teacher', 'kiosk')),
    created_at    TEXT    NOT NULL DEFAULT (${NOW_ISO}),
    updated_at    TEXT    NOT NULL DEFAULT (${NOW_ISO})
);

-- Student groups (class, program…).
CREATE TABLE groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL UNIQUE,
    created_at TEXT    NOT NULL DEFAULT (${NOW_ISO}),
    updated_at TEXT    NOT NULL DEFAULT (${NOW_ISO})
);

-- Students (physical table ; the name "students" is the compatibility view).
CREATE TABLE app_students (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name     TEXT    NOT NULL,
    last_name      TEXT,
    student_number TEXT    UNIQUE,
    group_id       INTEGER REFERENCES groups(id) ON DELETE SET NULL,
    email          TEXT,
    created_at     TEXT    NOT NULL DEFAULT (${NOW_ISO}),
    updated_at     TEXT    NOT NULL DEFAULT (${NOW_ISO})
);

-- RFID cards, entities distinct from students.
-- uid : DECIMAL string as produced by the reader (decID), never hex.
-- student_id NULL = unassigned card ; revoked_at NOT NULL = retired card
-- (replacement) — history is kept, assignment may change.
CREATE TABLE cards (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    uid        TEXT    NOT NULL UNIQUE,
    student_id INTEGER REFERENCES app_students(id) ON DELETE SET NULL,
    revoked_at TEXT,
    created_at TEXT    NOT NULL DEFAULT (${NOW_ISO}),
    updated_at TEXT    NOT NULL DEFAULT (${NOW_ISO})
);

-- Only one ACTIVE card per student (retired cards do not count).
CREATE UNIQUE INDEX ux_cards_active_student
    ON cards(student_id)
    WHERE student_id IS NOT NULL AND revoked_at IS NULL;

-- Attendance sessions. scheduled = programmed, running = in progress (RFID active),
-- completed = finished, cancelled = cancelled.
-- group_id : historical column (mirror of the first group) — the real
-- scope of a session is session_groups (migration 002).
CREATE TABLE app_sessions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    label            TEXT    NOT NULL,
    group_id         INTEGER REFERENCES groups(id) ON DELETE SET NULL,
    scheduled_at     TEXT    NOT NULL,
    started_at       TEXT,
    ended_at         TEXT,
    duration_minutes INTEGER NOT NULL DEFAULT 10,
    status           TEXT    NOT NULL DEFAULT 'scheduled'
                             CHECK (status IN ('scheduled', 'running', 'completed', 'cancelled')),
    created_at       TEXT    NOT NULL DEFAULT (${NOW_ISO}),
    updated_at       TEXT    NOT NULL DEFAULT (${NOW_ISO}),
    CHECK (started_at IS NULL OR ended_at IS NULL OR ended_at >= started_at)
);

-- Attendance state : one row per (session, student). This is the derived STATE,
-- not the scan history.
CREATE TABLE app_attendances (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES app_sessions(id)     ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES app_students(id)     ON DELETE CASCADE,
    scanned_at TEXT    NOT NULL,
    is_valid   INTEGER NOT NULL DEFAULT 1,
    UNIQUE (session_id, student_id)
);

-- Scan events : ONE scan = ONE row, duplicates included. This is the raw
-- history ; "first scan → present" vs "second scan → duplicate" is read here.
CREATE TABLE card_scans (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
    student_id INTEGER REFERENCES app_students(id) ON DELETE SET NULL,
    card_id    INTEGER REFERENCES cards(id)        ON DELETE SET NULL,
    uid        TEXT,
    result     TEXT    NOT NULL
                       CHECK (result IN ('accepted', 'duplicate', 'unknown', 'expired', 'out_of_group', 'manual')),
    scanned_at TEXT    NOT NULL
);

-- Useful indexes right away (other common queries are served by
-- the uniqueness indexes : cards.uid, app_attendances(session_id, student_id)).
CREATE INDEX idx_app_students_group    ON app_students(group_id);
CREATE INDEX idx_cards_student         ON cards(student_id);
CREATE INDEX idx_app_sessions_group    ON app_sessions(group_id);
CREATE INDEX idx_app_sessions_status   ON app_sessions(status);
CREATE INDEX idx_app_attendances_student ON app_attendances(student_id);
CREATE INDEX idx_card_scans_session    ON card_scans(session_id);
CREATE INDEX idx_card_scans_student    ON card_scans(student_id);
`;

// ═══════════════════════════════════════════════════════════════════════════════
// Legacy compatibility views + triggers INSTEAD OF
//
// db/queries.js (hence rfid/scanLoop.js and web/socket.js) will keep writing
// "students", "sessions", "attendances" in hard with their old columns
// and their old statuses (pending/active/closed). These views mask the new
// schema without touching the legacy code ; the triggers propagate the writes
// to the app_* tables. The data goes through the REAL CONSTRAINTS of the
// new schema (ex. UNIQUE(session_id, student_id) raises the error
// SQLITE_CONSTRAINT_UNIQUE on which the scanLoop's duplicate detection relies).
// ═══════════════════════════════════════════════════════════════════════════════

// Insert trigger of the "attendances" view : the only schema object that
// WRITES into card_scans on the legacy side. Shared with migration 004 (which must
// suspend it then recreate it identically around the reconstruction of
// card_scans — a RENAME cannot leave a suspended reference).
const ATTENDANCES_LEGACY_INSERT_TRIGGER_SQL = `
CREATE TRIGGER attendances_legacy_insert INSTEAD OF INSERT ON attendances
BEGIN
    -- 1. The scan event is journalized (raw history).
    INSERT INTO card_scans (session_id, student_id, card_id, uid, result, scanned_at)
    VALUES (
        NEW.session_id,
        NEW.student_id,
        (SELECT c.id  FROM cards c WHERE c.student_id = NEW.student_id AND c.revoked_at IS NULL),
        (SELECT c.uid FROM cards c WHERE c.student_id = NEW.student_id AND c.revoked_at IS NULL),
        'accepted',
        COALESCE(NEW.scanned_at, ${NOW_ISO})
    );

    -- 2. The attendance state is set ; the second scan of the same student fails
    --    on UNIQUE(session_id, student_id) → SQLITE_CONSTRAINT_UNIQUE bubbles up
    --    to db/queries.js (record() → null → scan:duplicate event).
    --    The failure also cancels the card_scans row above (atomic statement).
    INSERT INTO app_attendances (session_id, student_id, scanned_at, is_valid)
    VALUES (NEW.session_id, NEW.student_id, COALESCE(NEW.scanned_at, ${NOW_ISO}), COALESCE(NEW.is_valid, 1));
END;
`;

const LEGACY_VIEWS_SQL = `
CREATE VIEW students AS
SELECT
    s.id,
    TRIM(s.first_name || COALESCE(' ' || s.last_name, '')) AS name,
    (SELECT c.uid FROM cards c
      WHERE c.student_id = s.id AND c.revoked_at IS NULL)   AS card_uid,
    (SELECT g.name FROM groups g WHERE g.id = s.group_id)   AS group_name,
    s.email,
    s.created_at
FROM app_students s;

CREATE TRIGGER students_legacy_insert INSTEAD OF INSERT ON students
BEGIN
    -- UID already carried by an active card of another student → explicit refusal.
    SELECT RAISE(ABORT, 'legacy: carte RFID déjà assignée à un autre étudiant')
    WHERE NEW.card_uid IS NOT NULL
      AND EXISTS (SELECT 1 FROM cards
                   WHERE uid = NEW.card_uid
                     AND student_id IS NOT NULL
                     AND revoked_at IS NULL);

    -- The group is created on the fly if it is unknown (legacy behavior).
    INSERT INTO groups (name)
    SELECT NEW.group_name
    WHERE NEW.group_name IS NOT NULL
      AND TRIM(NEW.group_name) <> ''
      AND NOT EXISTS (SELECT 1 FROM groups WHERE name = NEW.group_name);

    -- The legacy full name is stored as-is in first_name (the legacy
    -- has only one field ; no ambiguous split of "Jean-Pierre Dupont").
    INSERT INTO app_students (first_name, group_id, email, created_at, updated_at)
    VALUES (
        NEW.name,
        (SELECT id FROM groups WHERE name = NEW.group_name),
        NEW.email,
        ${NOW_ISO},
        ${NOW_ISO}
    );

    -- Reassign an existing free card (unassigned or retired)…
    UPDATE cards
    SET student_id = last_insert_rowid(),
        revoked_at = NULL,
        updated_at = ${NOW_ISO}
    WHERE uid = NEW.card_uid
      AND (student_id IS NULL OR revoked_at IS NOT NULL);

    -- …otherwise create the card (the UNIQUE on uid raises SQLITE_CONSTRAINT_UNIQUE).
    INSERT INTO cards (uid, student_id, created_at, updated_at)
    SELECT NEW.card_uid, last_insert_rowid(), ${NOW_ISO}, ${NOW_ISO}
    WHERE NEW.card_uid IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM cards WHERE uid = NEW.card_uid);
END;

CREATE TRIGGER students_legacy_update INSTEAD OF UPDATE ON students
BEGIN
    SELECT RAISE(ABORT, 'legacy: carte RFID déjà assignée à un autre étudiant')
    WHERE NEW.card_uid IS NOT NULL
      AND (OLD.card_uid IS NULL OR OLD.card_uid <> NEW.card_uid)
      AND EXISTS (SELECT 1 FROM cards
                   WHERE uid = NEW.card_uid
                     AND student_id IS NOT NULL
                     AND student_id <> OLD.id
                     AND revoked_at IS NULL);

    INSERT INTO groups (name)
    SELECT NEW.group_name
    WHERE NEW.group_name IS NOT NULL
      AND TRIM(NEW.group_name) <> ''
      AND NOT EXISTS (SELECT 1 FROM groups WHERE name = NEW.group_name);

    UPDATE app_students
    SET first_name = NEW.name,
        group_id   = (SELECT id FROM groups WHERE name = NEW.group_name),
        email      = NEW.email,
        updated_at = ${NOW_ISO}
    WHERE id = OLD.id;

    -- UID change : the old active card is retired (history),
    -- the new one is reassigned (free/retired) or created.
    UPDATE cards
    SET revoked_at = ${NOW_ISO},
        updated_at = ${NOW_ISO}
    WHERE student_id = OLD.id
      AND revoked_at IS NULL
      AND NEW.card_uid IS NOT NULL
      AND (OLD.card_uid IS NULL OR OLD.card_uid <> NEW.card_uid);

    UPDATE cards
    SET revoked_at = ${NOW_ISO},
        student_id = NULL,
        updated_at = ${NOW_ISO}
    WHERE student_id = OLD.id
      AND revoked_at IS NULL
      AND NEW.card_uid IS NULL;

    UPDATE cards
    SET student_id = NEW.id,
        revoked_at = NULL,
        updated_at = ${NOW_ISO}
    WHERE uid = NEW.card_uid
      AND (student_id IS NULL OR revoked_at IS NOT NULL)
      AND (OLD.card_uid IS NULL OR OLD.card_uid <> NEW.card_uid);

    INSERT INTO cards (uid, student_id, created_at, updated_at)
    SELECT NEW.card_uid, NEW.id, ${NOW_ISO}, ${NOW_ISO}
    WHERE NEW.card_uid IS NOT NULL
      AND (OLD.card_uid IS NULL OR OLD.card_uid <> NEW.card_uid)
      AND NOT EXISTS (SELECT 1 FROM cards WHERE uid = NEW.card_uid);
END;

CREATE TRIGGER students_legacy_delete INSTEAD OF DELETE ON students
BEGIN
    DELETE FROM app_students WHERE id = OLD.id;
END;

CREATE VIEW sessions AS
SELECT
    id,
    label,
    scheduled_at,
    duration_minutes,
    CASE status WHEN 'running'   THEN 'active'
                WHEN 'scheduled' THEN 'pending'
                WHEN 'completed' THEN 'closed'
                WHEN 'cancelled' THEN 'closed'
    END AS status,
    CASE WHEN status = 'running' THEN 1 ELSE 0 END AS rfid_enabled,
    created_at
FROM app_sessions;

CREATE TRIGGER sessions_legacy_insert INSTEAD OF INSERT ON sessions
BEGIN
    INSERT INTO app_sessions (label, scheduled_at, started_at, duration_minutes, status, created_at, updated_at)
    VALUES (
        NEW.label,
        NEW.scheduled_at,
        CASE WHEN COALESCE(NEW.status, 'pending') = 'active' THEN ${NOW_ISO} END,
        COALESCE(NEW.duration_minutes, 10),
        CASE COALESCE(NEW.status, 'pending')
             WHEN 'active'  THEN 'running'
             WHEN 'closed'  THEN 'completed'
             ELSE 'scheduled'
        END,
        ${NOW_ISO},
        ${NOW_ISO}
    );
END;

CREATE TRIGGER sessions_legacy_update INSTEAD OF UPDATE ON sessions
BEGIN
    UPDATE app_sessions
    SET label            = NEW.label,
        scheduled_at     = NEW.scheduled_at,
        duration_minutes = NEW.duration_minutes,
        status           = CASE NEW.status
                               WHEN 'active'  THEN 'running'
                               WHEN 'pending' THEN 'scheduled'
                               WHEN 'closed'  THEN 'completed'
                               ELSE status
                           END,
        started_at       = CASE
                               WHEN NEW.status = 'active' AND OLD.status <> 'active'
                                   THEN ${NOW_ISO}
                               ELSE started_at
                           END,
        ended_at         = CASE
                               WHEN NEW.status = 'active' THEN NULL
                               WHEN OLD.status = 'active' THEN ${NOW_ISO}
                               ELSE ended_at
                           END,
        updated_at       = ${NOW_ISO}
    WHERE id = OLD.id;
END;

CREATE TRIGGER sessions_legacy_delete INSTEAD OF DELETE ON sessions
BEGIN
    DELETE FROM app_sessions WHERE id = OLD.id;
END;

CREATE VIEW attendances AS
SELECT id, session_id, student_id, scanned_at, is_valid
FROM app_attendances;

${ATTENDANCES_LEGACY_INSERT_TRIGGER_SQL}

CREATE TRIGGER attendances_legacy_delete INSTEAD OF DELETE ON attendances
BEGIN
    -- sessionQueries.reset() : the attendance STATE is erased, not the history.
    DELETE FROM app_attendances WHERE id = OLD.id;
END;
`;

// ═══════════════════════════════════════════════════════════════════════════════
// Migration 001 — normalized schema + legacy data takeover
// ═══════════════════════════════════════════════════════════════════════════════

function tableExists(db: DatabaseHandle, name: string): boolean {
    return db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name) !== undefined;
}

function columnNames(db: DatabaseHandle, table: string): string[] {
    return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

// The legacy is detected by the presence of the THREE historical tables with
// the students.card_uid signature. A partial state is blocking (real data :
// refusing to guess).
function detectLegacySchema(db: DatabaseHandle): boolean {
    const names = ["students", "sessions", "attendances"];
    const present = names.filter((n) => tableExists(db, n));
    if (present.length === 0) return false;
    if (present.length !== names.length) {
        throw new Error(
            `État de base ambigu : tables legacy partielles (${present.join(", ")}). ` +
            "Migration refusée pour ne perdre aucune donnée.",
        );
    }
    if (!columnNames(db, "students").includes("card_uid")) {
        throw new Error(
            "État de base ambigu : la table students existe sans la colonne card_uid " +
            "(schéma inconnu). Migration refusée.",
        );
    }
    return true;
}

const MIGRATION_001 = (db: DatabaseHandle): void => {
    const hasLegacy = detectLegacySchema(db);

    if (hasLegacy) {
        // Archiving by renaming : no data deleted, the legacy_*
        // tables remain readable as a fallback.
        db.exec("ALTER TABLE students   RENAME TO legacy_students;");
        db.exec("ALTER TABLE sessions   RENAME TO legacy_sessions;");
        db.exec("ALTER TABLE attendances RENAME TO legacy_attendances;");
    }

    db.exec(SCHEMA_SQL);

    if (hasLegacy) {
        copyLegacyData(db);
    }

    db.exec(LEGACY_VIEWS_SQL);
};

// Inherited IDs are kept identical (FK consistency) ;
// sqlite_sequence is realigned automatically by the INSERTs with explicit ids.
function copyLegacyData(db: DatabaseHandle): void {
    const count = (table: string): number =>
        (db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number }).c;

    const before = {
        students: count("legacy_students"),
        sessions: count("legacy_sessions"),
        attendances: count("legacy_attendances"),
    };

    db.exec(`
-- Distinct groups from students.group_name (whitespace normalized).
INSERT INTO groups (name)
SELECT TRIM(ls.group_name)
FROM legacy_students ls
WHERE ls.group_name IS NOT NULL AND TRIM(ls.group_name) <> ''
GROUP BY TRIM(ls.group_name);

INSERT INTO app_students (id, first_name, last_name, student_number, group_id, email, created_at, updated_at)
SELECT
    ls.id,
    TRIM(ls.name),
    NULL,
    NULL,
    (SELECT g.id FROM groups g WHERE g.name = TRIM(ls.group_name)),
    ls.email,
    ${toIsoOrNow("ls.created_at")},
    ${toIsoOrNow("ls.created_at")}
FROM legacy_students ls;

-- One card per student (card_uid NOT NULL UNIQUE in the old schema).
INSERT INTO cards (id, uid, student_id, revoked_at, created_at, updated_at)
SELECT
    ls.id,
    TRIM(ls.card_uid),
    ls.id,
    NULL,
    ${toIsoOrNow("ls.created_at")},
    ${toIsoOrNow("ls.created_at")}
FROM legacy_students ls
WHERE ls.card_uid IS NOT NULL;

-- Legacy status mapping : pending→scheduled, active→running, closed→completed.
-- started_at estimated = scheduled_at for sessions still 'active' (the old
-- schema did not store the real start time) ; ended_at stays NULL for
-- closed sessions (not recorded on the legacy side — nothing invented).
INSERT INTO app_sessions (id, label, group_id, scheduled_at, started_at, ended_at, duration_minutes, status, created_at, updated_at)
SELECT
    ls.id,
    ls.label,
    NULL,
    ${toIsoOrNow("ls.scheduled_at")},
    CASE WHEN ls.status = 'active' THEN ${toIsoOrNow("ls.scheduled_at")} END,
    NULL,
    ls.duration_minutes,
    CASE ls.status
         WHEN 'active' THEN 'running'
         WHEN 'closed' THEN 'completed'
         ELSE 'scheduled'
    END,
    ${toIsoOrNow("ls.created_at")},
    ${toIsoOrNow("ls.created_at")}
FROM legacy_sessions ls;

INSERT INTO app_attendances (id, session_id, student_id, scanned_at, is_valid)
SELECT
    a.id,
    a.session_id,
    a.student_id,
    ${toIsoOrNow("a.scanned_at")},
    a.is_valid
FROM legacy_attendances a;

-- Scan history reconstruction : one 'accepted' event per legacy
-- attendance (legacy duplicates were not journalized — nothing invented).
INSERT INTO card_scans (id, session_id, student_id, card_id, uid, result, scanned_at)
SELECT
    a.id,
    a.session_id,
    a.student_id,
    (SELECT c.id FROM cards c WHERE c.student_id = a.student_id AND c.revoked_at IS NULL),
    (SELECT TRIM(ls.card_uid) FROM legacy_students ls WHERE ls.id = a.student_id),
    'accepted',
    ${toIsoOrNow("a.scanned_at")}
FROM legacy_attendances a;
`);

    // Row count check : refuse to validate an incomplete copy.
    const after = {
        students: count("app_students"),
        sessions: count("app_sessions"),
        attendances: count("app_attendances"),
        cards: count("cards"),
        scans: count("card_scans"),
    };
    if (
        after.students !== before.students ||
        after.sessions !== before.sessions ||
        after.attendances !== before.attendances ||
        after.scans !== before.attendances
    ) {
        throw new Error(
            `Migration 001 interrompue : comptages incohérents ` +
            `(legacy ${JSON.stringify(before)} → nouveau ${JSON.stringify(after)}).`,
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Migration 002 — a session can carry MULTIPLE groups
//
// New session_groups association table, source of truth for a
// session's scope. The backfill takes over the old unique column app_sessions
// .group_id (one membership per existing session). The column stays
// in place (mirror of the first group, not read by the server) : no data
// deleted, the legacy compatibility view does not expose group_id anyway.
// ═══════════════════════════════════════════════════════════════════════════════

const MIGRATION_002 = (db: DatabaseHandle): void => {
    db.exec(`
CREATE TABLE session_groups (
    session_id INTEGER NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
    group_id   INTEGER NOT NULL REFERENCES groups(id)       ON DELETE CASCADE,
    created_at TEXT    NOT NULL DEFAULT (${NOW_ISO}),
    PRIMARY KEY (session_id, group_id)
);

CREATE INDEX idx_session_groups_group ON session_groups(group_id);

-- Takeover of the unique historical group (no session lost).
INSERT INTO session_groups (session_id, group_id, created_at)
SELECT s.id, s.group_id, s.created_at
FROM app_sessions s
WHERE s.group_id IS NOT NULL;
`);
};

// ═══════════════════════════════════════════════════════════════════════════════
// Migration 003 — "kiosk" role (kiosk terminal account, read-only)
//
// SQLite cannot modify a CHECK in place : classic 4-step rebuild
// (create like → copy → drop → rename). No row lost, no ID
// changed. No view nor FK references the users table, so the rebuild is
// safe even with foreign_keys=ON.
// ═══════════════════════════════════════════════════════════════════════════════

const MIGRATION_003 = (db: DatabaseHandle): void => {
    db.exec(`
CREATE TABLE users_new (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'teacher'
                            CHECK (role IN ('admin', 'teacher', 'kiosk')),
    created_at    TEXT    NOT NULL DEFAULT (${NOW_ISO}),
    updated_at    TEXT    NOT NULL DEFAULT (${NOW_ISO})
);

INSERT INTO users_new (id, username, password_hash, role, created_at, updated_at)
SELECT id, username, password_hash, role, created_at, updated_at FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
`);
};

// ═══════════════════════════════════════════════════════════════════════════════
// Migration 004 — scan result "out_of_group"
//
// A student scanned while belonging to none of the active session's
// groups is no longer counted present : the scan is journalized "out_of_group"
// (warning on the kiosk/dashboard side). Same mechanics as migration
// 003 (SQLite cannot modify a CHECK in place) : the card_scans table
// is rebuilt, all rows and all IDs kept. No table references card_scans
// (no incoming FK). Only the compatibility view's trigger
// writes there : since ALTER TABLE RENAME refuses to leave a suspended
// reference in a trigger, it is dropped before the
// reconstruction and recreated identically (same SQL as the compatibility
// view) once the new table is in place. The two indexes are
// recreated identically.
// ═══════════════════════════════════════════════════════════════════════════════

const MIGRATION_004 = (db: DatabaseHandle): void => {
    const before = (db.prepare("SELECT COUNT(*) AS c FROM card_scans").get() as { c: number }).c;

    db.exec("DROP TRIGGER IF EXISTS attendances_legacy_insert;");

    db.exec(`
CREATE TABLE card_scans_new (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
    student_id INTEGER REFERENCES app_students(id) ON DELETE SET NULL,
    card_id    INTEGER REFERENCES cards(id)        ON DELETE SET NULL,
    uid        TEXT,
    result     TEXT    NOT NULL
                       CHECK (result IN ('accepted', 'duplicate', 'unknown', 'expired', 'out_of_group')),
    scanned_at TEXT    NOT NULL
);

INSERT INTO card_scans_new (id, session_id, student_id, card_id, uid, result, scanned_at)
SELECT id, session_id, student_id, card_id, uid, result, scanned_at FROM card_scans;

DROP TABLE card_scans;
ALTER TABLE card_scans_new RENAME TO card_scans;

CREATE INDEX idx_card_scans_session    ON card_scans(session_id);
CREATE INDEX idx_card_scans_student    ON card_scans(student_id);
`);

    db.exec(ATTENDANCES_LEGACY_INSERT_TRIGGER_SQL);

    // Row count check : no row lost.
    const after = (db.prepare("SELECT COUNT(*) AS c FROM card_scans").get() as { c: number }).c;
    if (after !== before) {
        throw new Error(
            `Migration 004 interrompue : comptages incohérents (card_scans ${before} → ${after}).`,
        );
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// Migration 005 — scan result "manual"
//
// A presence can now be entered manually by a teacher during
// a session (student without a card or broken kiosk) : the event
// is journalized in card_scans with the "manual" result (uid NULL, no
// card). Same mechanics as migrations 003/004 (SQLite cannot
// modify a CHECK in place) : rebuild of card_scans, all
// rows and all IDs kept, compatibility trigger dropped then
// recreated identically, indexes recreated.
// ═══════════════════════════════════════════════════════════════════════════════

const MIGRATION_005 = (db: DatabaseHandle): void => {
    const before = (db.prepare("SELECT COUNT(*) AS c FROM card_scans").get() as { c: number }).c;

    db.exec("DROP TRIGGER IF EXISTS attendances_legacy_insert;");

    db.exec(`
CREATE TABLE card_scans_new (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
    student_id INTEGER REFERENCES app_students(id) ON DELETE SET NULL,
    card_id    INTEGER REFERENCES cards(id)        ON DELETE SET NULL,
    uid        TEXT,
    result     TEXT    NOT NULL
                       CHECK (result IN ('accepted', 'duplicate', 'unknown', 'expired', 'out_of_group', 'manual')),
    scanned_at TEXT    NOT NULL
);

INSERT INTO card_scans_new (id, session_id, student_id, card_id, uid, result, scanned_at)
SELECT id, session_id, student_id, card_id, uid, result, scanned_at FROM card_scans;

DROP TABLE card_scans;
ALTER TABLE card_scans_new RENAME TO card_scans;

CREATE INDEX idx_card_scans_session    ON card_scans(session_id);
CREATE INDEX idx_card_scans_student    ON card_scans(student_id);
`);

    db.exec(ATTENDANCES_LEGACY_INSERT_TRIGGER_SQL);

    // Row count check : no row lost.
    const after = (db.prepare("SELECT COUNT(*) AS c FROM card_scans").get() as { c: number }).c;
    if (after !== before) {
        throw new Error(
            `Migration 005 interrompue : comptages incohérents (card_scans ${before} → ${after}).`,
        );
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// Migration 006 — persistent authentication sessions
//
// Server-side sessions leave the process memory (Map lost at every restart)
// for a dedicated table : one row per active session, keyed by the SHA-256
// hash of the opaque cookie token (the raw token is NEVER stored, so a stolen
// or backed-up database leaks nothing usable). created_at / expires_at /
// last_seen_at drive the TTL (SESSION_TTL_HOURS) and activity tracking.
// Purely additive — no existing table touched.
// ═══════════════════════════════════════════════════════════════════════════════

const MIGRATION_006 = (db: DatabaseHandle): void => {
    db.exec(`
CREATE TABLE auth_sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash   TEXT    NOT NULL UNIQUE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   TEXT    NOT NULL DEFAULT (${NOW_ISO}),
    expires_at   TEXT    NOT NULL,
    last_seen_at TEXT    NOT NULL DEFAULT (${NOW_ISO})
);

CREATE INDEX idx_auth_sessions_user    ON auth_sessions(user_id);
CREATE INDEX idx_auth_sessions_expires ON auth_sessions(expires_at);
`);
};

// ═══════════════════════════════════════════════════════════════════════════════
// Migration 007 — session creator
//
// Each session records WHO created it (app_sessions.created_by, FK users
// ON DELETE SET NULL : deleting a user never deletes their sessions and the
// creator simply becomes unknown). Purely additive ALTER TABLE — no rebuild,
// no row touched. Sessions created before this migration (or by the
// service layer without an authenticated user) have created_by NULL.
// ═══════════════════════════════════════════════════════════════════════════════

const MIGRATION_007 = (db: DatabaseHandle): void => {
    db.exec(`
ALTER TABLE app_sessions
    ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
`);
};

// ═══════════════════════════════════════════════════════════════════════════════
// Migration 008 — recurring session series (schema only)
//
// Session planning becomes a template/occurrence model :
//
//   session_series              — the recurrence template (label, daily|weekly
//                                 pattern + weekday for weekly, local start
//                                 time + IANA timezone, duration, inclusive
//                                 local date range, status). Generation itself
//                                 is a LATER phase : this migration only puts
//                                 the schema in place.
//   session_series_groups       — the group scope of a series (same shape as
//                                 session_groups for one session).
//   session_series_participants — individual inclusion (included=1 : joins the
//                                 series without being in one of its groups) /
//                                 exclusion (included=0 : leaves the series
//                                 despite being in a group) deltas.
//   session_participants        — the same deltas, scoped to ONE occurrence.
//   session_roster              — the participant snapshot FROZEN when a
//                                 session starts (denormalized full_name /
//                                 group_name so renames and deletions never
//                                 rewrite history). Immutable by construction :
//                                 BEFORE UPDATE/DELETE guards refuse any
//                                 explicit write. SQLite DOES fire row
//                                 triggers for FK actions, hence the WHEN
//                                 clauses carve out exactly the two FK shapes
//                                 (SET NULL student_id when a snapshotted
//                                 student is deleted ; CASCADE rows when the
//                                 session itself is deleted).
//
// app_sessions gains the occurrence columns (all via ADD COLUMN — purely
// additive, no rebuild, every existing row keeps its values) :
//   series_id         FK session_series ON DELETE SET NULL — deleting the
//                     template never destroys generated attendance history.
//   occurrence_date   local calendar date of the occurrence inside its series ;
//                     the partial UNIQUE index on (series_id, occurrence_date)
//                     is the identity of an occurrence (idempotency key for
//                     future generation). NULL, like series_id, on standalone
//                     sessions.
//   local_time        'HH:MM' wall-clock start in the timezone below — the
//                     UTC scheduled_at stays the authoritative instant.
//   timezone          NOT NULL DEFAULT 'UTC' — truthful for every pre-existing
//                     row (all stored timestamps are UTC instants).
//   roster_frozen_at  set once when the roster snapshot is captured (NULL =
//                     no snapshot yet).
//
// Compatibility : existing sessions remain standalone (series_id NULL) and
// the sessions compatibility view/triggers are untouched (explicit column
// lists — the new columns are simply invisible to the legacy side).
// ═══════════════════════════════════════════════════════════════════════════════

const MIGRATION_008 = (db: DatabaseHandle): void => {
    const before = (db.prepare("SELECT COUNT(*) AS c FROM app_sessions").get() as { c: number }).c;

    db.exec(`
-- ─── Templates de récurrence ──────────────────────────────────────────────────

-- weekday : 0 = dimanche … 6 = samedi (convention JS Date.getDay),
-- obligatoire pour un patron hebdomadaire, NULL pour 'daily'.
CREATE TABLE session_series (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    label            TEXT    NOT NULL,
    recurrence       TEXT    NOT NULL DEFAULT 'weekly'
                                CHECK (recurrence IN ('daily', 'weekly')),
    weekday          INTEGER         CHECK (weekday BETWEEN 0 AND 6),
    local_time       TEXT    NOT NULL
                                CHECK (local_time GLOB '[01][0-9]:[0-5][0-9]'
                                    OR local_time GLOB '2[0-3]:[0-5][0-9]'),
    timezone         TEXT    NOT NULL DEFAULT 'UTC'
                                CHECK (length(timezone) BETWEEN 1 AND 64),
    duration_minutes INTEGER NOT NULL DEFAULT 10
                                CHECK (duration_minutes > 0),
    starts_on        TEXT    NOT NULL
                                CHECK (starts_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                                    AND date(starts_on) IS NOT NULL),
    ends_on          TEXT
                                CHECK (ends_on IS NULL
                                    OR (ends_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                                        AND date(ends_on) IS NOT NULL)),
    status           TEXT    NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'paused', 'cancelled')),
    created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at       TEXT    NOT NULL DEFAULT (${NOW_ISO}),
    updated_at       TEXT    NOT NULL DEFAULT (${NOW_ISO}),
    CHECK (ends_on IS NULL OR ends_on >= starts_on),
    CHECK (recurrence <> 'weekly' OR weekday IS NOT NULL)
);

-- Portée de groupes d'une série (miroir de session_groups, même forme).
CREATE TABLE session_series_groups (
    series_id  INTEGER NOT NULL REFERENCES session_series(id) ON DELETE CASCADE,
    group_id   INTEGER NOT NULL REFERENCES groups(id)         ON DELETE CASCADE,
    created_at TEXT    NOT NULL DEFAULT (${NOW_ISO}),
    PRIMARY KEY (series_id, group_id)
);

CREATE INDEX idx_session_series_groups_group ON session_series_groups(group_id);

-- Deltas individuels au niveau du modèle (included = 1 inclusion,
-- 0 exclusion — la logique d'application reste du ressort des services).
CREATE TABLE session_series_participants (
    series_id  INTEGER NOT NULL REFERENCES session_series(id)  ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES app_students(id)    ON DELETE CASCADE,
    included   INTEGER NOT NULL CHECK (included IN (0, 1)),
    created_at TEXT    NOT NULL DEFAULT (${NOW_ISO}),
    updated_at TEXT    NOT NULL DEFAULT (${NOW_ISO}),
    PRIMARY KEY (series_id, student_id)
);

CREATE INDEX idx_session_series_participants_student ON session_series_participants(student_id);

-- ─── Colonnes d'occurrence de app_sessions (additif, aucune ligne touchée) ────

ALTER TABLE app_sessions
    ADD COLUMN series_id INTEGER REFERENCES session_series(id) ON DELETE SET NULL;

ALTER TABLE app_sessions
    ADD COLUMN occurrence_date TEXT
        CHECK (occurrence_date IS NULL
            OR (occurrence_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                AND date(occurrence_date) IS NOT NULL));

ALTER TABLE app_sessions
    ADD COLUMN local_time TEXT
        CHECK (local_time IS NULL
            OR (local_time GLOB '[01][0-9]:[0-5][0-9]'
                OR local_time GLOB '2[0-3]:[0-5][0-9]'));

ALTER TABLE app_sessions
    ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'
        CHECK (length(timezone) BETWEEN 1 AND 64);

ALTER TABLE app_sessions
    ADD COLUMN roster_frozen_at TEXT;

CREATE INDEX idx_app_sessions_series ON app_sessions(series_id);

-- Identité d'une occurrence : une seule occurrence par série ET date locale ;
-- les sessions autonomes (series_id NULL) sont hors index, comme avant.
CREATE UNIQUE INDEX ux_app_sessions_series_occurrence
    ON app_sessions(series_id, occurrence_date)
    WHERE series_id IS NOT NULL;

-- ─── Deltas de participation par occurrence ───────────────────────────────────

CREATE TABLE session_participants (
    session_id INTEGER NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES app_students(id) ON DELETE CASCADE,
    included   INTEGER NOT NULL CHECK (included IN (0, 1)),
    created_at TEXT    NOT NULL DEFAULT (${NOW_ISO}),
    updated_at TEXT    NOT NULL DEFAULT (${NOW_ISO}),
    PRIMARY KEY (session_id, student_id)
);

CREATE INDEX idx_session_participants_student ON session_participants(student_id);

-- ─── Instantané de roster figé au démarrage (historique immuable) ─────────────

-- student_id ON DELETE SET NULL : la suppression d'un étudiant n'efface pas
-- l'historique — les noms sont dénormalisés dans la ligne.
CREATE TABLE session_roster (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES app_sessions(id)      ON DELETE CASCADE,
    student_id INTEGER           REFERENCES app_students(id)     ON DELETE SET NULL,
    full_name  TEXT    NOT NULL,
    group_name TEXT,
    frozen_at  TEXT    NOT NULL DEFAULT (${NOW_ISO}),
    UNIQUE (session_id, student_id)
);

CREATE INDEX idx_session_roster_student ON session_roster(student_id);

-- Garanti immuable : aucune écriture explicite n'est admise après la capture.
-- Les actions de clés étrangères (CASCADE/SET NULL) déclenchent les triggers
-- ligne par ligne en SQLite — le WHEN n'exempte QUE la forme exacte produite
-- par SET NULL (student_id mis à NULL alors que l'étudiant référencé n'existe
-- plus, tous les autres colonnes inchangées).
CREATE TRIGGER session_roster_immutable_update BEFORE UPDATE ON session_roster
WHEN NOT (
       NEW.id          =  OLD.id
   AND NEW.session_id  =  OLD.session_id
   AND NEW.full_name   =  OLD.full_name
   AND NEW.group_name IS OLD.group_name
   AND NEW.frozen_at   =  OLD.frozen_at
   AND NEW.student_id IS NULL
   AND OLD.student_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM app_students s WHERE s.id = OLD.student_id)
)
BEGIN
    SELECT RAISE(ABORT, 'session_roster : instantané de participation immuable');
END;

-- Même principe côté suppression : seule la CASCADE d'app_sessions est
-- exemptée (le parent est déjà supprimé quand le trigger enfant s'exécute).
CREATE TRIGGER session_roster_immutable_delete BEFORE DELETE ON session_roster
WHEN EXISTS (SELECT 1 FROM app_sessions s WHERE s.id = OLD.session_id)
BEGIN
    SELECT RAISE(ABORT, 'session_roster : instantané de participation immuable');
END;
`);

    // Row count check : additive migration, no session lost or invented.
    const after = (db.prepare("SELECT COUNT(*) AS c FROM app_sessions").get() as { c: number }).c;
    if (after !== before) {
        throw new Error(
            `Migration 008 interrompue : comptages incohérents (app_sessions ${before} → ${after}).`,
        );
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// Migration 009 — inherited vs explicit membership (Phase 5)
//
// A generated occurrence carries COPIES of its series' group scope
// (session_groups) and individual deltas (session_participants). Until now
// those copies were physically indistinguishable from explicit per-occurrence
// overrides, so editing a series could not propagate its membership without
// risking to silently rewrite an override. One additive column removes the
// ambiguity :
//   inherited = 1 → the row is a copy of the series scope (generation wrote
//                  it) : a series edit « this and following » may rewrite it;
//   inherited = 0 → explicit per-occurrence row (manual, or created before
//                  this migration) : NEVER rewritten by a series edit.
// Existing rows default to 0 (explicit) : the conservative side — a series
// edit never rewrites memberships that pre-date the provenance tracking.
// Purely additive ALTER TABLE — no rebuild, no row touched.
// ═══════════════════════════════════════════════════════════════════════════════

const MIGRATION_009 = (db: DatabaseHandle): void => {
    const before = {
        sessionGroups: (db.prepare("SELECT COUNT(*) AS c FROM session_groups").get() as { c: number }).c,
        sessionParticipants: (db.prepare("SELECT COUNT(*) AS c FROM session_participants").get() as { c: number }).c,
    };

    db.exec(`
ALTER TABLE session_groups
    ADD COLUMN inherited INTEGER NOT NULL DEFAULT 0 CHECK (inherited IN (0, 1));

ALTER TABLE session_participants
    ADD COLUMN inherited INTEGER NOT NULL DEFAULT 0 CHECK (inherited IN (0, 1));
`);

    // Row count check : additive migration, nothing lost nor invented, and
    // every pre-existing row is explicitly-typed (inherited = 0).
    const after = {
        sessionGroups: (db.prepare("SELECT COUNT(*) AS c FROM session_groups").get() as { c: number }).c,
        sessionParticipants: (db.prepare("SELECT COUNT(*) AS c FROM session_participants").get() as { c: number }).c,
        inherited: (
            db
                .prepare(
                    `SELECT (SELECT COUNT(*) FROM session_groups WHERE inherited <> 0)
                            + (SELECT COUNT(*) FROM session_participants WHERE inherited <> 0) AS c`,
                )
                .get() as { c: number }
        ).c,
    };
    if (after.sessionGroups !== before.sessionGroups || after.sessionParticipants !== before.sessionParticipants) {
        throw new Error(
            `Migration 009 interrompue : comptages incohérents (${JSON.stringify(before)} → ${JSON.stringify(after)}).`,
        );
    }
    if (after.inherited !== 0) {
        throw new Error("Migration 009 interrompue : des lignes reprises portent inherited ≠ 0.");
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// Execution
// ═══════════════════════════════════════════════════════════════════════════════

export const MIGRATIONS: Migration[] = [
    { version: 1, name: "initial_schema", up: MIGRATION_001 },
    { version: 2, name: "session_groups", up: MIGRATION_002 },
    { version: 3, name: "users_role_kiosk", up: MIGRATION_003 },
    { version: 4, name: "scan_result_out_of_group", up: MIGRATION_004 },
    { version: 5, name: "scan_result_manual", up: MIGRATION_005 },
    { version: 6, name: "auth_sessions", up: MIGRATION_006 },
    { version: 7, name: "session_created_by", up: MIGRATION_007 },
    { version: 8, name: "recurring_session_series", up: MIGRATION_008 },
    { version: 9, name: "membership_inherited_flag", up: MIGRATION_009 },
];

export function getSchemaVersion(db: DatabaseHandle): number {
    return db.pragma("user_version", { simple: true }) as number;
}

// Apply pending migrations, in order, one per transaction.
// Returns the list of applied versions (empty if already up to date).
export function runMigrations(db: DatabaseHandle): number[] {
    const current = getSchemaVersion(db);
    const applied: number[] = [];

    for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
        if (migration.version <= current) continue;
        if (migration.version > TARGET_SCHEMA_VERSION) {
            throw new Error(`Migration ${migration.version} supérieure à TARGET_SCHEMA_VERSION.`);
        }
        db.transaction(() => {
            migration.up(db);
            db.pragma(`user_version = ${migration.version}`);
        })();
        applied.push(migration.version);
        migrationsLog.info("db.migration_applied", { version: migration.version, name: migration.name });
    }

    if (applied.length > 0 && getSchemaVersion(db) !== TARGET_SCHEMA_VERSION) {
        throw new Error(
            `Version de schéma ${getSchemaVersion(db)} inférieure à la cible ${TARGET_SCHEMA_VERSION}.`,
        );
    }
    return applied;
}
