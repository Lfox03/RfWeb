// "Attendances" repository.
//
// Two deliberately separated notions :
//   - card_scans      : scan EVENTS (1 scan = 1 row, duplicates included) ;
//   - app_attendances : attendance STATE (1 row per session/student pair,
//                      guaranteed by UNIQUE(session_id, student_id)).
// recordScan() always journalizes the event and only sets the state on the first
// accepted scan : "first scan → presence recorded, second scan → duplicate",
// without ever corrupting the state nor losing the history.

import type { DatabaseHandle } from "../database";
import { isoNow, normalizeUid } from "../types";
import type { AttendanceRow, CardScanRow, ScanResult } from "../types";

export interface ScanInput {
    sessionId: number;
    studentId: number;
    uid?: string | number | null;
    cardId?: number | null;
    isValid?: boolean;
}

export interface ScanOutcome {
    scan: CardScanRow;
    attendance: AttendanceRow;
    duplicate: boolean;
}

// Scan journalized WITHOUT an attendance state (unknown card, retired card or
// student outside the session's groups) : only the card_scans event is written,
// the session must exist (NOT NULL FK).
export interface LoggedScanInput {
    sessionId: number;
    studentId?: number | null;
    cardId?: number | null;
    uid?: string | null;
    result: "unknown" | "expired" | "out_of_group";
}

export interface SessionAttendanceRow {
    attendance_id: number;
    student_id: number;
    first_name: string;
    last_name: string | null;
    group_name: string | null;
    card_uid: string | null;
    scanned_at: string;
    is_valid: number;
}

export interface SessionScanRow {
    scan_id: number;
    student_id: number | null;
    student_name: string | null;
    uid: string | null;
    result: ScanResult;
    scanned_at: string;
}

// Reporting row (Phase 7): one roster line of a session. status derives from
// the attendance STATE (app_attendances), never from scan events, so a
// duplicate scan can never add attendance; first_scan_at is the timestamp of
// the first accepted scan (the state row is only ever written once).
export interface AttendanceReportRow {
    student_id: number;
    first_name: string;
    last_name: string | null;
    student_number: string | null;
    group_name: string | null;
    status: "present" | "absent";
    first_scan_at: string | null;
}

