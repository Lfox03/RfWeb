// « Session participants » repository — individual inclusion/exclusion
// deltas scoped to ONE session occurrence (session_participants,
// migration 008 ; inherited flag since migration 009).
//
// Same semantics as the series-level deltas : included = 1 forces a student
// into this occurrence's roster, included = 0 removes them from it. Merging
// these deltas with the group-derived roster is service logic — this layer
// only persists the rows.
//
// Provenance (migration 009) : inherited = 1 marks a copy of the SERIES'
// delta written by generation — a series edit « this and following » may
// rewrite those rows. inherited = 0 marks an explicit per-occurrence row
// (manual upsert, or any row predating migration 009) — never rewritten by
// a series edit. upsert() therefore writes explicit rows by DEFAULT ; only
// the generation service passes inherited = true.

import type { DatabaseHandle } from "../database";
import { isoNow } from "../types";
import type { SessionParticipantRow } from "../types";

export interface ParticipantDelta {
    studentId: number;
    included: boolean;
}

export function createSessionParticipantRepository(db: DatabaseHandle) {
    return {
        listBySession(sessionId: number): SessionParticipantRow[] {
            return db
                .prepare("SELECT * FROM session_participants WHERE session_id = ? ORDER BY student_id")
                .all(sessionId) as SessionParticipantRow[];
        },

        // One explicit (inherited = 0) or inherited (inherited = 1) delta.
        // Overriding an inherited row with an explicit upsert flips the row
        // to explicit : the per-occurrence decision then survives any later
        // series edit.
        upsert(sessionId: number, studentId: number, included: boolean, inherited = false): void {
            const now = isoNow();
            db.prepare(
                `INSERT INTO session_participants (session_id, student_id, included, inherited, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (session_id, student_id)
                 DO UPDATE SET included = excluded.included,
                               inherited = excluded.inherited,
                               updated_at = excluded.updated_at`,
            ).run(sessionId, studentId, included ? 1 : 0, inherited ? 1 : 0, now, now);
        },

        remove(sessionId: number, studentId: number): boolean {
            return (
                db
                    .prepare("DELETE FROM session_participants WHERE session_id = ? AND student_id = ?")
                    .run(sessionId, studentId).changes > 0
            );
        },

        // Replaces the INHERITED copy of the series' deltas carried by an
        // occurrence (series edited « this and following »). Explicit rows
        // (inherited = 0) always win : they are never deleted and an
        // explicit row for a student prevents the inherited copy of the same
        // student from being (re)inserted.
        syncInherited(sessionId: number, deltas: ParticipantDelta[]): void {
            db.transaction(() => {
                const now = isoNow();
                db.prepare("DELETE FROM session_participants WHERE session_id = ? AND inherited = 1").run(sessionId);
                const insert = db.prepare(
                    `INSERT INTO session_participants (session_id, student_id, included, inherited, created_at, updated_at)
                     SELECT ?, ?, ?, 1, ?, ?
                      WHERE NOT EXISTS (
                          SELECT 1 FROM session_participants sp
                           WHERE sp.session_id = ? AND sp.student_id = ? AND sp.inherited = 0
                      )`,
                );
                for (const delta of deltas) {
                    insert.run(sessionId, delta.studentId, delta.included ? 1 : 0, now, now, sessionId, delta.studentId);
                }
            })();
        },
    };
}

export type SessionParticipantRepository = ReturnType<typeof createSessionParticipantRepository>;
