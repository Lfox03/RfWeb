// « Session series » repository — recurrence templates (migration 008).
//
// One row of session_series = one recurring plan (pattern + local time +
// timezone + duration + inclusive local date range). The group scope lives
// in session_series_groups (same shape as session_groups) and the individual
// inclusion/exclusion deltas in session_series_participants.
//
// Pure persistence: deciding WHICH occurrences a pattern generates, and what
// the statuses mean, belongs to the services — not to this layer.

import type { DatabaseHandle } from "../database";
import { isoNow } from "../types";
import type {
    RecurrencePattern,
    SeriesStatus,
    SessionSeriesGroupRow,
    SessionSeriesParticipantRow,
    SessionSeriesRow,
} from "../types";

export interface NewSessionSeries {
    label: string;
    recurrence?: RecurrencePattern; // DEFAULT 'weekly' in the schema
    weekday?: number | null; // 0 = Sunday … 6 = Saturday, required when weekly
    localTime: string; // 'HH:MM' wall clock in the timezone below
    timezone?: string; // IANA, DEFAULT 'UTC' in the schema
    durationMinutes?: number;
    startsOn: string; // 'YYYY-MM-DD' local, inclusive
    endsOn?: string | null; // 'YYYY-MM-DD' local, inclusive (NULL = open)
    groupIds?: number[];
    // Individual inclusion/exclusion deltas (included = 1 in, 0 out).
    participants?: Array<{ studentId: number; included: boolean }>;
    createdBy?: number | null;
}