export function createAttendanceRepository(db: DatabaseHandle) {
    return {
        recordScan(input: ScanInput): ScanOutcome {
            const uid = input.uid !== undefined && input.uid !== null ? normalizeUid(input.uid) : null;
            const scannedAt = isoNow();
            const isValid = input.isValid === false ? 0 : 1;

            return db.transaction(() => {
                // 1. Attendance state : first come first served sets the state, the
                //    others change nothing (ON CONFLICT DO NOTHING + changes()).
                const info = db
                    .prepare(
                        `INSERT INTO app_attendances (session_id, student_id, scanned_at, is_valid)
                         VALUES (?, ?, ?, ?)
                         ON CONFLICT (session_id, student_id) DO NOTHING`,
                    )
                    .run(input.sessionId, input.studentId, scannedAt, isValid);
                const duplicate = info.changes === 0;
                const result: ScanResult = duplicate ? "duplicate" : "accepted";

                // 2. The event is ALWAYS journalized (history).
                const cardId = input.cardId ?? null;
                const scanInfo = db
                    .prepare(
                        `INSERT INTO card_scans (session_id, student_id, card_id, uid, result, scanned_at)
                         VALUES (?, ?, ?, ?, ?, ?)`,
                    )
                    .run(input.sessionId, input.studentId, cardId, uid, result, scannedAt);

                return {
                    scan: db.prepare("SELECT * FROM card_scans WHERE id = ?").get(Number(scanInfo.lastInsertRowid)) as CardScanRow,
                    attendance: this.findState(input.sessionId, input.studentId)!,
                    duplicate,
                };
            })();
        },

        // Journalizes a scan without presence (unknown/retired card) : keeps the
        // raw card_scans history, without touching the app_attendances state.
        logScan(input: LoggedScanInput): CardScanRow {
            const uid = input.uid !== undefined && input.uid !== null ? normalizeUid(input.uid) : null;
            const info = db
                .prepare(
                    `INSERT INTO card_scans (session_id, student_id, card_id, uid, result, scanned_at)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                )
                .run(input.sessionId, input.studentId ?? null, input.cardId ?? null, uid, input.result, isoNow());
            return db.prepare("SELECT * FROM card_scans WHERE id = ?").get(Number(info.lastInsertRowid)) as CardScanRow;
        },

        // Presence entered manually (no card) : sets the app_attendances state
        // and journalizes the "manual" event (uid NULL) in the same
        // transaction. created = false if the state already existed
        // (the caller refuses the duplicate) — no write in that case.
        markPresentManually(sessionId: number, studentId: number): { attendance: AttendanceRow; created: boolean } {
            const scannedAt = isoNow();
            return db.transaction(() => {
                const info = db
                    .prepare(
                        `INSERT INTO app_attendances (session_id, student_id, scanned_at, is_valid)
                         VALUES (?, ?, ?, 1)
                         ON CONFLICT (session_id, student_id) DO NOTHING`,
                    )
                    .run(sessionId, studentId, scannedAt);
                const created = info.changes > 0;
                if (created) {
                    db.prepare(
                        `INSERT INTO card_scans (session_id, student_id, card_id, uid, result, scanned_at)
                         VALUES (?, ?, NULL, NULL, 'manual', ?)`,
                    ).run(sessionId, studentId, scannedAt);
                }
                return { attendance: this.findState(sessionId, studentId)!, created };
            })();
        },

        findState(sessionId: number, studentId: number): AttendanceRow | undefined {
            return db
                .prepare("SELECT * FROM app_attendances WHERE session_id = ? AND student_id = ?")
                .get(sessionId, studentId) as AttendanceRow | undefined;
        },

        // Attendance state of a session, joined students (modern equivalent of
        // attendanceQueries.getSessionReport()).
        getSessionAttendance(sessionId: number): SessionAttendanceRow[] {
            return db
                .prepare(
                    `SELECT
                        a.id          AS attendance_id,
                        s.id          AS student_id,
                        s.first_name  AS first_name,
                        s.last_name   AS last_name,
                        g.name        AS group_name,
                        c.uid         AS card_uid,
                        a.scanned_at  AS scanned_at,
                        a.is_valid    AS is_valid
                     FROM app_attendances a
                     JOIN app_students s ON s.id = a.student_id
                     LEFT JOIN groups g  ON g.id = s.group_id
                     LEFT JOIN cards c   ON c.student_id = s.id AND c.revoked_at IS NULL
                     WHERE a.session_id = ?
                     ORDER BY a.scanned_at ASC`,
                )
                .all(sessionId) as SessionAttendanceRow[];
        },

        // "Session report" view (Phase 7) : complete roster of the session's
        // groups (UNION of the students, absentees included) JOIN attendance
        // state, plus attendees off the list (session without a group, or
        // student from another group). Same semantics as the session page
        // roster, computed server-side.
        getSessionReport(sessionId: number, groupIds: number[]): AttendanceReportRow[] {
            if (groupIds.length === 0) {
                // No group attached → only recorded attendees can be listed.
                return db
                    .prepare(
                        `SELECT
                            s.id             AS student_id,
                            s.first_name     AS first_name,
                            s.last_name      AS last_name,
                            s.student_number AS student_number,
                            g.name           AS group_name,
                            'present'        AS status,
                            a.scanned_at     AS first_scan_at
                         FROM app_attendances a
                         JOIN app_students s ON s.id = a.student_id
                         LEFT JOIN groups g  ON g.id = s.group_id
                         WHERE a.session_id = ?
                         ORDER BY a.scanned_at ASC, s.last_name IS NULL, s.last_name, s.first_name`,
                    )
                    .all(sessionId) as AttendanceReportRow[];
            }
            const placeholders = groupIds.map(() => "?").join(", ");
            return db
                .prepare(
                    `SELECT
                        s.id             AS student_id,
                        s.first_name     AS first_name,
                        s.last_name      AS last_name,
                        s.student_number AS student_number,
                        g.name           AS group_name,
                        CASE WHEN a.id IS NULL THEN 'absent' ELSE 'present' END AS status,
                        a.scanned_at     AS first_scan_at
                     FROM app_students s
                     LEFT JOIN groups g ON g.id = s.group_id
                     LEFT JOIN app_attendances a ON a.student_id = s.id AND a.session_id = ?
                     WHERE s.group_id IN (${placeholders})
                     UNION ALL
                     SELECT
                        s.id, s.first_name, s.last_name, s.student_number, g.name, 'present', a.scanned_at
                     FROM app_attendances a
                     JOIN app_students s ON s.id = a.student_id
                     LEFT JOIN groups g  ON g.id = s.group_id
                     WHERE a.session_id = ? AND (s.group_id IS NULL OR s.group_id NOT IN (${placeholders}))
                     -- Compound SELECT: ORDER BY may only reference result
                     -- columns. 'present' > 'absent' lexicographically, so
                     -- status DESC lists attendees first (by scan time),
                     -- then absentees alphabetically.
                     ORDER BY status DESC, first_scan_at ASC, last_name ASC, first_name ASC`,
                )
                .all(sessionId, ...groupIds, sessionId, ...groupIds) as AttendanceReportRow[];
        },

        // "Session report" over the FROZEN roster (sessions whose roster was
        // captured at start) : one line per snapshotted participant — absent or
        // present — plus the attendees outside the snapshot (a manual presence
        // mark deliberately ignores the scope, so it can add someone the
        // roster never listed). Names come from the CURRENT student record
        // when it still exists, else from the snapshot (a deleted student is
        // exactly a roster row whose student_id the FK set back to NULL —
        // their attendance rows cascaded away, so they read as absent).
        // group_name is the snapshot value : renames never rewrite history.
        getSessionReportFromRoster(sessionId: number): AttendanceReportRow[] {
            return db
                .prepare(
                    `SELECT
                        r.student_id                                        AS student_id,
                        COALESCE(s.first_name, r.full_name)                 AS first_name,
                        CASE WHEN s.id IS NULL THEN NULL ELSE s.last_name END AS last_name,
                        s.student_number                                    AS student_number,
                        r.group_name                                        AS group_name,
                        CASE WHEN a.id IS NULL THEN 'absent' ELSE 'present' END AS status,
                        a.scanned_at                                        AS first_scan_at
                     FROM session_roster r
                     LEFT JOIN app_attendances a ON a.session_id = r.session_id AND a.student_id = r.student_id
                     LEFT JOIN app_students s    ON s.id = r.student_id
                     WHERE r.session_id = ?
                     UNION ALL
                     SELECT
                        s.id, s.first_name, s.last_name, s.student_number, g.name, 'present', a.scanned_at
                     FROM app_attendances a
                     JOIN app_students s ON s.id = a.student_id
                     LEFT JOIN groups g  ON g.id = s.group_id
                     WHERE a.session_id = ?
                       AND NOT EXISTS (SELECT 1 FROM session_roster r2
                                        WHERE r2.session_id = a.session_id AND r2.student_id = a.student_id)
                     -- Same presentation as getSessionReport : 'present' >
                     -- 'absent' lexicographically, so status DESC lists the
                     -- attendees first (by scan time), then the absentees
                     -- alphabetically.
                     ORDER BY status DESC, first_scan_at ASC, last_name ASC, first_name ASC`,
                )
                .all(sessionId, sessionId) as AttendanceReportRow[];
        },

        // Complete history of a session's scans (duplicates included).
        listScans(sessionId: number): SessionScanRow[] {
            return db
                .prepare(
                    `SELECT
                        sc.id          AS scan_id,
                        sc.student_id  AS student_id,
                        TRIM(s.first_name || COALESCE(' ' || s.last_name, '')) AS student_name,
                        sc.uid         AS uid,
                        sc.result      AS result,
                        sc.scanned_at  AS scanned_at
                     FROM card_scans sc
                     LEFT JOIN app_students s ON s.id = sc.student_id
                     WHERE sc.session_id = ?
                     ORDER BY sc.scanned_at ASC, sc.id ASC`,
                )
                .all(sessionId) as SessionScanRow[];
        },

        // Resets a session's presences (state) without erasing
        // the scan history.
        resetSession(sessionId: number): void {
            db.prepare("DELETE FROM app_attendances WHERE session_id = ?").run(sessionId);
        },
    };
}

export type AttendanceRepository = ReturnType<typeof createAttendanceRepository>;
