// Server log tail endpoints (admin-only). The API answers from a bounded
// in-memory buffer of the lines the server already emitted — read-only, never a
// file, never a path. Entries arrive oldest → newest.

import { getList } from "./client";
import type { ListResult } from "../types/api";
import type { LogEntry, LogLevel } from "../types/domain";

export interface LogQuery {
    level?: LogLevel;
    limit?: number;
    since?: number; // only entries with seq > since (incremental tail)
}

export function listLogs(query: LogQuery = {}): Promise<ListResult<LogEntry>> {
    const params = new URLSearchParams();
    if (query.level) params.set("level", query.level);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.since !== undefined) params.set("since", String(query.since));
    const qs = params.toString();
    return getList<LogEntry>(`/logs${qs ? `?${qs}` : ""}`);
}
