// RFID cards service — registration, assignment, replacement, revocation.
// UIDs are decimal strings (normalizeUid); never bound as numbers.

import { ConflictError, NotFoundError, ValidationError } from "../core/errors";
import { cardRepository, studentRepository } from "../db";
import type { CardRow, StudentWithCardRow } from "../db/types";
import { normalizeUid } from "../db/types";

export interface CardWithStudent extends CardRow {
    student: Pick<
        StudentWithCardRow,
        "id" | "first_name" | "last_name" | "student_number" | "group_id"
    > | null;
}

// Invalid UID → clean API error (the repository throws a raw TypeError).
function toUid(uid: string): string {
    try {
        return normalizeUid(uid);
    } catch {
        throw new ValidationError("UID de carte invalide : entier décimal attendu.");
    }
}

function attachStudent(card: CardRow): CardWithStudent {
    if (card.student_id === null) return { ...card, student: null };
    const student = studentRepository.findWithCardById(card.student_id);
    if (!student) return { ...card, student: null };
    return {
        ...card,
        student: {
            id: student.id,
            first_name: student.first_name,
            last_name: student.last_name,
            student_number: student.student_number,
            group_id: student.group_id,
        },
    };
}

// Card in stock, unassigned.
export function register(uid: string): CardWithStudent {
    const value = toUid(uid);
    if (cardRepository.findByUid(value)) {
        throw new ConflictError("UID_ALREADY_REGISTERED", `La carte ${value} est déjà enregistrée.`);
    }
    return attachStudent(cardRepository.issue(value));
}

export function getByUid(uid: string): CardWithStudent {
    const card = cardRepository.findByUid(toUid(uid));
    if (!card) throw new NotFoundError("Carte");
    return attachStudent(card);
}

// Revokes a card (loss/theft/end of life) — the history is kept.
export function revokeByUid(uid: string): CardWithStudent {
    const card = getByUid(uid);
    if (card.revoked_at !== null) {
        throw new ConflictError("CARD_ALREADY_REVOKED", `La carte ${card.uid} est déjà retirée.`);
    }
    return attachStudent(cardRepository.retire(card.id)!);
}

// Assigns/reassigns a card to a student: the previous active card is
// revoked (replacement), the unknown card is created, the free or
// revoked card is reactivated. Refused if the card is active for another student.
export function assignToStudent(uid: string, studentId: number): CardWithStudent {
    if (!studentRepository.findById(studentId)) throw new NotFoundError("Étudiant");
    try {
        return attachStudent(cardRepository.assignToStudent(toUid(uid), studentId));
    } catch (err) {
        if (err instanceof Error && err.message.includes("déjà assignée")) {
            throw new ConflictError("CARD_ALREADY_ASSIGNED", err.message);
        }
        throw err;
    }
}

// Card history of a student (active + revoked).
export function listByStudent(studentId: number): CardRow[] {
    if (!studentRepository.findById(studentId)) throw new NotFoundError("Étudiant");
    return cardRepository.listByStudent(studentId);
}
