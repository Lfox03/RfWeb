// Recurring-session series service — the domain boundary for recurrence :
// occurrence GENERATION (series → concrete app_sessions rows) and series
// EDITING FROM A SELECTED OCCURRENCE ONWARD. Since Phase 3 the HTTP API
// (api/routers/series.ts) exposes creation/list/detail/edition/status and the
// scheduler (services/schedulerService) drives the rolling generation ;
// api:verify also drives these functions directly under the injected FakeClock.
//
// Generation (idempotent, rolling horizon) :
//   - only `active` series generate; `paused`/`cancelled` are no-ops ;
//   - candidate local dates = pattern matches (daily = every day, weekly = the
//     single weekday, JS getDay convention) inside the INCLUSIVE intersection
//     of [starts_on, ends_on], [today, today + horizon] — today is today IN THE
//     SERIES TIMEZONE, resolved through the ACTIVE clock (FakeClock-testable),
//     horizon = SERIES_HORIZON_WEEKS (default 12 weeks) ;
//   - an occurrence is identified by (series_id, occurrence_date) — the partial
//     UNIQUE index : a date that already has a row is NEVER touched (no
//     overwrite of existing occurrences, manual edits, cancellations or frozen
//     history), which makes repeated generation a no-op ;
//   - each new occurrence carries the local scheduling (local_time + timezone)
//     beside the authoritative UTC scheduled_at, converts the local wall-clock
//     time per occurrence (services/localTime) so the course keeps its INTENDED
//     local hour across DST transitions, copies the series' current default
//     groups into session_groups and its inclusion/exclusion deltas into
//     session_participants ;
//   - a nonexistent local time (spring-forward gap) NEVER shifts : the date is
//     skipped and reported (reason "nonexistent_local_time") ; an ambiguous
//     local time (fall-back overlap) deterministically takes its FIRST
//     occurrence.
//
// Edit from an occurrence onward (transactional — all or nothing) :
//   - occurrences strictly BEFORE the selected date keep everything (history) ;
//   - occurrences on/after it that are NOT `scheduled` (running, completed,
//     cancelled) are preserved untouched — only future scheduled occurrences
//     are eligible ;
//   - an eligible occurrence that still matches the edited pattern is REWRITTEN
//     IN PLACE (same id) ; when the patch changes the group scope or the
//     individual deltas, the occurrence's INHERITED copies (migration 009) are
//     synced to the new series scope while its EXPLICIT rows are preserved ;
//   - an eligible occurrence that no longer matches is CANCELLED (status
//     change, row and history kept — never deleted) ;
//   - dates newly required by the edited pattern (from the selected date,
//     today and the new starts_on onward, bounded by the rolling horizon) are
//     generated exactly like the initial generation, dates with an existing row
//     (any status) being skipped ;
//   - the series row itself is rewritten (the template now describes the plan
//     from that date on) ; `cancelled` series refuse edits.
//
// SCHEMA PROVENANCE (migration 009) : session_groups and session_participants
// rows copied at generation carry inherited = 1. A « this and following » edit
// that changes the group scope or the individual deltas therefore propagates
// to every FUTURE scheduled occurrence it rewrites : the inherited copies are
// replaced by the new series scope, while EXPLICIT per-occurrence rows
// (inherited = 0 — manual overrides, and every row predating migration 009)
// always survive untouched and even veto the reinsertion of the same
// (occurrence, student|group) pair.

import { getClock } from "../core/clock";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors";
import { errorFields, logger } from "../core/logger";
import { SERIES_HORIZON_WEEKS } from "../config/env";
import { broadcastEvent } from "../websocket/hub";
import {
    db,
    groupRepository,
    sessionParticipantRepository,
    sessionRepository,
    sessionSeriesRepository,
    studentRepository,
} from "../db";
import type {
    RecurrencePattern,
    SeriesStatus,
    SessionSeriesParticipantRow,
    SessionSeriesRow,
    SessionRow,
} from "../db/types";
import {
    addLocalDays,
    isValidIanaTimezone,
    isValidLocalDate,
    localDateInZone,
    parseLocalTime,
    weekdayOfLocalDate,
    zonedTimeToUtc,
} from "./localTime";

