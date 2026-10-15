// Attendance sessions service — explicit state machine, no more
// hardcoded sessions at startup.
//
// Allowed transitions:
//   scheduled → running   (start — atomically FREEZES the expected roster
//                          into session_roster and stamps roster_frozen_at,
//                          in the SAME SQLite transaction as the transition)
//   scheduled → cancelled (cancel)
//   running   → completed (stop)
//   running   → cancelled (cancel)
// Everything else is refused (ConflictError 409). Single reader: at most one
// running session; starting a session while another is active is
// refused (explicit stop required), the repository keeping the transactional guard.

import { NotFoundError, SessionStateError, ValidationError } from "../core/errors";
import { logger } from "../core/logger";
import {
    db,
    groupRepository,
    sessionRepository,
    sessionRosterRepository,
    userRepository,
} from "../db";
import { isoNow } from "../db/types";
import type { SessionRow } from "../db/types";
import type { CalendarSessionRow } from "../db/repositories/sessions";
import { broadcastEvent } from "../websocket/hub";
import { startScan, stopScan } from "./scanService";

const sessionLog = logger.child({ component: "session" });

// Session + group scope (session_groups association table) + creator username
// (NULL when unknown : created before migration 007 or user deleted).
// Exposed as is by the API and the WebSocket (the client filters the
// student lists with group_ids).
export interface SessionWithGroups extends SessionRow {
    group_ids: number[];
    created_by_username: string | null;
}

function creatorUsername(session: SessionRow): string | null {
    return session.created_by === null ? null : userRepository.usernameById(session.created_by);
}

function withGroups(session: SessionRow): SessionWithGroups {
    return {
        ...session,
        group_ids: sessionRepository.getGroupIds(session.id),
        created_by_username: creatorUsername(session),
    };
}

export function list(): SessionWithGroups[] {
    const groupIds = new Map<number, number[]>(sessionRepository.listAllGroupIds());
    return sessionRepository.findAll().map((session) => ({
        ...session,
        group_ids: groupIds.get(session.id) ?? [],
        created_by_username: creatorUsername(session),
    }));
}

export function get(id: number): SessionWithGroups {
    const session = sessionRepository.findById(id);
    if (!session) throw new NotFoundError("Session");
    return withGroups(session);
}

export function getActive(): SessionWithGroups | null {
    const session = sessionRepository.findActive();
    return session ? withGroups(session) : null;
}

export function create(input: {
    label: string;
    groupIds?: number[];
    scheduledAt: string;
    durationMinutes?: number;
    createdBy?: number | null;
}): SessionWithGroups {
    const groupIds = [...new Set(input.groupIds ?? [])];
    // At least one group: no more "all students" fallback at creation
    // (historical sessions without groups remain readable, their roster
    // remains the coverage of all students).
    if (groupIds.length === 0) {
        throw new ValidationError("Sélectionnez au moins un groupe pour la session.");
    }
    for (const groupId of groupIds) {
        if (!Number.isInteger(groupId) || groupId < 1 || !groupRepository.findById(groupId)) {
            throw new ValidationError(`Groupe ${groupId} introuvable.`);
        }
    }
    const session = sessionRepository.create({ ...input, groupIds });
    sessionLog.info("session.created", { session_id: session.id, group_ids: groupIds });
    return withGroups(session);
}

export function start(id: number): SessionWithGroups {
    const session = get(id);
    if (session.status === "running") {
        throw new SessionStateError("SESSION_ALREADY_RUNNING", "Cette session est déjà active.");
    }
    if (session.status !== "scheduled") {
        throw new SessionStateError(
            "SESSION_INVALID_TRANSITION",
            `Impossible de démarrer une session « ${session.status} ».`,
        );
    }
    const active = sessionRepository.findActive();
    if (active) {
        throw new SessionStateError(
            "SESSION_ANOTHER_RUNNING",
            `La session ${active.id} est déjà active ; arrêtez-la avant d'en démarrer une autre.`,
        );
    }

    // Phase 3 — starting FREEZES the roster : the expected participants
    // (session_groups UNION + inclusion/exclusion deltas, deduplicated) are
    // snapshotted into session_roster, roster_frozen_at is stamped AND the
    // scheduled → running transition happens — ALL in one SQLite
    // transaction. Any failure (trigger, constraint, crash) rolls the whole
    // thing back : the session stays scheduled with no half-written snapshot,
    // and no scan loop is ever started.
    const startedRow = db.transaction(() => {
        const row = sessionRepository.start(id);
        if (row.roster_frozen_at === null) {
            const frozenAt = isoNow();
            sessionRosterRepository.capture(id, frozenAt, sessionRosterRepository.resolveExpectedEntries(id));
            sessionRepository.freezeRoster(id, frozenAt);
        }
        return sessionRepository.findById(id)!;
    })();

    const started = withGroups(startedRow);
    sessionLog.info("session.started", {
        session_id: id,
        label: started.label,
        roster_frozen_at: started.roster_frozen_at,
    });
    startScan(started); // the reader may be offline: the loop waits
    broadcastEvent("session:started", { session: started });
    return started;
}

