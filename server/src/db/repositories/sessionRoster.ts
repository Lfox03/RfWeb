// « Session roster » repository — the participant snapshot frozen when a
// session starts (session_roster, migration 008).
//
// WRITE ONCE, READ MANY : the schema guards (BEFORE UPDATE/DELETE triggers)
// refuse any explicit mutation after the capture — the only writes this
// repository ever performs are the initial capture and reads. full_name and
// group_name are denormalized snapshots so renames or student deletions
// never rewrite history (a deleted student keeps the row with
// student_id NULL, the FK SET NULL action bypassing the immutability
// guard by construction).
//
// WHEN to freeze and stamping app_sessions.roster_frozen_at are service
// decisions — capture() persists exactly the entries it is given, with the
// frozenAt instant it is given. resolveExpectedEntries() is the read-side
// derivation (a pure SQL set operation over the session's groups and
// inclusion/exclusion deltas) the service feeds to capture().

import type { DatabaseHandle } from "../database";
import type { IsoDateTime, SessionRosterRow } from "../types";

export interface RosterEntry {
    studentId: number;
    fullName: string;
    groupName?: string | null;
}

export function createSessionRosterRepository(db: DatabaseHandle) {
    return {
        // One transaction = one snapshot : all-or-nothing capture.
        capture(sessionId: number, frozenAt: IsoDateTime, entries: RosterEntry[]): number {
            return db.transaction(() => {
                const insert = db.prepare(
                    `INSERT INTO session_roster (session_id, student_id, full_name, group_name, frozen_at)
                     VALUES (?, ?, ?, ?, ?)`,
                );
                for (const entry of entries) {
                    insert.run(sessionId, entry.studentId, entry.fullName, entry.groupName ?? null, frozenAt);
                }
                return entries.length;
            })();
        },

        // Derivation of the EXPECTED participants of a session, for the
        // capture : UNION of the session_groups students and the explicit
        // inclusions (session_participants.included = 1), minus the explicit
        // exclusions (included = 0, which wins over group membership). One
        // row per student — a student in several of the session's groups
        // appears once (set semantics). A session without groups and without
        // inclusions resolves to NOBODY : the legacy "accept everyone" rule is
        // a scan gate, never a list of people to freeze. full_name /
        // group_name are the denormalized snapshot values.
        resolveExpectedEntries(sessionId: number): RosterEntry[] {
            const rows = db
                .prepare(
                    `SELECT
                        s.id   AS student_id,
                        TRIM(s.first_name || COALESCE(' ' || s.last_name, '')) AS full_name,
                        g.name AS group_name
                     FROM app_students s
                     LEFT JOIN groups g ON g.id = s.group_id
                     WHERE CASE
                               WHEN (SELECT sp.included FROM session_participants sp
                                      WHERE sp.session_id = @session AND sp.student_id = s.id) = 1 THEN 1
                               WHEN (SELECT sp.included FROM session_participants sp
                                      WHERE sp.session_id = @session AND sp.student_id = s.id) = 0 THEN 0
                               ELSE (SELECT COUNT(*) FROM session_groups sg
                                      WHERE sg.session_id = @session AND sg.group_id = s.group_id) > 0
                           END
                     ORDER BY full_name, s.id`,
                )
                .all({ session: sessionId }) as Array<{
                student_id: number;
                full_name: string;
                group_name: string | null;
            }>;
            return rows.map((row) => ({
                studentId: row.student_id,
                fullName: row.full_name,
                groupName: row.group_name,
            }));
        },

        listBySession(sessionId: number): SessionRosterRow[] {
            return db
                .prepare("SELECT * FROM session_roster WHERE session_id = ? ORDER BY full_name, id")
                .all(sessionId) as SessionRosterRow[];
        },

        countBySession(sessionId: number): number {
            return (db.prepare("SELECT COUNT(*) AS c FROM session_roster WHERE session_id = ?").get(sessionId) as {
                c: number;
            }).c;
        },
    };
}

export type SessionRosterRepository = ReturnType<typeof createSessionRosterRepository>;
