// Domain types of the new database layer (Phase 2).

import { getClock } from "../core/clock";

// ─── Timestamp convention ──────────────────────────────────────────────────────
// All timestamps are stored as TEXT in ISO-8601 UTC format with
// milliseconds and a Z suffix: "2026-06-06T12:20:04.000Z"
// (identical to Date.prototype.toISOString() and to strftime('%Y-%m-%dT%H:%M:%fZ','now')).
// No other representation is accepted on writes.

export type IsoDateTime = string;

// "kiosk" = kiosk terminal account (presentation only): read-only on
// the API, exclusive access to the /kiosk page on the client side.
export type UserRole = "admin" | "teacher" | "kiosk";

export type SessionStatus = "scheduled" | "running" | "completed" | "cancelled";

// Card scan result (timestamped event, distinct from the attendance state).
// "out_of_group" = student scanned outside the session's group scope
// (journalized, never counted present).
// "manual" = presence entered manually by a teacher during the session
// (no card: uid/card_id NULL in card_scans).
export type ScanResult = "accepted" | "duplicate" | "unknown" | "expired" | "out_of_group" | "manual";

export interface UserRow {
    id: number;
    username: string;
    password_hash: string;
    role: UserRole;
    created_at: IsoDateTime;
    updated_at: IsoDateTime;
}

export interface GroupRow {
    id: number;
    name: string;
    created_at: IsoDateTime;
    updated_at: IsoDateTime;
}

export interface StudentRow {
    id: number;
    first_name: string;
    last_name: string | null;
    student_number: string | null;
    group_id: number | null;
    email: string | null;
    created_at: IsoDateTime;
    updated_at: IsoDateTime;
}

export interface StudentWithCardRow extends StudentRow {
    // UID of the student's active card (null if no active card).
    card_uid: string | null;
    card_id: number | null;
}

export interface CardRow {
    id: number;
    uid: string;
    student_id: number | null;
    // NULL = active card; otherwise ISO date of withdrawal (replacement).
    revoked_at: IsoDateTime | null;
    created_at: IsoDateTime;
    updated_at: IsoDateTime;
}

export interface SessionRow {
    id: number;
    label: string;
    group_id: number | null;
    scheduled_at: IsoDateTime;
    started_at: IsoDateTime | null;
    ended_at: IsoDateTime | null;
    duration_minutes: number;
    status: SessionStatus;
    // FK users — the authenticated user who created the session
    // (NULL: created before migration 007 or without a user).
    created_by: number | null;
    // ─── Recurring sessions (migration 008) ───
    // FK session_series — the template this occurrence belongs to
    // (NULL = standalone session; also set back to NULL by the FK when
    // the series is deleted, the occurrence history then stands alone).
    series_id: number | null;
    // Local calendar date (YYYY-MM-DD, in the series' timezone) identifying
    // the occurrence within its series — UNIQUE(series_id, occurrence_date).
    // NULL on standalone sessions.
    occurrence_date: string | null;
    // 'HH:MM' wall-clock start preserved alongside the UTC instant
    // (scheduled_at stays authoritative). NULL on legacy rows.
    local_time: string | null;
    // IANA timezone of the local scheduling (DEFAULT 'UTC' — truthful for
    // every row created before migration 008, timestamps being UTC).
    timezone: string;
    // Instant the attendance roster was snapshotted into session_roster
    // (NULL = never frozen).
    roster_frozen_at: IsoDateTime | null;
    created_at: IsoDateTime;
    updated_at: IsoDateTime;
}

// Recurrence template (migration 008). Generation of occurrences is a
// later phase — this is the persisted intent.
export type RecurrencePattern = "daily" | "weekly";
export type SeriesStatus = "active" | "paused" | "cancelled";

export interface SessionSeriesRow {
    id: number;
    label: string;
    recurrence: RecurrencePattern;
    // 0 = Sunday … 6 = Saturday (JS Date.getDay convention). Weekly patterns
    // require it (CHECK); daily patterns keep it NULL.
    weekday: number | null;
    // 'HH:MM' wall-clock start, interpreted in the timezone below.
    local_time: string;
    timezone: string;
    duration_minutes: number;
    // Inclusive local date range of the series ('YYYY-MM-DD';
    // ends_on NULL = open-ended).
    starts_on: string;
    ends_on: string | null;
    status: SeriesStatus;
    // FK users — creator of the series (NULL: user deleted).
    created_by: number | null;
    created_at: IsoDateTime;
    updated_at: IsoDateTime;
}

// Group scope of a series (mirror of session_groups).
export interface SessionSeriesGroupRow {
    series_id: number;
    group_id: number;
    created_at: IsoDateTime;
}

// Inclusion/exclusion delta at series level: included = 1 → joins the series
// without being in one of its groups; included = 0 → leaves the series
// despite being in one of its groups.
export interface SessionSeriesParticipantRow {
    series_id: number;
    student_id: number;
    included: number; // 0 | 1 (CHECK)
    created_at: IsoDateTime;
    updated_at: IsoDateTime;
}

// Same inclusion/exclusion delta semantics, scoped to ONE occurrence.
// inherited (migration 009) : 1 = copy of the series' delta written by
// generation — a series edit « this and following » may rewrite it ;
// 0 = explicit per-occurrence row — never rewritten by a series edit.
export interface SessionParticipantRow {
    session_id: number;
    student_id: number;
    included: number; // 0 | 1 (CHECK)
    inherited: number; // 0 | 1 (CHECK, migration 009)
    created_at: IsoDateTime;
    updated_at: IsoDateTime;
}

// Participant snapshot frozen when a session starts. IMMUTABLE by schema
// guards (explicit UPDATE/DELETE refused): the denormalized names keep the
// history readable even after renames or student deletion (student_id then
// NULL via the FK SET NULL).
export interface SessionRosterRow {
    id: number;
    session_id: number;
    student_id: number | null;
    full_name: string;
    group_name: string | null;
    frozen_at: IsoDateTime;
}

// Attendance state: one row = one student's attendance for a session
// (UNIQUE(session_id, student_id) constraint).
export interface AttendanceRow {
    id: number;
    session_id: number;
    student_id: number;
    scanned_at: IsoDateTime;
    is_valid: number;
}

// Server-side login session (persistent since migration 006).
// token_hash is the SHA-256 hex digest of the opaque cookie token — the raw
// token is NEVER stored; expires_at/last_seen_at drive the TTL.
export interface AuthSessionRow {
    id: number;
    token_hash: string;
    user_id: number;
    created_at: IsoDateTime;
    expires_at: IsoDateTime;
    last_seen_at: IsoDateTime;
}

// Scan event: the raw history, one scan = one row (duplicates included).
export interface CardScanRow {
    id: number;
    session_id: number;
    student_id: number | null;
    card_id: number | null;
    uid: string | null;
    result: ScanResult;
    scanned_at: IsoDateTime;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

// Single point of truth for "current time" on the write side: resolves the
// ACTIVE clock (core/clock.ts) on each call, so every timestamp follows the
// injected clock — the system clock in production, a FakeClock in tests.
export function isoNow(): IsoDateTime {
    return getClock().now().toISOString();
}

// The RFID reader (rfid/rfidWorker.js) publishes decID = id.toString(10): the UID
// is a DECIMAL string. All UID inputs are normalized to this
// representation before reaching the database (cards.uid column, TEXT).
export function normalizeUid(uid: string | number): string {
    const value = String(uid).trim();
    if (!/^\d+$/.test(value)) {
        throw new TypeError(`UID de carte RFID invalide (entier décimal attendu) : ${JSON.stringify(uid)}`);
    }
    return value;
}