// Manual correction of ONE scheduled session (occurrence or standalone) —
// the calendar's « modifier ce cours » action. Only scheduled rows are
// editable (409 otherwise : running/completed/cancelled history is never
// rewritten). A SERIES OCCURRENCE keeps its local identity : occurrence_date +
// local_time + timezone are what place it on the calendar and what the rolling
// generation uses as its idempotency key, so moving its UTC instant here
// would either make the move invisible or silently break that key — a 409
// SESSION_OCCURRENCE_MOVE refuses it instead (« this and following » moves go
// through PATCH /api/series/:id, seriesService.editSeriesFrom, which keeps the
// whole local scheduling coherent). label and duration stay editable : they
// never touch the identity.
export function updateScheduled(
    id: number,
    patch: { label?: string; scheduledAt?: string; durationMinutes?: number },
): SessionWithGroups {
    const session = get(id);
    if (session.status !== "scheduled") {
        throw new SessionStateError(
            "SESSION_INVALID_TRANSITION",
            `Impossible de modifier une session « ${session.status} » — seules les sessions programmées sont éditables.`,
        );
    }
    if (patch.scheduledAt !== undefined && session.series_id !== null) {
        throw new SessionStateError(
            "SESSION_OCCURRENCE_MOVE",
            "Une occurrence d'une série ne peut pas être déplacée individuellement — modifiez la série « à partir de cette occurrence » pour la reprogrammer.",
        );
    }
    if (patch.label === undefined && patch.scheduledAt === undefined && patch.durationMinutes === undefined) {
        throw new ValidationError("Aucune modification fournie : « label », « scheduledAt » ou « durationMinutes ».");
    }
    const updated = withGroups(
        sessionRepository.updateSchedule(id, {
            label: patch.label,
            scheduledAt: patch.scheduledAt,
            durationMinutes: patch.durationMinutes,
        })!,
    );
    sessionLog.info("session.updated", { session_id: id });
    broadcastEvent("session:updated", { session: updated });
    return updated;
}

// Weekly-calendar view : the concrete occurrences (app_sessions rows) inside
// the inclusive local-date range [from, to]. Timezone semantics (see the
// repository findForCalendar) : a series occurrence matches on its LOCAL
// occurrence_date (the day the course really happens in the series timezone) ;
// a standalone session on the UTC calendar day of scheduled_at (substr — same
// semantics as the reporting date filters). Each row carries the occurrence
// fields, its status, the series metadata (label/status/recurrence), the
// joined group names + group_ids and the expected participant count (frozen
// roster once captured, live membership otherwise).
export function getCalendar(from: string, to: string): Array<CalendarSessionRow & { group_ids: number[] }> {
    if (from > to) {
        throw new ValidationError("La date de fin est antérieure à la date de début.");
    }
    const groupIds = new Map<number, number[]>(sessionRepository.listAllGroupIds());
    return sessionRepository.findForCalendar(from, to).map((row) => ({
        ...row,
        group_ids: groupIds.get(row.id) ?? [],
    }));
}

// Normal stop of a running session → completed.
export function stop(id: number, reason = "manual_stop"): SessionWithGroups {
    const session = get(id);
    if (session.status !== "running") {
        throw new SessionStateError("SESSION_NOT_RUNNING", "Aucune session active pour cet identifiant.");
    }
    stopScan();
    const completed = withGroups(sessionRepository.complete(id)!);
    sessionLog.info("session.completed", { session_id: id, reason });
    broadcastEvent("session:stopped", { session: completed, reason });
    return completed;
}

// Cancellation (before or during execution).
export function cancel(id: number): SessionWithGroups {
    const session = get(id);
    if (session.status !== "scheduled" && session.status !== "running") {
        throw new SessionStateError(
            "SESSION_INVALID_TRANSITION",
            `Impossible d'annuler une session « ${session.status} ».`,
        );
    }
    if (session.status === "running") stopScan();
    const cancelled = withGroups(sessionRepository.cancel(id)!);
    sessionLog.info("session.cancelled", { session_id: id });
    broadcastEvent("session:updated", { session: cancelled });
    return cancelled;
}
