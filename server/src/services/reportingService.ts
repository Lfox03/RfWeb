// Phase 7 — attendance reporting & CSV export.
//
// Read-only projections over the data already produced by the scan loop:
// an attendee is exactly a student holding an app_attendances row for the
// session (the state table is UNIQUE per session+student, so duplicate scans
// can never add attendance), and first_scan_at is that row's timestamp — the
// first accepted scan. No attendance/scan semantics are altered here.

import { NotFoundError, ValidationError } from "../core/errors";
import { attendanceRepository, groupRepository, sessionRepository } from "../db";
import type { AttendanceReportRow } from "../db/repositories/attendances";
import type { ReportSessionRow } from "../db/repositories/sessions";
import type { SessionRow, SessionStatus } from "../db/types";

export interface ReportFilters {
    from?: string; // YYYY-MM-DD (inclusive, UTC calendar date)
    to?: string;
    groupId?: number;
    status?: SessionStatus;
}

export interface SessionReport {
    session: SessionRow;
    // Names of the groups attached to the session, joined by ", " (null if
    // no group — roster limited to the attendees).
    group_name: string | null;
    summary: { present: number; absent: number; total: number };
    rows: AttendanceReportRow[];
}

export function listReportSessions(filters: ReportFilters): ReportSessionRow[] {
    if (filters.from !== undefined && filters.to !== undefined && filters.from > filters.to) {
        throw new ValidationError("La date de fin est antérieure à la date de début.");
    }
    return sessionRepository.findForReport(filters);
}

// Expected students, two sources :
//   • roster FROZEN at start (roster_frozen_at set, Phase 3) → the snapshot is
//     authoritative : absences and totals follow WHO WAS planned when the
//     session began, immune to later group/roster edits ;
//   • never frozen (legacy session, or captured through the raw repository
//     path) → the historical live projection (UNION of the current groups).
// Attendees outside the expected set (manual presence marks ignore the
// scope) are appended as present in both cases.
export function getSessionReport(sessionId: number): SessionReport {
    const session = sessionRepository.findById(sessionId);
    if (!session) throw new NotFoundError("Session");
    const groupIds = sessionRepository.getGroupIds(sessionId);
    const rows =
        session.roster_frozen_at !== null
            ? attendanceRepository.getSessionReportFromRoster(sessionId)
            : attendanceRepository.getSessionReport(sessionId, groupIds);
    const present = rows.filter((row) => row.status === "present").length;
    const groupNames = groupIds
        .map((id) => groupRepository.findById(id)?.name)
        .filter((name): name is string => name !== undefined);
    return {
        session,
        group_name: groupNames.length > 0 ? groupNames.join(", ") : null,
        summary: { present, absent: rows.length - present, total: rows.length },
        rows,
    };
}

// ─── CSV export ──────────────────────────────────────────────────────────────
// Stable column contract (never rename casually): one header row + one line
// per student of the report roster. Timestamps are ISO-8601 UTC (same format
// as the database); absent students are explicit ("Absent(e)", empty time).
// No internal data (UIDs, password material, tokens) is ever included.
export const CSV_COLUMNS = ["Nom", "Prénom", "Numéro étudiant", "Groupe", "Présence", "Heure du premier scan"];

// RFC 4180 quoting: wrap fields that could break the layout, doubling inner
// quotes. Keeps accented names intact — the payload is UTF-8 (with BOM).
function csvField(value: string | null): string {
    const v = value ?? "";
    return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function buildSessionExport(sessionId: number): { filename: string; csv: string } {
    const report = getSessionReport(sessionId);
    const lines: string[] = [CSV_COLUMNS.join(",")];
    for (const row of report.rows) {
        lines.push(
            [
                csvField(row.last_name),
                csvField(row.first_name),
                csvField(row.student_number),
                csvField(row.group_name),
                row.status === "present" ? "Présent(e)" : "Absent(e)",
                csvField(row.status === "present" ? row.first_scan_at : null),
            ].join(","),
        );
    }
    return {
        filename: `presences-session-${sessionId}.csv`,
        // BOM so spreadsheet apps (Excel) decode the UTF-8 names correctly.
        csv: `\uFEFF${lines.join("\r\n")}\r\n`,
    };
}