export function createSessionSeriesRepository(db: DatabaseHandle) {
    return {
        // Inserts the template and its group memberships in one transaction.
        create(input: NewSessionSeries): SessionSeriesRow {
            const groupIds = [...new Set(input.groupIds ?? [])].filter(
                (id): id is number => Number.isInteger(id) && id > 0,
            );
            return db.transaction(() => {
                const info = db
                    .prepare(
                        `INSERT INTO session_series
                             (label, recurrence, weekday, local_time, timezone,
                              duration_minutes, starts_on, ends_on, created_by)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    )
                    .run(
                        input.label,
                        input.recurrence ?? "weekly",
                        input.weekday ?? null,
                        input.localTime,
                        input.timezone ?? "UTC",
                        input.durationMinutes ?? 10,
                        input.startsOn,
                        input.endsOn ?? null,
                        input.createdBy ?? null,
                    );
                const seriesId = Number(info.lastInsertRowid);
                const insertMembership = db.prepare(
                    "INSERT INTO session_series_groups (series_id, group_id, created_at) VALUES (?, ?, ?)",
                );
                const now = isoNow();
                for (const groupId of groupIds) insertMembership.run(seriesId, groupId, now);
                const insertParticipant = db.prepare(
                    `INSERT INTO session_series_participants (series_id, student_id, included, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?)
                     ON CONFLICT (series_id, student_id)
                     DO UPDATE SET included = excluded.included, updated_at = excluded.updated_at`,
                );
                for (const p of input.participants ?? []) {
                    insertParticipant.run(seriesId, p.studentId, p.included ? 1 : 0, now, now);
                }
                return this.findById(seriesId)!;
            })();
        },

        findById(id: number): SessionSeriesRow | undefined {
            return db.prepare("SELECT * FROM session_series WHERE id = ?").get(id) as
                | SessionSeriesRow
                | undefined;
        },

        findAll(): SessionSeriesRow[] {
            return db.prepare("SELECT * FROM session_series ORDER BY created_at DESC, id DESC").all() as
                | SessionSeriesRow[];
        },

        findByStatus(status: SeriesStatus): SessionSeriesRow[] {
            return db.prepare("SELECT * FROM session_series WHERE status = ? ORDER BY starts_on, id").all(status) as
                | SessionSeriesRow[];
        },

        // Template rewrite (SQL only) : the service decides WHEN a rewrite is
        // legal and which occurrences it implies. `null` clears ends_on
        // (open-ended); `undefined` leaves a column untouched.
        update(
            id: number,
            patch: {
                label?: string;
                recurrence?: RecurrencePattern;
                weekday?: number | null;
                localTime?: string;
                timezone?: string;
                durationMinutes?: number;
                startsOn?: string;
                endsOn?: string | null;
            },
        ): SessionSeriesRow | undefined {
            const columns: Array<[string, string | number | null]> = [];
            if (patch.label !== undefined) columns.push(["label", patch.label]);
            if (patch.recurrence !== undefined) columns.push(["recurrence", patch.recurrence]);
            if (patch.weekday !== undefined) columns.push(["weekday", patch.weekday]);
            if (patch.localTime !== undefined) columns.push(["local_time", patch.localTime]);
            if (patch.timezone !== undefined) columns.push(["timezone", patch.timezone]);
            if (patch.durationMinutes !== undefined) columns.push(["duration_minutes", patch.durationMinutes]);
            if (patch.startsOn !== undefined) columns.push(["starts_on", patch.startsOn]);
            if (patch.endsOn !== undefined) columns.push(["ends_on", patch.endsOn]);
            if (columns.length === 0) return this.findById(id);
            const sets = columns.map(([column]) => `${column} = ?`).join(", ");
            db.prepare(`UPDATE session_series SET ${sets}, updated_at = ? WHERE id = ?`).run(
                ...columns.map(([, value]) => value),
                isoNow(),
                id,
            );
            return this.findById(id);
        },

        // The status column is free-form here on purpose (any of the three
        // CHECK values) — deciding which transitions are legal is service
        // territory, like the session state machine.
        setStatus(id: number, status: SeriesStatus): SessionSeriesRow | undefined {
            db.prepare("UPDATE session_series SET status = ?, updated_at = ? WHERE id = ?").run(
                status,
                isoNow(),
                id,
            );
            return this.findById(id);
        },

        // ─── Group scope (session_series_groups) ─────────────────────────────
        getGroupIds(seriesId: number): number[] {
            return (
                db
                    .prepare(
                        `SELECT ssg.group_id
                         FROM session_series_groups ssg
                         JOIN groups g ON g.id = ssg.group_id
                         WHERE ssg.series_id = ?
                         ORDER BY g.name, ssg.group_id`,
                    )
                    .all(seriesId) as Array<{ group_id: number }>
            ).map((row) => row.group_id);
        },

        // Replaces the whole membership set of a series in one transaction
        // (the caller decides when a rewrite is allowed — not this layer).
        setGroupIds(seriesId: number, groupIds: number[]): void {
            const unique = [...new Set(groupIds)].filter((id) => Number.isInteger(id) && id > 0);
            db.transaction(() => {
                db.prepare("DELETE FROM session_series_groups WHERE series_id = ?").run(seriesId);
                const insert = db.prepare(
                    "INSERT INTO session_series_groups (series_id, group_id, created_at) VALUES (?, ?, ?)",
                );
                const now = isoNow();
                for (const groupId of unique) insert.run(seriesId, groupId, now);
            })();
        },

        listGroupMemberships(): SessionSeriesGroupRow[] {
            return db
                .prepare("SELECT series_id, group_id, created_at FROM session_series_groups ORDER BY series_id, group_id")
                .all() as SessionSeriesGroupRow[];
        },

        // ─── Individual deltas (session_series_participants) ─────────────────
        listParticipants(seriesId: number): SessionSeriesParticipantRow[] {
            return db
                .prepare(
                    "SELECT * FROM session_series_participants WHERE series_id = ? ORDER BY student_id",
                )
                .all(seriesId) as SessionSeriesParticipantRow[];
        },

        upsertParticipant(seriesId: number, studentId: number, included: boolean): void {
            const now = isoNow();
            db.prepare(
                `INSERT INTO session_series_participants (series_id, student_id, included, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (series_id, student_id)
                 DO UPDATE SET included = excluded.included, updated_at = excluded.updated_at`,
            ).run(seriesId, studentId, included ? 1 : 0, now, now);
        },

        // Replaces the whole delta set of a series in one transaction (the
        // « this and following » edit — the service decides when this is
        // legal and which occurrences inherit the result).
        replaceParticipants(
            seriesId: number,
            deltas: Array<{ studentId: number; included: boolean }>,
        ): void {
            db.transaction(() => {
                db.prepare("DELETE FROM session_series_participants WHERE series_id = ?").run(seriesId);
                const insert = db.prepare(
                    `INSERT INTO session_series_participants (series_id, student_id, included, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?)
                     ON CONFLICT (series_id, student_id)
                     DO UPDATE SET included = excluded.included, updated_at = excluded.updated_at`,
                );
                const now = isoNow();
                for (const delta of deltas) {
                    insert.run(seriesId, delta.studentId, delta.included ? 1 : 0, now, now);
                }
            })();
        },

        removeParticipant(seriesId: number, studentId: number): boolean {
            return (
                db
                    .prepare("DELETE FROM session_series_participants WHERE series_id = ? AND student_id = ?")
                    .run(seriesId, studentId).changes > 0
            );
        },
    };
}

export type SessionSeriesRepository = ReturnType<typeof createSessionSeriesRepository>;