const seriesLog = logger.child({ component: "series" });

// Comparison sentinel for open-ended series (ends_on NULL).
const OPEN_END = "9999-12-31";

// Fully validated scheduling template (the merged result of a patch, or the
// input of a creation) — what a generation or an edit reasons about.
interface Template {
    label: string;
    recurrence: RecurrencePattern;
    weekday: number | null;
    localTime: string;
    timezone: string;
    durationMinutes: number;
    startsOn: string;
    endsOn: string | null;
}

export interface NewSeriesInput extends Partial<Omit<Template, "label" | "localTime" | "startsOn">> {
    label: string;
    localTime: string;
    startsOn: string;
    groupIds: number[];
    participants?: Array<{ studentId: number; included: boolean }>;
    createdBy?: number | null;
}

export type SeriesPatch = Partial<Template> & {
    groupIds?: number[];
    // Since Phase 5 (migration 009) : replacement of the whole delta set.
    // The series' inherited copies on future scheduled occurrences are
    // synced ; explicit per-occurrence rows always survive.
    participants?: Array<{ studentId: number; included: boolean }>;
};

export interface OccurrenceSkip {
    occurrence_date: string;
    reason: "nonexistent_local_time";
}

export interface GenerationResult {
    series_id: number;
    created: number[];
    existing: number;
    skipped: OccurrenceSkip[];
}

export interface SeriesEditResult {
    series: SessionSeriesRow;
    updated: number[];
    cancelled: number[];
    created: number[];
    skipped: OccurrenceSkip[];
    preserved: number[];
}

// ─── Validation ────────────────────────────────────────────────────────────────

// Strict calendar/time/timezone validation — SQLite's date() NORMALIZES
// impossible days (date('2026-02-30') → '2026-03-02'), so the migration 008
// CHECKs cannot be the guard : the service rejects them first.
function assertValidTemplate(tpl: Template): void {
    if (typeof tpl.label !== "string" || tpl.label.trim() === "") {
        throw new ValidationError("Le libellé de la série est obligatoire.");
    }
    if (tpl.recurrence !== "daily" && tpl.recurrence !== "weekly") {
        throw new ValidationError("Récurrence invalide : « daily » ou « weekly » attendu.");
    }
    if (tpl.recurrence === "weekly") {
        if (!Number.isInteger(tpl.weekday) || (tpl.weekday as number) < 0 || (tpl.weekday as number) > 6) {
            throw new ValidationError("Un patron hebdomadaire exige un jour de semaine (0 = dimanche … 6 = samedi).");
        }
    } else if (tpl.weekday !== null && tpl.weekday !== undefined) {
        throw new ValidationError("Un patron quotidien ne porte pas de jour de semaine.");
    }
    if (typeof tpl.localTime !== "string" || !parseLocalTime(tpl.localTime)) {
        throw new ValidationError("Heure locale invalide : format « HH:MM » attendu.");
    }
    if (typeof tpl.timezone !== "string" || !isValidIanaTimezone(tpl.timezone)) {
        throw new ValidationError(`Fuseau horaire IANA invalide : ${JSON.stringify(tpl.timezone)}.`);
    }
    if (!Number.isInteger(tpl.durationMinutes) || (tpl.durationMinutes as number) <= 0) {
        throw new ValidationError("La durée (minutes) doit être un entier positif.");
    }
    if (typeof tpl.startsOn !== "string" || !isValidLocalDate(tpl.startsOn)) {
        throw new ValidationError("Date de début invalide : format « YYYY-MM-DD » (calendrier grégorien) attendu.");
    }
    if (tpl.endsOn !== null && tpl.endsOn !== undefined) {
        if (!isValidLocalDate(tpl.endsOn)) {
            throw new ValidationError("Date de fin invalide : format « YYYY-MM-DD » (calendrier grégorien) attendu.");
        }
        if (tpl.endsOn < tpl.startsOn) {
            throw new ValidationError("La date de fin ne peut pas précéder la date de début.");
        }
    }
}

