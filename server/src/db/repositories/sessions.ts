// "Attendance sessions" repository (physical tables app_sessions + session_groups).
//
// A session's group scope lives in session_groups (multiple groups
// possible) ; app_sessions.group_id is now just a compatibility mirror
// (first group), never read by the server.

import type { DatabaseHandle } from "../database";
import { isoNow } from "../types";
import type { RecurrencePattern, SeriesStatus, SessionRow, SessionStatus } from "../types";

export interface NewSession {
    label: string;
    groupIds?: number[]; // session scope (union of the groups)
    scheduledAt: string; // ISO-8601 UTC
    durationMinutes?: number;
    createdBy?: number | null; // authenticated user who created it (NULL allowed)
    // ─── Occurrence columns (migration 008) — NULL on standalone sessions.
    // Deciding WHICH occurrences a series generates is service logic
    // (services/seriesService) ; this layer only persists the row as given.
    seriesId?: number | null;
    occurrenceDate?: string | null; // 'YYYY-MM-DD' local (UNIQUE with seriesId)
    localTime?: string | null; // 'HH:MM' wall clock in the timezone below
    timezone?: string; // IANA, 'UTC' when omitted
}

// Scheduling fields an in-place occurrence rewrite may carry (edit of a series
// from an occurrence onward). Participant/group memberships are deliberately
// NOT part of this patch — they keep whatever the occurrence row already has.
export interface SchedulePatch {
    label?: string;
    scheduledAt?: string;
    localTime?: string;
    timezone?: string;
    durationMinutes?: number;
}

// Reporting filter (Phase 7): inclusive UTC calendar-date bounds on
// scheduled_at (YYYY-MM-DD, compared against substr(scheduled_at, 1, 10)).
export interface ReportSessionFilter {
    from?: string;
    to?: string;
    groupId?: number;
    status?: SessionStatus;
}

// Session + joined group names (comma-joined, from session_groups) + counters
// (attendance STATE rows and raw scan events) — read-only projection for the
// reporting list.
export interface ReportSessionRow extends SessionRow {
    group_name: string | null;
    created_by_username: string | null;
    present_count: number;
    scan_count: number;
}

// Calendar projection (weekly planner) : one concrete occurrence (or
// standalone session) with its series metadata, joined group names and the
// EXPECTED participant count (frozen roster when captured, live membership
// otherwise — see findForCalendar).
export interface CalendarSessionRow extends SessionRow {
    series_label: string | null;
    series_status: SeriesStatus | null;
    series_recurrence: RecurrencePattern | null;
    group_name: string | null;
    participant_count: number;
}

// CASE expression (shared by findForCalendar) deciding whether a student
// belongs to a session's EXPECTED membership : explicit inclusion delta wins,
// then explicit exclusion delta, then plain group membership. Bound with the
// @session alias for s.id.
const EXPECTED_MEMBERSHIP_CASE = `
    CASE
        WHEN (SELECT sp.included FROM session_participants sp
               WHERE sp.session_id = s.id AND sp.student_id = stu.id) = 1 THEN 1
        WHEN (SELECT sp.included FROM session_participants sp
               WHERE sp.session_id = s.id AND sp.student_id = stu.id) = 0 THEN 0
        ELSE (SELECT COUNT(*) FROM session_groups sg2
               WHERE sg2.session_id = s.id AND sg2.group_id = stu.group_id) > 0
    END`;

