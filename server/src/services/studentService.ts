// Students service — application rules on top of the student/card/group
// repositories (RFID scanning goes through attendanceService).

import { parseCsv } from "../core/csv";
import { EMAIL_MAX_LENGTH, isEmail } from "../core/email";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors";
import { logger } from "../core/logger";
import { db, cardRepository, groupRepository, studentRepository } from "../db";
import type { StudentWithCardRow } from "../db/types";
import { normalizeUid } from "../db/types";

const studentLog = logger.child({ component: "student" });

function studentNumberConflict(err: unknown): never {
    if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new ConflictError("STUDENT_NUMBER_TAKEN", "Ce numéro d'étudiant est déjà utilisé.");
    }
    throw err;
}

// The referenced group must exist (otherwise explicit API error, no silent
// FK failure surfacing as 400).
function assertGroupExists(groupId: number | null | undefined): void {
    if (groupId !== undefined && groupId !== null && !groupRepository.findById(groupId)) {
        throw new ValidationError(`Groupe ${groupId} introuvable.`);
    }
}

export function list(): StudentWithCardRow[] {
    return studentRepository.findAll();
}

export function get(id: number): StudentWithCardRow {
    const student = studentRepository.findWithCardById(id);
    if (!student) throw new NotFoundError("Étudiant");
    return student;
}

export function getByCardUid(uid: string): StudentWithCardRow {
    const student = studentRepository.findByCardUid(normalizeUid(uid));
    if (!student) throw new NotFoundError("Étudiant portant cette carte");
    return student;
}

export function create(input: {
    firstName: string;
    lastName?: string | null;
    studentNumber?: string | null;
    groupId?: number | null;
    email?: string | null;
}): StudentWithCardRow {
    assertGroupExists(input.groupId);
    try {
        return studentRepository.create(input);
    } catch (err) {
        return studentNumberConflict(err);
    }
}

export function update(
    id: number,
    patch: {
        firstName?: string;
        lastName?: string | null;
        studentNumber?: string | null;
        groupId?: number | null;
        email?: string | null;
    },
): StudentWithCardRow {
    get(id);
    assertGroupExists(patch.groupId);
    try {
        const updated = studentRepository.update(id, patch);
        if (!updated) throw new NotFoundError("Étudiant");
        return updated;
    } catch (err) {
        return studentNumberConflict(err);
    }
}

// Permanent deletion: cards detached (SET NULL), attendances deleted
// in cascade — the card_scans history is kept (student_id SET NULL).
export function remove(id: number): void {
    get(id);
    studentRepository.remove(id);
    studentLog.info("student.deleted", { student_id: id });
}

// Validation shared with cardService: the referenced student must exist.
export function assertExists(id: number): void {
    if (!studentRepository.findById(id)) throw new NotFoundError("Étudiant");
}

// ─── CSV import ───────────────────────────────────────────────────────────────
// Expected structure: header "prénom, nom, groupe, email, id" (columns
// recognized without accents or case, extra columns ignored). Only
// first and last names are required; "id" is the RFID card UID (decimal)
// assigned to the student (card created if unknown) and "groupe" a group
// name (created automatically if it does not exist). Invalid rows are
// skipped and reported (line number), the others are inserted —
// all of it in a single transaction.

const MAX_IMPORT_ROWS = 5000;
const IMPORT_NAME_MAX = 100;

export interface StudentImportIssue {
    line: number;
    message: string;
}

export interface StudentImportResult {
    imported: number;
    skipped: number;
    groups_created: string[];
    errors: StudentImportIssue[];
}

// Normalized header: lowercase, no spaces or accents ("Prénom" →
// "prenom") to tolerate case and accent-encoding variations.
function normalizeColumnName(name: string): string {
    return name.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function importCsv(text: string): StudentImportResult {
    const records = parseCsv(text);
    if (records.length === 0) {
        throw new ValidationError("Fichier CSV vide : en-tête « prénom, nom, groupe, email, id » attendu.");
    }
    const header = records[0].values.map(normalizeColumnName);
    const column = (...names: string[]): number => header.findIndex((h) => names.includes(h));
    const firstNameCol = column("prenom");
    const lastNameCol = column("nom");
    if (firstNameCol === -1 || lastNameCol === -1) {
        throw new ValidationError(
            "En-tête invalide : les colonnes « prénom » et « nom » sont requises (structure attendue : prénom, nom, groupe, email, id).",
        );
    }
    const groupCol = column("groupe");
    const emailCol = column("email", "e-mail", "mail");
    const cardCol = column("id", "uid", "carte");

    const rows = records.slice(1);
    if (rows.length === 0) {
        throw new ValidationError("Aucun étudiant à importer : le fichier ne contient qu'un en-tête.");
    }
    if (rows.length > MAX_IMPORT_ROWS) {
        throw new ValidationError(`Import limité à ${MAX_IMPORT_ROWS} lignes (fichier : ${rows.length} lignes).`);
    }

    const errors: StudentImportIssue[] = [];
    const groupsCreated: string[] = [];
    let imported = 0;

    db.transaction(() => {
        for (const record of rows) {
            const cell = (index: number): string =>
                index >= 0 && index < record.values.length ? record.values[index].trim() : "";
            const firstName = cell(firstNameCol);
            const lastName = cell(lastNameCol);
            const groupName = cell(groupCol);
            const email = cell(emailCol);
            const cardUid = cell(cardCol);

            // Empty line (or only separators): irrelevant.
            if (firstName === "" && lastName === "" && groupName === "" && email === "" && cardUid === "") {
                continue;
            }

            let failure: string | null = null;
            let uid: string | null = null;
            if (firstName === "" || lastName === "") {
                failure = "Prénom et nom obligatoires.";
            } else if (firstName.length > IMPORT_NAME_MAX || lastName.length > IMPORT_NAME_MAX) {
                failure = `Prénom et nom limités à ${IMPORT_NAME_MAX} caractères.`;
            } else if (email !== "" && (email.length > EMAIL_MAX_LENGTH || !isEmail(email))) {
                failure = "Adresse e-mail invalide.";
            } else if (cardUid !== "") {
                try {
                    uid = cardUid.length > 20 ? null : normalizeUid(cardUid);
                    if (uid === null) failure = "UID de carte invalide : entier décimal attendu.";
                } catch {
                    failure = "UID de carte invalide : entier décimal attendu.";
                }
            }
            if (failure) {
                errors.push({ line: record.line, message: failure });
                continue;
            }

            // Refused if the card is already active for another student: the
            // entire row is skipped (no student imported without their card).
            if (uid !== null) {
                const holder = cardRepository.findByUid(uid);
                if (holder && holder.student_id !== null && holder.revoked_at === null) {
                    errors.push({ line: record.line, message: `Carte ${uid} déjà attribuée à un autre étudiant.` });
                    continue;
                }
            }

            let groupId: number | null = null;
            if (groupName !== "") {
                if (!groupRepository.findByName(groupName)) groupsCreated.push(groupName);
                groupId = groupRepository.findOrCreateByName(groupName).id;
            }
            const created = studentRepository.create({
                firstName,
                lastName,
                studentNumber: null,
                groupId,
                email: email === "" ? null : email,
            });
            if (uid !== null) cardRepository.assignToStudent(uid, created.id);
            imported += 1;
        }
    })();

    studentLog.info("student.csv_import", {
        imported,
        skipped: errors.length,
        groups_created: groupsCreated.length,
    });
    return { imported, skipped: errors.length, groups_created: groupsCreated, errors };
}