function resolveHorizonWeeks(option: number | undefined): number {
    const weeks = option ?? SERIES_HORIZON_WEEKS;
    if (!Number.isInteger(weeks) || weeks < 1) {
        throw new ValidationError("L'horizon de génération (semaines) doit être un entier positif.");
    }
    return weeks;
}

function loadSeries(seriesId: number): SessionSeriesRow {
    const series = sessionSeriesRepository.findById(seriesId);
    if (!series) throw new NotFoundError("Série");
    return series;
}

function assertGroupsExist(groupIds: number[]): void {
    if (groupIds.length === 0) {
        throw new ValidationError("Sélectionnez au moins un groupe pour la série.");
    }
    for (const groupId of groupIds) {
        if (!Number.isInteger(groupId) || groupId < 1 || !groupRepository.findById(groupId)) {
            throw new ValidationError(`Groupe ${groupId} introuvable.`);
        }
    }
}

// Individual inclusion/exclusion deltas : every referenced student must
// exist (duplicates are tolerated — the repository upserts, LAST wins).
function assertParticipantsExist(participants: Array<{ studentId: number; included: boolean }>): void {
    for (const p of participants) {
        if (!Number.isInteger(p.studentId) || p.studentId < 1 || !studentRepository.findById(p.studentId)) {
            throw new ValidationError(`Étudiant ${p.studentId} introuvable.`);
        }
    }
}

// The ONE calendar clients care about : every template change is announced so
// connected planners resync their grid (debounced client-side). Never throws.
function broadcastSeriesChange(
    action: "created" | "edited" | "paused" | "resumed" | "cancelled" | "generated",
    seriesId: number,
    occurrences?: number,
): void {
    broadcastEvent("series:changed", {
        action,
        series_id: seriesId,
        ...(occurrences !== undefined ? { occurrences } : {}),
    });
}

// Local dates a template covers between two (inclusive) local dates, in order.
function patternDates(tpl: Template, from: string, through: string): string[] {
    const dates: string[] = [];
    if (from > through) return dates;
    let date = from;
    while (date <= through) {
        const covered =
            (!tpl.startsOn || date >= tpl.startsOn) &&
            (!tpl.endsOn || date <= tpl.endsOn) &&
            (tpl.recurrence === "daily" || weekdayOfLocalDate(date) === tpl.weekday);
        if (covered) dates.push(date);
        date = addLocalDays(date, 1);
    }
    return dates;
}

// Generation/edit horizon for a series, anchored on the ACTIVE clock and
// expressed in the series' own timezone.
function horizonWindow(tz: string, horizonWeeks: number): { today: string; horizonEnd: string } {
    const today = localDateInZone(getClock().now().getTime(), tz);
    return { today, horizonEnd: addLocalDays(today, horizonWeeks * 7) };
}

// ─── Creation and status ───────────────────────────────────────────────────────

export function createSeries(input: NewSeriesInput): SessionSeriesRow {
    const tpl: Template = {
        label: input.label,
        recurrence: input.recurrence ?? "weekly",
        weekday: input.weekday ?? null,
        localTime: input.localTime,
        timezone: input.timezone ?? "UTC",
        durationMinutes: input.durationMinutes ?? 10,
        startsOn: input.startsOn,
        endsOn: input.endsOn ?? null,
    };
    assertValidTemplate(tpl);
    assertGroupsExist(input.groupIds);
    assertParticipantsExist(input.participants ?? []);
    const series = sessionSeriesRepository.create({
        label: tpl.label.trim(),
        recurrence: tpl.recurrence,
        weekday: tpl.recurrence === "weekly" ? tpl.weekday : null,
        localTime: tpl.localTime,
        timezone: tpl.timezone,
        durationMinutes: tpl.durationMinutes,
        startsOn: tpl.startsOn,
        endsOn: tpl.endsOn,
        groupIds: [...new Set(input.groupIds)],
        participants: input.participants,
        createdBy: input.createdBy ?? null,
    });
    seriesLog.info("series.created", {
        series_id: series.id,
        recurrence: series.recurrence,
        weekday: series.weekday,
        timezone: series.timezone,
    });
    broadcastSeriesChange("created", series.id);
    return series;
}

