// Phase 7 reporting endpoints (read-only; both admin and teacher).
// Filters mirror the API query parameters exactly.

import { downloadFile, get, getList } from "./client";
import type { ListResult } from "../types/api";
import type { ReportSessionRow, SessionReport, SessionStatus } from "../types/domain";

export interface ReportFilters {
    from?: string; // YYYY-MM-DD (inclusive, UTC calendar date)
    to?: string;
    groupId?: number;
    status?: SessionStatus;
}

function buildQuery(filters: ReportFilters): string {
    const params = new URLSearchParams();
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    if (filters.groupId !== undefined) params.set("groupId", String(filters.groupId));
    if (filters.status) params.set("status", filters.status);
    const query = params.toString();
    return query ? `?${query}` : "";
}

export function listReportSessions(filters: ReportFilters): Promise<ListResult<ReportSessionRow>> {
    return getList<ReportSessionRow>(`/reports/sessions${buildQuery(filters)}`);
}

export function getSessionReport(id: number): Promise<SessionReport> {
    return get<SessionReport>(`/reports/sessions/${id}`);
}

// Server-generated CSV (authoritative data); triggers a browser download.
export function downloadSessionReportCsv(id: number): Promise<void> {
    return downloadFile(`/reports/sessions/${id}/export`, `presences-session-${id}.csv`);
}
