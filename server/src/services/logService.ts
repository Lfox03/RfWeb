// Read model for the admin « Journaux » screen: exposes the volatile in-memory
// tail maintained by core/logBuffer as API-friendly entries. This is the only
// layer the logs router talks to — the router never reaches into core/.
//
// Security note: entries are the sanitized records the logger already emits
// (passwords/tokens/cookies redacted, RFID uids masked), but a raw JSON line may
// still carry a stack trace for internal 500s — so this data stays behind the
// admin-only route.

import { getLogBufferInfo, listLogs as listBufferedLogs, type ListLogOptions } from "../core/logBuffer";
import type { LogFields, LogLevel } from "../core/logger";

export interface LogEntryView {
    seq: number;
    timestamp: string;
    level: LogLevel;
    event: string;
    component: string | null;
    fields: Record<string, unknown>; // context minus the reserved top-level keys
    line: string;
}

export interface LogPage {
    entries: LogEntryView[];
    capacity: number;
    buffered: number;
}

// Reserved keys hoisted to dedicated columns — never duplicated in `fields`.
const RESERVED = new Set(["timestamp", "level", "event", "component"]);

// Newest entries in chronological order (oldest → newest), ready for the UI.
export function listRecentLogs(options: ListLogOptions): LogPage {
    const buffered = listBufferedLogs(options);
    const info = getLogBufferInfo();
    const entries: LogEntryView[] = buffered.map((row): LogEntryView => {
        const record = row.record as LogFields & { timestamp?: string; level?: LogLevel; event?: string; component?: unknown };
        const fields: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(record)) {
            if (!RESERVED.has(key)) fields[key] = value;
        }
        return {
            seq: row.seq,
            timestamp: typeof record.timestamp === "string" ? record.timestamp : "",
            level: row.level,
            event: typeof record.event === "string" ? record.event : "",
            component: typeof record.component === "string" ? record.component : null,
            fields,
            line: row.line,
        };
    });
    return { entries, capacity: info.capacity, buffered: info.buffered };
}