// Series + its group scope (HTTP shape mirror of SessionWithGroups).
export interface SeriesWithGroups extends SessionSeriesRow {
    group_ids: number[];
}

// Series detail : group scope + individual inclusion/exclusion deltas.
export interface SeriesDetail extends SeriesWithGroups {
    participants: SessionSeriesParticipantRow[];
}

export function listSeries(): SeriesWithGroups[] {
    return sessionSeriesRepository.findAll().map((series) => ({
        ...series,
        group_ids: sessionSeriesRepository.getGroupIds(series.id),
    }));
}

export function getSeries(seriesId: number): SeriesDetail {
    const series = loadSeries(seriesId);
    return {
        ...series,
        group_ids: sessionSeriesRepository.getGroupIds(series.id),
        participants: sessionSeriesRepository.listParticipants(series.id),
    };
}

// State machine : cancelled is terminal (occurrences keep their own lifecycle).
// `broadcast` may be disabled by cancelSeries, which emits its own richer
// "cancelled" event once the future occurrences have been cleared too.
export function setSeriesStatus(
    seriesId: number,
    next: SeriesStatus,
    options: { broadcast?: boolean } = {},
): SessionSeriesRow {
    const series = loadSeries(seriesId);
    if (series.status === "cancelled") {
        throw new ConflictError("SERIES_CANCELLED", "Impossible de modifier une série annulée.");
    }
    if (next !== "active" && next !== "paused" && next !== "cancelled") {
        throw new ValidationError("Statut de série invalide.");
    }
    const updated = sessionSeriesRepository.setStatus(seriesId, next)!;
    seriesLog.info("series.status_changed", { series_id: seriesId, from: series.status, to: next });
    if (options.broadcast !== false) {
        broadcastSeriesChange(next === "active" ? "resumed" : next === "paused" ? "paused" : "cancelled", seriesId);
    }
    return updated;
}

// ─── Generation ────────────────────────────────────────────────────────────────

export function generateOccurrences(
    seriesId: number,
    options: { horizonWeeks?: number } = {},
): GenerationResult {
    const series = loadSeries(seriesId);
    const horizonWeeks = resolveHorizonWeeks(options.horizonWeeks);
    if (series.status !== "active") {
        // paused/cancelled never generate (explicit no-op, same for both).
        return { series_id: seriesId, created: [], existing: 0, skipped: [] };
    }

    const tpl: Template = {
        label: series.label,
        recurrence: series.recurrence,
        weekday: series.weekday,
        localTime: series.local_time,
        timezone: series.timezone,
        durationMinutes: series.duration_minutes,
        startsOn: series.starts_on,
        endsOn: series.ends_on,
    };
    const { today, horizonEnd } = horizonWindow(tpl.timezone, horizonWeeks);
    const dates = patternDates(tpl, maxDate(tpl.startsOn, today), minDate(tpl.endsOn, horizonEnd));

    const groupIds = sessionSeriesRepository.getGroupIds(seriesId);
    const participants = sessionSeriesRepository.listParticipants(seriesId);

    const result: GenerationResult = { series_id: seriesId, created: [], existing: 0, skipped: [] };
    db.transaction(() => {
        for (const date of dates) {
            if (sessionRepository.findBySeriesAndDate(seriesId, date)) {
                result.existing += 1; // idempotency : an existing row is never rewritten
                continue;
            }
            const resolved = zonedTimeToUtc(date, tpl.localTime, tpl.timezone);
            if (resolved.instantMs === null) {
                // Spring-forward gap : skipping is explicit and reported —
                // the course is never silently shifted.
                result.skipped.push({ occurrence_date: date, reason: "nonexistent_local_time" });
                continue;
            }
            const session = sessionRepository.create({
                label: tpl.label,
                scheduledAt: new Date(resolved.instantMs).toISOString(),
                durationMinutes: tpl.durationMinutes,
                createdBy: series.created_by,
                groupIds,
                seriesId,
                occurrenceDate: date,
                localTime: tpl.localTime,
                timezone: tpl.timezone,
            });
            for (const delta of participants) {
                sessionParticipantRepository.upsert(session.id, delta.student_id, delta.included === 1, true);
            }
            result.created.push(session.id);
        }
    })();

    if (result.created.length > 0 || result.skipped.length > 0) {
        seriesLog.info("series.occurrences_generated", {
            series_id: seriesId,
            created: result.created.length,
            existing: result.existing,
            skipped: result.skipped.length,
        });
    }
    // Planning clients watch the grid : a rolling-horizon pass that actually
    // materialized rows is worth a debounced resync (an idle pass, never).
    if (result.created.length > 0) broadcastSeriesChange("generated", seriesId, result.created.length);
    return result;
}

