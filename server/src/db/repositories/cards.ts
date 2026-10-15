// "RFID cards" repository. Cards are entities distinct from students :
// unassigned (student_id NULL), active (student_id + revoked_at NULL) or
// retired (revoked_at NOT NULL, history kept → replacement possible).

import type { DatabaseHandle } from "../database";
import { isoNow, normalizeUid } from "../types";
import type { CardRow } from "../types";

export function createCardRepository(db: DatabaseHandle) {
    return {
        // Card in stock, unassigned.
        issue(uid: string | number): CardRow {
            const value = normalizeUid(uid);
            const info = db.prepare("INSERT INTO cards (uid) VALUES (?)").run(value);
            return this.findById(Number(info.lastInsertRowid))!;
        },

        findById(id: number): CardRow | undefined {
            return db.prepare("SELECT * FROM cards WHERE id = ?").get(id) as CardRow | undefined;
        },

        findByUid(uid: string | number): CardRow | undefined {
            return db.prepare("SELECT * FROM cards WHERE uid = ?").get(normalizeUid(uid)) as CardRow | undefined;
        },

        // Active (non-retired) card of a student, if they have one.
        findActiveByStudent(studentId: number): CardRow | undefined {
            return db
                .prepare("SELECT * FROM cards WHERE student_id = ? AND revoked_at IS NULL")
                .get(studentId) as CardRow | undefined;
        },

        listByStudent(studentId: number): CardRow[] {
            return db
                .prepare("SELECT * FROM cards WHERE student_id = ? ORDER BY created_at ASC")
                .all(studentId) as CardRow[];
        },

        // Assign a card to a student : retires the previous active card
        // (replacement, history kept) then reactivates/creates the target card.
        assignToStudent(uid: string | number, studentId: number): CardRow {
            const value = normalizeUid(uid);
            return db.transaction(() => {
                const now = isoNow();
                const previous = this.findActiveByStudent(studentId);
                if (previous && previous.uid !== value) {
                    db.prepare("UPDATE cards SET revoked_at = ?, updated_at = ? WHERE id = ?")
                        .run(now, now, previous.id);
                }

                const existing = this.findByUid(value);
                if (existing) {
                    if (existing.student_id !== null && existing.revoked_at === null && existing.student_id !== studentId) {
                        throw new Error(`Carte ${value} déjà assignée à l'étudiant ${existing.student_id}.`);
                    }
                    db.prepare("UPDATE cards SET student_id = ?, revoked_at = NULL, updated_at = ? WHERE id = ?")
                        .run(studentId, now, existing.id);
                    return this.findById(existing.id)!;
                }

                const info = db.prepare("INSERT INTO cards (uid, student_id) VALUES (?, ?)").run(value, studentId);
                return this.findById(Number(info.lastInsertRowid))!;
            })();
        },

        // Retire an active card (end of life / lost) without erasing the history.
        retire(cardId: number): CardRow | undefined {
            const now = isoNow();
            db.prepare("UPDATE cards SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL")
                .run(now, now, cardId);
            return this.findById(cardId);
        },
    };
}

export type CardRepository = ReturnType<typeof createCardRepository>;
