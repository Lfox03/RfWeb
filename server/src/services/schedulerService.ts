// Session scheduler — recurring-series generation + automatic start/stop.
//
// Periodic check (no timer persisted in the database); each tick:
//   0. rolling generation : every ACTIVE series materializes its occurrences
//      over the configured horizon (SERIES_HORIZON_WEEKS) — idempotent,
//      NEVER starts anything, and a failure NEVER blocks the steps below
//      (a per-series failure is already isolated inside generateAllActive,
//      a systemic one is caught and logged here as scheduler.generation_error);
//   1. running session whose window has elapsed (scheduled_at + duration)
//      → automatic stop (stop reason "auto_end");
//   2. no running session → the oldest "scheduled" session
//      whose WINDOW contains the current time (scheduled_at ≤ now < end)
//      → automatic start.
//
// Deliberate rules:
//   - the boot never invents nor starts a session : the initial generation
//     pass (runSeriesGeneration, called by startSessionScheduler) only
//     materializes SCHEDULED occurrences of active series — the start/stop
//     rules below alone decide what runs;
//   - a window that has already fully elapsed NEVER starts (no catch-up
//     after a downtime or a backdated creation);
//   - a manually stopped/cancelled session never restarts (its status
//     is no longer "scheduled");
//   - single reader: no start while a session is running (the
//     next attempt waits for the next tick);
//   - an early manual start remains possible; the automatic stop at
//     the end time still applies.

import { getClock } from "../core/clock";
import { errorFields, logger } from "../core/logger";
import { sessionRepository } from "../db";
import type { SessionRow } from "../db/types";
import * as seriesService from "./seriesService";
import * as sessionService from "./sessionService";

const schedulerLog = logger.child({ component: "scheduler" });

export const SCHEDULER_TICK_MS = 10_000;

interface Window {
    start: number;
    end: number;
}

// Window [scheduled_at, scheduled_at + duration) in epoch ms; null if
// scheduled_at is unreadable (external data).
function sessionWindow(session: SessionRow): Window | null {
    const start = Date.parse(session.scheduled_at);
    if (Number.isNaN(start)) return null;
    return { start, end: start + session.duration_minutes * 60_000 };
}

// Rolling horizon generation for every active series (tick step 0). Each
// series failure is already isolated inside generateAllActive (logged
// series.generation_failed) ; this outer guard keeps a systemic failure
// (schema, unreadable table) from ever escaping the tick. Generation only
// CREATES scheduled occurrences — it never starts or stops anything.
export function runSeriesGeneration(): void {
    try {
        seriesService.generateAllActive();
    } catch (err) {
        schedulerLog.error("scheduler.generation_error", errorFields(err, { stack: true }));
    }
}

// A full tick — exported as is to be tested without a timer (api:verify).
// The reference time is the ACTIVE clock (core/clock.ts): the system clock
// in production (the 10 s timer below), a FakeClock during api:verify —
// swapping it with setClock() time-travels every tick without any argument.
export function runSchedulerTick(now = getClock().now()): void {
    // Generation FIRST : a freshly materialized occurrence whose window
    // contains now may legitimately start on this very tick (and an elapsed
    // window still never does — the no-catch-up rule is untouched).
    runSeriesGeneration();

    const nowMs = now.getTime();

    const active = sessionRepository.findActive();
    if (active) {
        const win = sessionWindow(active);
        if (win && nowMs >= win.end) {
            try {
                sessionService.stop(active.id, "auto_end");
            } catch (err) {
                schedulerLog.debug("scheduler.auto_stop_refused", { session_id: active.id, ...errorFields(err) });
            }
        }
        return; // single reader: no start while a session is running
    }

    const candidates = sessionRepository
        .findByStatus("scheduled")
        .map((session) => ({ session, win: sessionWindow(session) }))
        .filter((entry): entry is { session: SessionRow; win: Window } => entry.win !== null)
        .filter(({ win }) => win.start <= nowMs && nowMs < win.end)
        .sort((a, b) => a.win.start - b.win.start);
    if (candidates.length === 0) return;

    const target = candidates[0].session;
    try {
        sessionService.start(target.id);
        schedulerLog.info("scheduler.auto_started", { session_id: target.id });
    } catch (err) {
        // Single-reader conflict or status changed in the meantime: the next
        // tick will re-evaluate, nothing more to log.
        schedulerLog.debug("scheduler.auto_start_refused", { session_id: target.id, ...errorFields(err) });
    }
}

let timer: NodeJS.Timeout | null = null;

// Starts the periodic check (called at server boot, never by
// createApp — api:verify drives runSchedulerTick manually). The rolling
// horizon is generated ONCE IMMEDIATELY (the server was possibly down for
// days — the plan must be materialized without waiting for the first
// tick), then at every tick. Generation never starts anything : boot stays
// idle w.r.t. session lifecycle.
export function startSessionScheduler(intervalMs = SCHEDULER_TICK_MS): void {
    if (timer) return;
    runSeriesGeneration();
    timer = setInterval(() => {
        try {
            runSchedulerTick();
        } catch (err) {
            schedulerLog.error("scheduler.tick_error", errorFields(err, { stack: true }));
        }
    }, intervalMs);
    timer.unref();
    schedulerLog.info("scheduler.started", { interval_seconds: intervalMs / 1000 });
}

export function stopSessionScheduler(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
}