// Rolling generation for every active series (the future scheduler tick hook).
// A broken series (e.g. a timezone manually edited to garbage) never blocks
// the others.
export function generateAllActive(options: { horizonWeeks?: number } = {}): GenerationResult[] {
    const results: GenerationResult[] = [];
    for (const series of sessionSeriesRepository.findByStatus("active")) {
        try {
            results.push(generateOccurrences(series.id, options));
        } catch (err) {
            seriesLog.warn("series.generation_failed", { series_id: series.id, ...errorFields(err) });
        }
    }
    return results;
}

// ─── Edit from a selected occurrence onward ───────────────────────────────────

export function editSeriesFrom(
    seriesId: number,
    fromDate: string,
    patch: SeriesPatch,
    options: { horizonWeeks?: number } = {},
): SeriesEditResult {
    const series = loadSeries(seriesId);
    if (series.status === "cancelled") {
        throw new ConflictError("SERIES_CANCELLED", "Impossible de modifier une série annulée.");
    }
    if (typeof fromDate !== "string" || !isValidLocalDate(fromDate)) {
        throw new ValidationError("Date d'occurrence invalide : format « YYYY-MM-DD » attendu.");
    }
    const anchor = sessionRepository.findBySeriesAndDate(seriesId, fromDate);
    if (!anchor) throw new NotFoundError("Occurrence de série");

    // Merge patch over the current template, then validate the WHOLE result.
    const recurrence = patch.recurrence ?? series.recurrence;
    const tpl: Template = {
        label: patch.label ?? series.label,
        recurrence,
        weekday:
            recurrence === "weekly"
                ? patch.weekday !== undefined
                    ? patch.weekday
                    : series.weekday
                : null,
        localTime: patch.localTime ?? series.local_time,
        timezone: patch.timezone ?? series.timezone,
        durationMinutes: patch.durationMinutes ?? series.duration_minutes,
        startsOn: patch.startsOn ?? series.starts_on,
        endsOn: patch.endsOn !== undefined ? patch.endsOn : series.ends_on,
    };
    assertValidTemplate(tpl);
    if (patch.groupIds !== undefined) assertGroupsExist(patch.groupIds);
    if (patch.participants !== undefined) assertParticipantsExist(patch.participants);
    const horizonWeeks = resolveHorizonWeeks(options.horizonWeeks);

    // Membership scope rewrite (Phase 5) : when the patch touches the group
    // scope or the individual deltas, every future scheduled occurrence the
    // edit rewrites also sees its INHERITED copies synced to the new scope
    // (explicit per-occurrence rows always survive — migration 009).
    const newGroupIds = patch.groupIds !== undefined ? [...new Set(patch.groupIds)] : undefined;
    const newDeltas =
        patch.participants !== undefined
            ? [...dedupeDeltas(patch.participants).entries()].map(([studentId, included]) => ({
                  studentId,
                  included,
              }))
            : undefined;
    const scopeChanged = newGroupIds !== undefined || newDeltas !== undefined;

    const result = db.transaction(() => {
        const updatedSeries = sessionSeriesRepository.update(seriesId, {
            label: tpl.label.trim(),
            recurrence: tpl.recurrence,
            weekday: tpl.recurrence === "weekly" ? tpl.weekday : null,
            localTime: tpl.localTime,
            timezone: tpl.timezone,
            durationMinutes: tpl.durationMinutes,
            startsOn: tpl.startsOn,
            endsOn: tpl.endsOn,
        })!;
        if (newGroupIds !== undefined) {
            sessionSeriesRepository.setGroupIds(seriesId, newGroupIds);
        }
        if (newDeltas !== undefined) {
            sessionSeriesRepository.replaceParticipants(seriesId, newDeltas);
        }

        const outcome: Omit<SeriesEditResult, "series"> = {
            updated: [],
            cancelled: [],
            created: [],
            skipped: [],
            preserved: [],
        };

        // 1) Existing occurrences on/after the anchor date.
        for (const occurrence of sessionRepository.findBySeries(seriesId)) {
            const date = occurrence.occurrence_date;
            if (date === null || date < fromDate) continue; // strictly-past : untouched
            if (occurrence.status !== "scheduled") {
                outcome.preserved.push(occurrence.id); // running / completed / cancelled
                continue;
            }
            if (matchesTemplate(tpl, date)) {
                const resolved = zonedTimeToUtc(date, tpl.localTime, tpl.timezone);
                if (resolved.instantMs === null) {
                    // The edited local time does not exist on that date : the
                    // occurrence is cancelled (never shifted), history kept.
                    sessionRepository.cancel(occurrence.id);
                    outcome.cancelled.push(occurrence.id);
                    outcome.skipped.push({ occurrence_date: date, reason: "nonexistent_local_time" });
                    continue;
                }
                // In-place rewrite : SAME id, series identity (occurrence_date)
                // kept. Scheduling fields follow the new template ; the
                // membership rows are synced ONLY when this edit changed the
                // scope, and only their INHERITED copies — an explicit
                // per-occurrence override is never rewritten.
                sessionRepository.updateSchedule(occurrence.id, {
                    label: tpl.label.trim(),
                    scheduledAt: new Date(resolved.instantMs).toISOString(),
                    localTime: tpl.localTime,
                    timezone: tpl.timezone,
                    durationMinutes: tpl.durationMinutes,
                });
                if (scopeChanged) {
                    if (newGroupIds !== undefined) {
                        sessionRepository.replaceInheritedGroupIds(occurrence.id, newGroupIds);
                    }
                    if (newDeltas !== undefined) {
                        sessionParticipantRepository.syncInherited(occurrence.id, newDeltas);
                    }
                }
                outcome.updated.push(occurrence.id);
            } else {
                // No longer part of the plan : cancelled, never deleted.
                sessionRepository.cancel(occurrence.id);
                outcome.cancelled.push(occurrence.id);
            }
        }

        // 2) Newly required dates from the anchor on (active series only :
        //    a paused series keeps its plan but materializes nothing new).
        if (updatedSeries.status === "active") {
            const { today, horizonEnd } = horizonWindow(tpl.timezone, horizonWeeks);
            const from = maxDate(fromDate, today, tpl.startsOn);
            const candidates = patternDates(tpl, from, minDate(tpl.endsOn, horizonEnd));
            const groupIds = sessionSeriesRepository.getGroupIds(seriesId);
            const participants = sessionSeriesRepository.listParticipants(seriesId);
            for (const date of candidates) {
                if (sessionRepository.findBySeriesAndDate(seriesId, date)) continue;
                const resolved = zonedTimeToUtc(date, tpl.localTime, tpl.timezone);
                if (resolved.instantMs === null) {
                    outcome.skipped.push({ occurrence_date: date, reason: "nonexistent_local_time" });
                    continue;
                }
                const session = sessionRepository.create({
                    label: tpl.label.trim(),
                    scheduledAt: new Date(resolved.instantMs).toISOString(),
                    durationMinutes: tpl.durationMinutes,
                    createdBy: updatedSeries.created_by,
                    groupIds,
                    seriesId,
                    occurrenceDate: date,
                    localTime: tpl.localTime,
                    timezone: tpl.timezone,
                });
                for (const delta of participants) {
                    sessionParticipantRepository.upsert(session.id, delta.student_id, delta.included === 1, true);
                }
                outcome.created.push(session.id);
            }
        }

        return outcome;
    })();

    const editedSeries = sessionSeriesRepository.findById(seriesId)!;
    seriesLog.info("series.edited", {
        series_id: seriesId,
        from_date: fromDate,
        updated: result.updated.length,
        cancelled: result.cancelled.length,
        created: result.created.length,
        preserved: result.preserved.length,
    });
    broadcastSeriesChange("edited", seriesId, result.updated.length + result.created.length);
    return { series: editedSeries, ...result };
}

