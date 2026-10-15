// "Students" repository (physical table app_students ; the legacy scan goes
// through the compatibility view `students`).

import type { DatabaseHandle } from "../database";
import { isoNow, normalizeUid } from "../types";
import type { StudentRow, StudentWithCardRow } from "../types";

export interface NewStudent {
    firstName: string;
    lastName?: string | null;
    studentNumber?: string | null;
    groupId?: number | null;
    email?: string | null;
}

export interface StudentUpdate {
    firstName?: string;
    lastName?: string | null;
    studentNumber?: string | null;
    groupId?: number | null;
    email?: string | null;
}

const STUDENT_WITH_CARD = `
SELECT
    s.*,
    c.uid  AS card_uid,
    c.id   AS card_id
FROM app_students s
LEFT JOIN cards c ON c.student_id = s.id AND c.revoked_at IS NULL
`;

export function createStudentRepository(db: DatabaseHandle) {
    return {
        create(input: NewStudent): StudentWithCardRow {
            const info = db
                .prepare(
                    `INSERT INTO app_students (first_name, last_name, student_number, group_id, email)
                     VALUES (?, ?, ?, ?, ?)`,
                )
                .run(
                    input.firstName,
                    input.lastName ?? null,
                    input.studentNumber ?? null,
                    input.groupId ?? null,
                    input.email ?? null,
                );
            return this.findWithCardById(Number(info.lastInsertRowid))!;
        },

        findById(id: number): StudentRow | undefined {
            return db.prepare("SELECT * FROM app_students WHERE id = ?").get(id) as StudentRow | undefined;
        },

        findWithCardById(id: number): StudentWithCardRow | undefined {
            return db.prepare(`${STUDENT_WITH_CARD} WHERE s.id = ?`).get(id) as StudentWithCardRow | undefined;
        },

        // Lookup by RFID UID — accepts a (decimal) number and normalizes it
        // to a string, like the reader's decID.
        findByCardUid(uid: string | number): StudentWithCardRow | undefined {
            return db.prepare(`${STUDENT_WITH_CARD} WHERE c.uid = ?`).get(normalizeUid(uid)) as
                | StudentWithCardRow
                | undefined;
        },

        findByStudentNumber(studentNumber: string): StudentRow | undefined {
            return db.prepare("SELECT * FROM app_students WHERE student_number = ?").get(studentNumber) as
                | StudentRow
                | undefined;
        },

        findAll(): StudentWithCardRow[] {
            return db.prepare(`${STUDENT_WITH_CARD} ORDER BY s.last_name, s.first_name`).all() as StudentWithCardRow[];
        },

        findByGroup(groupId: number): StudentWithCardRow[] {
            return db.prepare(`${STUDENT_WITH_CARD} WHERE s.group_id = ? ORDER BY s.last_name, s.first_name`).all(groupId) as
                | StudentWithCardRow[];
        },

        update(id: number, patch: StudentUpdate): StudentWithCardRow | undefined {
            const current = this.findById(id);
            if (!current) return undefined;
            db.prepare(
                `UPDATE app_students
                 SET first_name = ?, last_name = ?, student_number = ?, group_id = ?, email = ?, updated_at = ?
                 WHERE id = ?`,
            ).run(
                patch.firstName ?? current.first_name,
                patch.lastName !== undefined ? patch.lastName : current.last_name,
                patch.studentNumber !== undefined ? patch.studentNumber : current.student_number,
                patch.groupId !== undefined ? patch.groupId : current.group_id,
                patch.email !== undefined ? patch.email : current.email,
                isoNow(),
                id,
            );
            return this.findWithCardById(id);
        },

        remove(id: number): void {
            db.prepare("DELETE FROM app_students WHERE id = ?").run(id);
        },
    };
}

export type StudentRepository = ReturnType<typeof createStudentRepository>;