export function createSessionRepository(db: DatabaseHandle) {
    return {
        create(input: NewSession): SessionRow {
            const groupIds = [...new Set(input.groupIds ?? [])].filter(
                (id): id is number => Number.isInteger(id) && id > 0,
            );
            return db.transaction(() => {
                const info = db
                    .prepare(
                        `INSERT INTO app_sessions
                             (label, group_id, scheduled_at, duration_minutes, created_by,
                              series_id, occurrence_date, local_time, timezone)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    )
                    .run(
                        input.label,
                        // Compatibility mirror : first group (never read by the server).
                        groupIds.length > 0 ? groupIds[0] : null,
                        input.scheduledAt,
                        input.durationMinutes ?? 10,
                        input.createdBy ?? null,
                        input.seriesId ?? null,
                        input.occurrenceDate ?? null,
                        input.localTime ?? null,
                        input.timezone ?? "UTC",
                    );
                const sessionId = Number(info.lastInsertRowid);
                // Migration 009 provenance : memberships carried by a SERIES
                // OCCURRENCE are inherited copies of the series' scope (a
                // series edit « this and following » may rewrite them) ; a
                // standalone session's memberships are explicit.
                const insertMembership = db.prepare(
                    "INSERT INTO session_groups (session_id, group_id, inherited, created_at) VALUES (?, ?, ?, ?)",
                );
                const inherited = input.seriesId != null && input.seriesId > 0 ? 1 : 0;
                const now = isoNow();
                for (const groupId of groupIds) insertMembership.run(sessionId, groupId, inherited, now);
                return this.findById(sessionId)!;
            })();
        },

        // Replaces the INHERITED group scope of an occurrence (series edited
        // « this and following »). Explicit rows (inherited = 0) always win :
        // they survive untouched, and an explicit membership for a group
        // prevents its inherited copy from being reinserted.
        replaceInheritedGroupIds(sessionId: number, groupIds: number[]): void {
            const unique = [...new Set(groupIds)].filter((id) => Number.isInteger(id) && id > 0);
            db.transaction(() => {
                db.prepare("DELETE FROM session_groups WHERE session_id = ? AND inherited = 1").run(sessionId);
                const insert = db.prepare(
                    `INSERT INTO session_groups (session_id, group_id, inherited, created_at)
                     SELECT ?, ?, 1, ?
                      WHERE NOT EXISTS (
                          SELECT 1 FROM session_groups sg
                           WHERE sg.session_id = ? AND sg.group_id = ? AND sg.inherited = 0
                      )`,
                );
                const now = isoNow();
                for (const groupId of unique) insert.run(sessionId, groupId, now, sessionId, groupId);
            })();
        },

        // Groups attached to a session (source of truth : session_groups).
        getGroupIds(sessionId: number): number[] {
            return (
                db
                    .prepare(
                        `SELECT sg.group_id
                         FROM session_groups sg
                         JOIN groups g ON g.id = sg.group_id
                         WHERE sg.session_id = ?
                         ORDER BY g.name, sg.group_id`,
                    )
                    .all(sessionId) as Array<{ group_id: number }>
            ).map((row) => row.group_id);
        },

        // Memberships of all sessions (list enrichment in a single
        // query) : [session_id, group_ids].
        listAllGroupIds(): Array<[number, number[]]> {
            const rows = db
                .prepare(
                    `SELECT sg.session_id, sg.group_id
                     FROM session_groups sg
                     JOIN groups g ON g.id = sg.group_id
                     ORDER BY sg.session_id, g.name, sg.group_id`,
                )
                .all() as Array<{ session_id: number; group_id: number }>;
            const bySession = new Map<number, number[]>();
            for (const row of rows) {
                const list = bySession.get(row.session_id) ?? [];
                list.push(row.group_id);
                bySession.set(row.session_id, list);
            }
            return [...bySession.entries()];
        },

        findById(id: number): SessionRow | undefined {
            return db.prepare("SELECT * FROM app_sessions WHERE id = ?").get(id) as SessionRow | undefined;
        },

        // Session in progress (running status) — at most one (cf. start()).
        findActive(): SessionRow | undefined {
            return db.prepare("SELECT * FROM app_sessions WHERE status = 'running' LIMIT 1").get() as
                | SessionRow
                | undefined;
        },

        findByStatus(status: SessionStatus): SessionRow[] {
            return db.prepare("SELECT * FROM app_sessions WHERE status = ? ORDER BY scheduled_at DESC").all(status) as
                | SessionRow[];
        },

        // Occurrences generated by a series (migration 008), oldest first.
        findBySeries(seriesId: number): SessionRow[] {
            return db
                .prepare("SELECT * FROM app_sessions WHERE series_id = ? ORDER BY scheduled_at, id")
                .all(seriesId) as SessionRow[];
        },

        // The occurrence of a series on a given local date — the identity row
        // behind UNIQUE(series_id, occurrence_date) (generation idempotency
        // key : callers check-then-insert inside one transaction).
        findBySeriesAndDate(seriesId: number, occurrenceDate: string): SessionRow | undefined {
            return db
                .prepare("SELECT * FROM app_sessions WHERE series_id = ? AND occurrence_date = ?")
                .get(seriesId, occurrenceDate) as SessionRow | undefined;
        },

        // In-place schedule rewrite (series edited from an occurrence onward) :
        // the row keeps its id — and its session_participants / session_groups
        // rows, which an explicit per-occurrence override may have shaped.
        updateSchedule(id: number, patch: SchedulePatch): SessionRow | undefined {
            const sets: string[] = [];
            const params: (string | number)[] = [];
            const set = (column: string, value: string | number): void => {
                sets.push(`${column} = ?`);
                params.push(value);
            };
            if (patch.label !== undefined) set("label", patch.label);
            if (patch.scheduledAt !== undefined) set("scheduled_at", patch.scheduledAt);
            if (patch.localTime !== undefined) set("local_time", patch.localTime);
            if (patch.timezone !== undefined) set("timezone", patch.timezone);
            if (patch.durationMinutes !== undefined) set("duration_minutes", patch.durationMinutes);
            if (sets.length === 0) return this.findById(id);
            sets.push("updated_at = ?");
            params.push(isoNow(), id);
            db.prepare(`UPDATE app_sessions SET ${sets.join(", ")} WHERE id = ?`).run(...params);
            return this.findById(id);
        },

        // Stamps the moment the roster snapshot was captured (session_roster).
        // Writing the snapshot rows themselves is the roster repository's job.
        freezeRoster(id: number, frozenAt: string): SessionRow | undefined {
            db.prepare("UPDATE app_sessions SET roster_frozen_at = ?, updated_at = ? WHERE id = ?").run(
                frozenAt,
                frozenAt,
                id,
            );
            return this.findById(id);
        },

        findAll(): SessionRow[] {
            return db.prepare("SELECT * FROM app_sessions ORDER BY scheduled_at DESC").all() as SessionRow[];
        },

        // Starts a session : closes the previous running one (completed), like
        // sessionQueries.activate() in the legacy.
        start(id: number): SessionRow {
            return db.transaction(() => {
                const now = isoNow();
                db.prepare(
                    `UPDATE app_sessions SET status = 'completed', ended_at = ?, updated_at = ?
                     WHERE status = 'running' AND id != ?`,
                ).run(now, now, id);
                db.prepare(
                    `UPDATE app_sessions
                     SET status = 'running', started_at = COALESCE(started_at, ?), ended_at = NULL, updated_at = ?
                     WHERE id = ?`,
                ).run(now, now, id);
                return this.findById(id)!;
            })();
        },

        complete(id: number): SessionRow | undefined {
            const now = isoNow();
            db.prepare(
                `UPDATE app_sessions SET status = 'completed', ended_at = ?, updated_at = ?
                 WHERE id = ? AND status = 'running'`,
            ).run(now, now, id);
            return this.findById(id);
        },

        cancel(id: number): SessionRow | undefined {
            const now = isoNow();
            db.prepare(
                `UPDATE app_sessions SET status = 'cancelled', ended_at = ?, updated_at = ?
                 WHERE id = ? AND status IN ('scheduled', 'running')`,
            ).run(now, now, id);
            return this.findById(id);
        },

        // Reporting list (Phase 7): sessions matching the date/group/status
        // filters with per-session attendance and scan counters. present_count
        // counts app_attendances rows (attendance STATE — duplicate scans can
        // never inflate it), scan_count counts raw card_scans events.
        findForReport(filter: ReportSessionFilter): ReportSessionRow[] {
            const where: string[] = [];
            const params: (string | number)[] = [];
            if (filter.from !== undefined) {
                where.push("substr(s.scheduled_at, 1, 10) >= ?");
                params.push(filter.from);
            }
            if (filter.to !== undefined) {
                where.push("substr(s.scheduled_at, 1, 10) <= ?");
                params.push(filter.to);
            }
            if (filter.groupId !== undefined) {
                // A session matches the filter if ONE of its groups covers it.
                where.push("EXISTS (SELECT 1 FROM session_groups sg WHERE sg.session_id = s.id AND sg.group_id = ?)");
                params.push(filter.groupId);
            }
            if (filter.status !== undefined) {
                where.push("s.status = ?");
                params.push(filter.status);
            }
            const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
            return db
                .prepare(
                    `SELECT
                        s.*,
                        -- Names of the attached groups, alphabetically, joined
                        -- by ", " (null when the session has no group).
                        (SELECT group_concat(x.name, ', ')
                           FROM (SELECT g.name
                                   FROM session_groups sg
                                   JOIN groups g ON g.id = sg.group_id
                                  WHERE sg.session_id = s.id
                                   ORDER BY g.name) x)                                        AS group_name,
                         -- Username of the creator (NULL when unknown :
                         -- created before migration 007 or user deleted).
                         (SELECT u.username FROM users u WHERE u.id = s.created_by)          AS created_by_username,
                         (SELECT COUNT(*) FROM app_attendances a WHERE a.session_id = s.id)   AS present_count,
                        (SELECT COUNT(*) FROM card_scans sc WHERE sc.session_id = s.id)      AS scan_count
                     FROM app_sessions s
                     ${clause}
                     ORDER BY s.scheduled_at DESC, s.id DESC`,
                )
                .all(...params) as ReportSessionRow[];
        },

        // Calendar range (weekly planner) : INCLUSIVE bounds, matched per row —
        //   • series occurrences on their LOCAL identity occurrence_date
        //     (the calendar date in the SERIES timezone — the day the course
        //     really happens in the room, whatever UTC instant it maps to) ;
        //   • standalone sessions on substr(scheduled_at, 1, 10), the UTC
        //     calendar day (same semantics as the reporting filters).
        // participant_count = expected roster : frozen snapshot once
        // roster_frozen_at is set, otherwise the live membership of the row
        // (UNION of the session's groups + explicit inclusions, minus explicit
        // exclusions — a session without groups expects nobody, so its
        // expected count is 0 ; the legacy "accept everyone" rule is a scan
        // gate, never a list of people). Ordered chronologically (oldest
        // first) so the client can drop rows straight into a week grid.
        findForCalendar(from: string, to: string): CalendarSessionRow[] {
            return db
                .prepare(
                    `SELECT
                        s.*,
                        ss.label      AS series_label,
                        ss.status     AS series_status,
                        ss.recurrence AS series_recurrence,
                        (SELECT group_concat(x.name, ', ')
                           FROM (SELECT g.name
                                   FROM session_groups sg
                                   JOIN groups g ON g.id = sg.group_id
                                  WHERE sg.session_id = s.id
                                  ORDER BY g.name) x)                              AS group_name,
                        CASE WHEN s.roster_frozen_at IS NOT NULL THEN
                            (SELECT COUNT(*) FROM session_roster r WHERE r.session_id = s.id)
                        ELSE
                            (SELECT COUNT(*) FROM app_students stu
                              WHERE ${EXPECTED_MEMBERSHIP_CASE})
                        END                                                          AS participant_count
                     FROM app_sessions s
                     LEFT JOIN session_series ss ON ss.id = s.series_id
                     WHERE (s.occurrence_date IS NOT NULL
                                AND s.occurrence_date >= ? AND s.occurrence_date <= ?)
                        OR (s.occurrence_date IS NULL
                                AND substr(s.scheduled_at, 1, 10) >= ?
                                AND substr(s.scheduled_at, 1, 10) <= ?)
                     ORDER BY s.scheduled_at ASC, s.id ASC`,
                )
                .all(from, to, from, to) as CalendarSessionRow[];
        },

        // Is this student part of the session's EXPECTED scope ? Same rule as
        // the frozen roster : inclusion delta wins, then exclusion delta, then
        // plain membership in one of the session's groups. A session without
        // any group accepts everyone (pre-Phase-10 sessions). Without deltas
        // this reduces EXACTLY to the historical group check, so legacy
        // behavior is untouched.
        isExpectedParticipant(sessionId: number, studentId: number): boolean {
            const row = db
                .prepare(
                    `SELECT CASE
                                WHEN (SELECT COUNT(*) FROM session_groups sg
                                       WHERE sg.session_id = @session) = 0 THEN 1
                                WHEN (SELECT sp.included FROM session_participants sp
                                       WHERE sp.session_id = @session AND sp.student_id = @student) = 1 THEN 1
                                WHEN (SELECT sp.included FROM session_participants sp
                                       WHERE sp.session_id = @session AND sp.student_id = @student) = 0 THEN 0
                                ELSE (SELECT COUNT(*) FROM session_groups sg
                                       JOIN app_students stu ON stu.id = @student
                                       WHERE sg.session_id = @session AND sg.group_id = stu.group_id) > 0
                            END AS member`,
                )
                .get({ session: sessionId, student: studentId }) as { member: number };
            return row.member === 1;
        },
    };
}

export type SessionRepository = ReturnType<typeof createSessionRepository>;