// Cancellation of the future scheduled occurrences of a series (used by
// cancelSeries below, and exported for callers that want to clear the planned
// future WITHOUT ending the template — pausing it instead).
export function cancelFutureOccurrences(seriesId: number, fromDate: string): number[] {
    const series = loadSeries(seriesId);
    if (!isValidLocalDate(fromDate)) throw new ValidationError("Date invalide : format « YYYY-MM-DD » attendu.");
    const cancelled: number[] = [];
    db.transaction(() => {
        for (const occurrence of sessionRepository.findBySeries(series.id)) {
            if (occurrence.occurrence_date !== null && occurrence.occurrence_date >= fromDate) {
                if (occurrence.status === "scheduled") {
                    sessionRepository.cancel(occurrence.id);
                    cancelled.push(occurrence.id);
                }
            }
        }
    })();
    if (cancelled.length > 0) {
        seriesLog.info("series.future_cancelled", { series_id: series.id, from_date: fromDate, count: cancelled.length });
    }
    return cancelled;
}

export interface SeriesCancellation {
    series: SessionSeriesRow;
    cancelled: number[];
}

// Cancelling a SERIES is one explicit decision with two effects : the template
// becomes terminal (`cancelled`, refused by setSeriesStatus if already so) AND
// its still-planned future is cleared — every occurrence from `fromDate` on
// that is still `scheduled` is cancelled. running / completed / already
// cancelled occurrences and ALL attendance history are preserved
// (cancelFutureOccurrences only ever touches scheduled rows). `fromDate`
// defaults to TODAY IN THE SERIES TIMEZONE — the same anchor generation uses.
export function cancelSeries(seriesId: number, fromDate?: string): SeriesCancellation {
    const series = loadSeries(seriesId);
    if (fromDate !== undefined && !isValidLocalDate(fromDate)) {
        throw new ValidationError("Date invalide : format « YYYY-MM-DD » attendu.");
    }
    const updated = setSeriesStatus(seriesId, "cancelled", { broadcast: false });
    const from = fromDate ?? localDateInZone(getClock().now().getTime(), series.timezone);
    const cancelled = cancelFutureOccurrences(seriesId, from);
    broadcastSeriesChange("cancelled", seriesId, cancelled.length);
    return { series: updated, cancelled };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

// Duplicate studentIds in a submitted delta list : LAST occurrence wins
// (same resolution as the repository upsert) instead of erroring out.
function dedupeDeltas(
    participants: Array<{ studentId: number; included: boolean }>,
): Map<number, boolean> {
    const map = new Map<number, boolean>();
    for (const p of participants) map.set(p.studentId, p.included);
    return map;
}

function matchesTemplate(tpl: Template, date: string): boolean {
    if (date < tpl.startsOn) return false;
    if (tpl.endsOn !== null && date > tpl.endsOn) return false;
    return tpl.recurrence === "daily" || weekdayOfLocalDate(date) === tpl.weekday;
}

function maxDate(...dates: string[]): string {
    return dates.reduce((a, b) => (a >= b ? a : b));
}

function minDate(a: string | null, b: string): string {
    const left = a ?? OPEN_END;
    return left <= b ? left : b;
}

// Session rows of a series in the local-date sense (read helper exported for
// API/verify convenience — occurrence rows only, oldest first).
export function listOccurrences(seriesId: number): SessionRow[] {
    return sessionRepository.findBySeries(seriesId);
}
