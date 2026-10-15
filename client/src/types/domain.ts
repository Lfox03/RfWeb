// Domain row shapes mirrored from the backend (server/src/db/types.ts and the
// services). Fields stay snake_case exactly as the API returns them; the
// client must not rename them (single source of truth: the API contract).

// "kiosk" = kiosk-account terminal: access limited to the /kiosk page,
// read-only API server-side.
export type UserRole = "admin" | "teacher" | "kiosk";

export interface AuthUser {
    id: number;
    username: string;
    role: UserRole;
}

// GET /api/users* (admin-only account view — never carries password_hash;
// lifecycle metadata included for the user-management page).
export interface UserAccount {
    id: number;
    username: string;
    role: UserRole;
    created_at: string;
    updated_at: string;
}

export interface GroupRow {
    id: number;
    name: string;
    created_at: string;
    updated_at: string;
    // Only present on GET /api/groups (groupService.GroupWithCount).
    student_count?: number;
}

export interface StudentRow {
    id: number;
    first_name: string;
    last_name: string | null;
    student_number: string | null;
    group_id: number | null;
    email: string | null;
    created_at: string;
    updated_at: string;
}

// GET /api/students* → student joined with its ACTIVE card (null when none).
export interface StudentWithCardRow extends StudentRow {
    card_uid: string | null;
    card_id: number | null;
}

