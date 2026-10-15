import { get, getList, patch, post, postEmpty } from "./client";
import type { ListResult } from "../types/api";
import type {
    CalendarSessionRow,
    SessionAttendanceRow,
    SessionScanRow,
    SessionWithGroups,
} from "../types/domain";

export interface SessionInput {
    label: string;
    // Session scope: union of the selected groups — AT LEAST one group is
    // required (400 rejection otherwise). Sending "groupId" (single) is still
    // accepted by the API but no longer used by the client.
    groupIds: number[];
    scheduledAt?: string;
    durationMinutes?: number;
}

export function listSessions(): Promise<ListResult<SessionWithGroups>> {
    return getList<SessionWithGroups>("/sessions");
}

export function getActiveSession(): Promise<SessionWithGroups | null> {
    return get<SessionWithGroups | null>("/sessions/active");
}

export function getSession(id: number): Promise<SessionWithGroups> {
    return get<SessionWithGroups>(`/sessions/${id}`);
}

export function createSession(input: SessionInput): Promise<SessionWithGroups> {
    return post<SessionWithGroups>("/sessions", input);
}

// Édition d'UNE session « programmée » (« modifier ce cours ») : libellé,
// instant UTC et/ou durée. Le serveur refuse (409 SESSION_INVALID_TRANSITION)
// toute autre statut — l'historique démarré/terminé n'est jamais réécrit.
// L'identité de série d'une occurrence reste intacte (« cette occurrence et
// les suivantes » passe par PATCH /api/series/:id).
export interface SessionSchedulePatch {
    label?: string;
    scheduledAt?: string;
    durationMinutes?: number;
}

export function updateSession(id: number, patchBody: SessionSchedulePatch): Promise<SessionWithGroups> {
    return patch<SessionWithGroups>(`/sessions/${id}`, patchBody);
}

// Flux du planning hebdomadaire : les occurrences concrètes dans la plage
// inclusive [from, to] (dates locales « YYYY-MM-DD », les deux obligatoires).
// Sémantique serveur (sessionService.getCalendar) : les occurrences de série
// correspondent à leur occurrence_date LOCALE (le jour réel du cours dans le
// fuseau de la série), les sessions autonomes à leur jour UTC de scheduled_at.
// Les lignes portent scheduled_at/local_time/timezone/durée, le statut, les
// métadonnées de série, group_ids + group_name et le nombre de participants
// attendus. Tri chronologique (ancien → récent).
export function getCalendar(from: string, to: string): Promise<ListResult<CalendarSessionRow>> {
    return getList<CalendarSessionRow>(`/sessions/calendar?from=${from}&to=${to}`);
}

export function startSession(id: number): Promise<SessionWithGroups> {
    return postEmpty<SessionWithGroups>(`/sessions/${id}/start`);
}

export function stopSession(id: number): Promise<SessionWithGroups> {
    return postEmpty<SessionWithGroups>(`/sessions/${id}/stop`);
}

export function cancelSession(id: number): Promise<SessionWithGroups> {
    return postEmpty<SessionWithGroups>(`/sessions/${id}/cancel`);
}

export function listAttendance(sessionId: number): Promise<ListResult<SessionAttendanceRow>> {
    return getList<SessionAttendanceRow>(`/sessions/${sessionId}/attendance`);
}

export function listScans(sessionId: number): Promise<ListResult<SessionScanRow>> {
    return getList<SessionScanRow>(`/sessions/${sessionId}/scans`);
}

// Manual presence mark (teacher correction) — session must be running; the
// server journals a « manual » event and broadcasts attendance:scanned.
export function markPresentManually(sessionId: number, studentId: number): Promise<unknown> {
    return post(`/sessions/${sessionId}/attendance/manual`, { studentId });
}

// Clears the attendance STATE only; scan history is preserved.
export function resetAttendance(sessionId: number): Promise<void> {
    return postEmpty<void>(`/sessions/${sessionId}/attendance/reset`);
}
