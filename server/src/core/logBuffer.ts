// In-memory ring buffer of the most recent log lines — the read side of the
// structured logger (core/logger.ts), powering the admin « Journaux » screen.
//
// The logger pushes EVERY line it emits (already sanitized/redacted at emit
// time) into this bounded buffer, independently of the output sink: the sink
// (stdout/stderr, or the api:verify test seam) and this buffer are two
// parallel destinations. Nothing is ever persisted here — it is a volatile
// tail of the running process, deliberately separate from the persistent audit
// journal (card_scans in SQLite).
//
// Confidentiality: what lands here is EXACTLY what the logger emits, i.e.
// post-sanitization records (passwords/tokens/cookies redacted, RFID uids
// masked). This buffer therefore cannot leak anything the console does not
// already print. Exposure is gated by an admin-only HTTP route (the raw JSON
// line may still contain stack traces for internal 500s).
//
// The type-only import keeps the runtime dependency one-way (logger →
// logBuffer): this module never imports the logger at runtime.

import { LOG_BUFFER_SIZE } from "../config/env";
import type { LogFields, LogLevel } from "./logger";

export interface BufferedLog {
    seq: number; // monotonic, gapless within the process — the tail cursor
    level: LogLevel;
    line: string; // the exact serialized JSON line
    record: LogFields; // the same record, pre-serialization
}

export interface ListLogOptions {
    level?: LogLevel; // exact level filter
    limit?: number; // keep at most the N most recent (returned oldest → newest)
    sinceSeq?: number; // only entries with seq > sinceSeq (incremental tail)
}

let capacity = normalizeCapacity(LOG_BUFFER_SIZE);

// Guard against garbage env values (NaN, 0, negative, absurd sizes).
function normalizeCapacity(value: number): number {
    if (!Number.isFinite(value)) return 500;
    return Math.min(50_000, Math.max(1, Math.trunc(value)));
}

let entries: BufferedLog[] = [];
let nextSeq = 1;

// Pushed by the logger for every emitted line. Oldest entries are evicted once
// the buffer is full, so its memory stays bounded by `capacity`.
export function captureLog(line: string, level: LogLevel, record: LogFields): void {
    entries.push({ seq: nextSeq++, level, line, record });
    if (entries.length > capacity) {
        entries.splice(0, entries.length - capacity);
    }
}

// Newest entries, returned in chronological order (oldest → newest) so a viewer
// can append them like a terminal tail.
export function listLogs(options: ListLogOptions = {}): BufferedLog[] {
    const { level, limit, sinceSeq } = options;
    let rows = entries;
    if (sinceSeq !== undefined) rows = rows.filter((e) => e.seq > sinceSeq);
    if (level !== undefined) rows = rows.filter((e) => e.level === level);
    if (limit !== undefined && rows.length > limit) rows = rows.slice(rows.length - limit);
    return rows.slice(); // defensive copy: callers must not see the live array
}

// Buffer metadata for the API `meta` envelope and the screen header.
export function getLogBufferInfo(): { capacity: number; buffered: number } {
    return { capacity, buffered: entries.length };
}
