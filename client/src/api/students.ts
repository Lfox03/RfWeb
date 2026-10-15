// Student endpoints (studentsRouter). Field names mirror the API exactly:
// camelCase inputs (firstName...), snake_case rows (first_name...).

import { del, get, getList, patch, post, postRaw } from "./client";
import type { ListResult } from "../types/api";
import type { CardRow, CardWithStudentRow, StudentWithCardRow } from "../types/domain";

export interface StudentInput {
    firstName: string;
    lastName?: string | null;
    studentNumber?: string | null;
    groupId?: number | null;
    email?: string | null;
}

// PATCH payload: explicit null clears a field (firstName cannot be cleared).
export type StudentPatch = Partial<StudentInput>;

export function listStudents(): Promise<ListResult<StudentWithCardRow>> {
    return getList<StudentWithCardRow>("/students");
}

export function getStudent(id: number): Promise<StudentWithCardRow> {
    return get<StudentWithCardRow>(`/students/${id}`);
}

export function listStudentCards(id: number): Promise<ListResult<CardRow>> {
    return getList<CardRow>(`/students/${id}/cards`);
}

export function createStudent(input: StudentInput): Promise<StudentWithCardRow> {
    return post<StudentWithCardRow>("/students", input);
}

export function updateStudent(id: number, patchBody: StudentPatch): Promise<StudentWithCardRow> {
    return patch<StudentWithCardRow>(`/students/${id}`, patchBody);
}

export function deleteStudent(id: number): Promise<void> {
    return del<void>(`/students/${id}`);
}

// Assign-or-replace: unknown UID is created, previous active card retired.
export function assignCard(studentId: number, uid: string): Promise<CardWithStudentRow> {
    return post<CardWithStudentRow>(`/students/${studentId}/card`, { uid });
}

// CSV import (POST /students/import, raw text/csv body). One row per student:
// prénom, nom, groupe, email, id — only first/last name required; id = the
// RFID card UID assigned to the student.
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

export function importStudentsCsv(csv: string): Promise<StudentImportResult> {
    return postRaw<StudentImportResult>("/students/import", "text/csv", csv);
}
