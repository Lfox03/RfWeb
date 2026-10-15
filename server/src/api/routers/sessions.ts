// « Sessions » routes (explicit lifecycle) + attached attendance and scan
// history. No automatic session at startup.

import { Router } from "express";

import { asyncHandler, created, list, noContent, ok } from "../http";
import {
    parseIdParam,
    qDate,
    rejectUnknownFields,
    requireBody,
    vInt,
    vIntArray,
    vIsoDate,
    vString,
} from "../validate";
import { getClock } from "../../core/clock";
import { ValidationError } from "../../core/errors";
import * as sessionService from "../../services/sessionService";
import * as attendanceService from "../../services/attendanceService";

export const sessionsRouter = Router();

sessionsRouter.get(
    "/",
    asyncHandler(async (_req, res) => {
        list(res, sessionService.list());
    }),
);

sessionsRouter.get(
    "/active",
    asyncHandler(async (_req, res) => {
        ok(res, sessionService.getActive());
    }),
);

// Weekly-planner feed : the CONCRETE occurrences (app_sessions rows) inside
// the inclusive range [from, to] (both required), each carrying the
// scheduling data (scheduled_at, local_time, timezone, duration), the status,
// the series metadata (series_id/label/status/recurrence, occurrence_date),
// the groups (names + ids) and the expected participant count (frozen roster
// once captured, live membership otherwise).
// TIMEZONE SEMANTICS (sessionService.getCalendar) : from/to are local
// calendar dates — series occurrences match on their LOCAL occurrence_date
// (the day the course really happens in the series timezone), standalone
// sessions on the UTC calendar day of scheduled_at (same convention as the
// reporting date filters). A weekly view should therefore send whole local
// weeks ; a course keeps its local date even across a DST transition.
sessionsRouter.get(
    "/calendar",
    asyncHandler(async (req, res) => {
        const query = req.query as unknown as Record<string, unknown>;
        list(
            res,
            sessionService.getCalendar(
                qDate(query, "from", { required: true })!,
                qDate(query, "to", { required: true })!,
            ),
        );
    }),
);

sessionsRouter.get(
    "/:id",
    asyncHandler(async (req, res) => {
        ok(res, sessionService.get(parseIdParam(req.params.id, "session")));
    }),
);

// A session carries ONE or MORE groups (scope = UNION of the groups'
// students) — at least one group is required (service). « groupIds »
// (array) is the current shape; « groupId » (single) remains accepted for
// compatibility, but both fields together are refused.
sessionsRouter.post(
    "/",
    asyncHandler(async (req, res) => {
        const body = requireBody(req.body);
        rejectUnknownFields(body, ["label", "groupId", "groupIds", "scheduledAt", "durationMinutes"]);
        const groupIds = vIntArray(body, "groupIds", { min: 1, maxItems: 100 });
        const legacyGroupId = vInt(body, "groupId", { min: 1 });
        if (groupIds !== undefined && legacyGroupId !== undefined) {
            throw new ValidationError("Utilisez « groupIds » (tableau) ou « groupId » (identifiant unique), pas les deux.");
        }
        created(
            res,
            sessionService.create({
                label: vString(body, "label", { required: true, min: 1, max: 200 })!,
                groupIds: groupIds ?? (legacyGroupId !== undefined ? [legacyGroupId] : []),
                // "now" comes from the injected clock (core/clock.ts): the
                // scheduling window follows a FakeClock in tests.
                scheduledAt: vIsoDate(body, "scheduledAt") ?? getClock().now().toISOString(),
                durationMinutes: vInt(body, "durationMinutes", { min: 1, max: 1440 }) ?? 10,
                // authRequired guarantees req.user here : the session records
                // who created it.
                createdBy: req.user!.id,
            }),
        );
    }),
);

// Edit ONE scheduled session (« modifier ce cours ») : label, UTC instant
// (standalone sessions only) and/or duration. Only scheduled rows (409
// SESSION_INVALID_TRANSITION otherwise) ; moving the UTC instant of a SERIES
// OCCURRENCE is refused (409 SESSION_OCCURRENCE_MOVE) — reprogramming an
// occurrence and its follow-ups is PATCH /api/series/:id.
sessionsRouter.patch(
    "/:id",
    asyncHandler(async (req, res) => {
        const body = requireBody(req.body);
        rejectUnknownFields(body, ["label", "scheduledAt", "durationMinutes"]);
        ok(
            res,
            sessionService.updateScheduled(parseIdParam(req.params.id, "session"), {
                label: vString(body, "label", { min: 1, max: 200 }),
                scheduledAt: vIsoDate(body, "scheduledAt"),
                durationMinutes: vInt(body, "durationMinutes", { min: 1, max: 1440 }),
            }),
        );
    }),
);

sessionsRouter.post(
    "/:id/start",
    asyncHandler(async (req, res) => {
        ok(res, sessionService.start(parseIdParam(req.params.id, "session")));
    }),
);

sessionsRouter.post(
    "/:id/stop",
    asyncHandler(async (req, res) => {
        ok(res, sessionService.stop(parseIdParam(req.params.id, "session")));
    }),
);

sessionsRouter.post(
    "/:id/cancel",
    asyncHandler(async (req, res) => {
        ok(res, sessionService.cancel(parseIdParam(req.params.id, "session")));
    }),
);

// Attendance state of a session.
sessionsRouter.get(
    "/:id/attendance",
    asyncHandler(async (req, res) => {
        list(res, attendanceService.listAttendance(parseIdParam(req.params.id, "session")));
    }),
);

// Raw scan history (duplicates/unknowns included).
sessionsRouter.get(
    "/:id/scans",
    asyncHandler(async (req, res) => {
        list(res, attendanceService.listScans(parseIdParam(req.params.id, "session")));
    }),
);

// Manual presence mark (teacher correction): requires a « running » session
// (409 otherwise), refuses a student already present (409
// ALREADY_PRESENT). Journals the « manual » event and broadcasts
// attendance:scanned like an RFID scan.
sessionsRouter.post(
    "/:id/attendance/manual",
    asyncHandler(async (req, res) => {
        const body = requireBody(req.body);
        rejectUnknownFields(body, ["studentId"]);
        const studentId = vInt(body, "studentId", { required: true, min: 1 })!;
        ok(res, attendanceService.markPresentManually(parseIdParam(req.params.id, "session"), studentId));
    }),
);

// Resets the attendance STATE; the card_scans history is kept.
sessionsRouter.post(
    "/:id/attendance/reset",
    asyncHandler(async (req, res) => {
        attendanceService.resetAttendance(parseIdParam(req.params.id, "session"));
        noContent(res);
    }),
);