export interface CardRow {
    id: number;
    uid: string;
    student_id: number | null;
    // null = active card; otherwise ISO date when the card was retired.
    revoked_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface CardWithStudentRow extends CardRow {
    student: {
        id: number;
        first_name: string;
        last_name: string | null;
        student_number: string | null;
        group_id: number | null;
    } | null;
}

export type SessionStatus = "scheduled" | "running" | "completed" | "cancelled";

export interface SessionRow {
    id: number;
    label: string;
    // Historical column (first group) — never use it for the scope anymore:
    // group_ids (session_groups table) is the authoritative source.
    group_id: number | null;
    scheduled_at: string;
    started_at: string | null;
    ended_at: string | null;
    duration_minutes: number;
    status: SessionStatus;
    // FK users — who created the session (NULL: legacy or unknown creator).
    created_by: number | null;
    // ─── Occurrence columns (migration 008, series récurrentes) ───
    // série dont la session est une occurrence (NULL = session autonome).
    series_id: number | null;
    // Date locale « YYYY-MM-DD » de l'occurrence dans le fuseau de la série
    // (NULL pour une session autonome) — identité de l'occurrence.
    occurrence_date: string | null;
    // Heure locale « HH:MM » de l'occurrence (NULL sur les lignes héritées).
    local_time: string | null;
    // Fuseau IANA du créneau local ('UTC' par défaut — véridique pour les
    // lignes antérieures à la migration 008).
    timezone: string;
    // Instant où la liste d'appel a été figée dans session_roster
    // (NULL = jamais figée).
    roster_frozen_at: string | null;
    created_at: string;
    updated_at: string;
}

// Session endpoints/services always expose the group scope: union of the
// students of group_ids (empty = all students).
export interface SessionWithGroups extends SessionRow {
    group_ids: number[];
    // Username of the creator (NULL when unknown).
    created_by_username: string | null;
}

// Occurrence enrichrie par GET /api/sessions/calendar : la session complète
// + son portée groupes + les métadonnées de sa série (NULL pour une session
// autonome), le nom des groupes attachés (jointure, tri alphabetique) et le
// NOMBRE DE PARTICIPANTS ATTENDUS (roster figé une fois la liste d'appel
// capturée, membership live sinon — 0 pour une session sans groupes).
// Attention : PAS de created_by_username ici (la vue calendrier ne le joint
// pas) — l'endpoint renvoie { ...SessionRow, group_ids, série…, compte }.
export interface CalendarSessionRow extends SessionRow {
    group_ids: number[];
    series_label: string | null;
    series_status: SeriesStatus | null;
    series_recurrence: RecurrencePattern | null;
    // Noms des groupes joints par ", " (NULL si aucun groupe) — la source
    // de vérité pour la portée reste group_ids.
    group_name: string | null;
    participant_count: number;
}

// GET /api/sessions/:id/attendance (attendance state, one row per student).
export interface SessionAttendanceRow {
    attendance_id: number;
    student_id: number;
    first_name: string;
    last_name: string | null;
    group_name: string | null;
    card_uid: string | null;
    scanned_at: string;
    is_valid: number;
}

// "out_of_group" = student scanned outside the session's group scope:
// journaled, never counted present.
// "manual" = presence entered manually by a teacher during the session
// (no card; empty uid in the WebSocket event).
export type ScanResult = "accepted" | "duplicate" | "unknown" | "expired" | "out_of_group" | "manual";

// GET /api/sessions/:id/scans (raw scan history, duplicates included).
export interface SessionScanRow {
    scan_id: number;
    student_id: number | null;
    student_name: string | null;
    uid: string | null;
    result: ScanResult;
    scanned_at: string;
}

// ─── Séries récurrentes (Phase 3, migration 008) ─────────────────────────────

export type RecurrencePattern = "daily" | "weekly";
export type SeriesStatus = "active" | "paused" | "cancelled";

// Modèle de récurrence (session_series). weekday suit la convention JS
// getDay : 0 = dimanche … 6 = samedi (obligatoire si « weekly », NULL si
// « daily »). starts_on/ends_on sont des dates locales « YYYY-MM-DD »
// inclusives (ends_on NULL = sans fin). local_time + timezone portent le
// créneau local ; scheduled_at de chaque occurrence reste l'instant UTC.
export interface SessionSeriesRow {
    id: number;
    label: string;
    recurrence: RecurrencePattern;
    weekday: number | null;
    local_time: string;
    timezone: string;
    duration_minutes: number;
    starts_on: string;
    ends_on: string | null;
    status: SeriesStatus;
    created_by: number | null;
    created_at: string;
    updated_at: string;
}

// Écart individuel au niveau de la série : included = 1 → rejoint la série
// sans être dans un de ses groupes ; included = 0 → quitte la série malgré
// son groupe.
export interface SeriesParticipantRow {
    series_id: number;
    student_id: number;
    included: number; // 0 | 1
    created_at: string;
    updated_at: string;
}

// GET/POST /api/series — série + portée groupes.
export interface SeriesWithGroups extends SessionSeriesRow {
    group_ids: number[];
}

// GET /api/series/:id — détail + écarts individuels.
export interface SeriesDetail extends SeriesWithGroups {
    participants: SeriesParticipantRow[];
}

// PATCH /api/series/:id (« à partir de cette date ») — résultat de
// l'édition transactionnelle.
export interface SeriesEditResult {
    series: SessionSeriesRow;
    updated: number[];
    cancelled: number[];
    created: number[];
    skipped: Array<{ occurrence_date: string; reason: string }>;
    preserved: number[];
}

// POST /api/series/:id/cancel — modèle annulé + occurrences futures
// encore planifiées qui viennent de l'être.
export interface SeriesCancellation {
    series: SessionSeriesRow;
    cancelled: number[];
}

// ─── Reporting (Phase 7) ─────────────────────────────────────────────────────

// GET /api/reports/sessions — session + group name + counters. present_count
// counts attendance STATE rows (duplicates structurally excluded); scan_count
// counts raw scan events (duplicates included).
export interface ReportSessionRow extends SessionRow {
    group_name: string | null;
    created_by_username: string | null;
    present_count: number;
    scan_count: number;
}

export type AttendanceStatus = "present" | "absent";

// One roster line of a session report (present = has an attendance state row;
// first_scan_at = timestamp of the first accepted scan).
export interface AttendanceReportRow {
    student_id: number;
    first_name: string;
    last_name: string | null;
    student_number: string | null;
    group_name: string | null;
    status: AttendanceStatus;
    first_scan_at: string | null;
}

// GET /api/reports/sessions/:id
export interface SessionReport {
    session: SessionRow;
    group_name: string | null;
    summary: { present: number; absent: number; total: number };
    rows: AttendanceReportRow[];
}

// GET /api/reader/status (readerService.ReaderStatus).
export interface ReaderStatus {
    online: boolean;
    scanRunning: boolean;
    sessionId: number | null;
    activeSession: { id: number; label: string } | null;
}

// POST /api/reader/next-card result.
export interface CardProbe {
    uid: string;
    hexId: string;
}

// ─── Database backups (admin) ───────────────────────────────────────────────

// POST/GET /api/backups — one .db snapshot stored server-side. Never a server
// path: just the generated filename, its size and its creation time.
export interface BackupInfo {
    filename: string;
    size_bytes: number;
    created_at: string;
}

// POST /api/backups/restore — result of a full database restore. safety_backup
// is the snapshot of the database as it was BEFORE the replacement (listed and
// downloadable like any other backup).
export interface RestoreResult {
    restored_size_bytes: number;
    safety_backup: BackupInfo;
}

// ─── Server logs (admin) ────────────────────────────────────────────────────

// Structured log level, exactly as core/logger.ts emits it.
export type LogLevel = "debug" | "info" | "warn" | "error";

// One buffered log line (GET /api/logs). `fields` is the already-redacted
// context (passwords/tokens/cookies masked server-side, RFID uids truncated);
// `line` is the raw JSON line, kept so the entry can be inspected verbatim.
export interface LogEntry {
    seq: number;
    timestamp: string;
    level: LogLevel;
    event: string;
    component: string | null;
    fields: Record<string, unknown>;
    line: string;
}
