// « Session series » routes — the recurring-planning templates exposed over
// services/seriesService : creation, list, detail, edition FROM A SELECTED
// OCCURRENCE ONWARD (PATCH), status (pause/resume) and cancellation (which
// also clears the series' still-planned future occurrences).
//
// Creating or editing a series NEVER materializes anything by itself : the
// scheduler (schedulerService.runSeriesGeneration, boot + every tick) turns
// active templates into concrete scheduled occurrences over the rolling
// horizon — generation is idempotent, so waiting for the next tick is safe.
// Availability policy identical to sessions : any authenticated role plans
// (the kiosk account is already read-only server-side, so its writes 403).
// Shape validation is shape-only here ; the calendar/time/timezone rules and
// the status state machine are the service's (they raise the 400/409).

import { Router } from "express";

import { asyncHandler, created, list, ok } from "../http";
import {
    parseIdParam,
    rejectUnknownFields,
    requireBody,
    vInt,
    vIntArray,
    vLocalDate,
    vLocalTime,
    vString,
    type Body,
} from "../validate";
import { ValidationError } from "../../core/errors";
import * as seriesService from "../../services/seriesService";

export const seriesRouter = Router();

const SERIES_CREATE_FIELDS = [
    "label",
    "recurrence",
    "weekday",
    "localTime",
    "timezone",
    "durationMinutes",
    "startsOn",
    "endsOn",
    "groupIds",
    "participants",
];

// The edit body additionally carries the anchor date (fromDate) of the
// « this and following » edit. Participants ARE editable since Phase 5 :
// migration 009 marks generation copies (inherited = 1), so the service can
// sync future scheduled occurrences without ever rewriting an explicit
// per-occurrence override (services/seriesService).
const SERIES_EDIT_FIELDS = SERIES_CREATE_FIELDS.concat("fromDate");

interface RecurrenceInput {
    label?: string;
    recurrence?: "daily" | "weekly";
    weekday?: number | null;
    localTime?: string;
    timezone?: string;
    durationMinutes?: number;
    startsOn?: string;
    endsOn?: string | null;
    groupIds?: number[];
    participants?: Array<{ studentId: number; included: boolean }>;
}

function vRecurrence(body: Body): "daily" | "weekly" | undefined {
    const raw = vString(body, "recurrence", { max: 10 });
    if (raw === undefined) return undefined;
    if (raw !== "daily" && raw !== "weekly") {
        throw new ValidationError("Récurrence invalide : « daily » ou « weekly » attendu.");
    }
    return raw;
}

// null clears weekday (mandatory switch weekly → daily) ; otherwise a strict
// 0 (dimanche) … 6 (samedi) integer, the JS getDay convention.
function vWeekday(body: Body): number | null | undefined {
    if (body.weekday === null) return null;
    return vInt(body, "weekday", { min: 0, max: 6 });
}

// null clears ends_on (back to open-ended).
function vEndsOn(body: Body): string | null | undefined {
    if (body.endsOn === null) return null;
    return vLocalDate(body, "endsOn");
}

function vParticipants(
    body: Body,
): Array<{ studentId: number; included: boolean }> | undefined {
    const raw = body.participants;
    if (raw === undefined || raw === null) return undefined;
    if (!Array.isArray(raw)) throw new ValidationError("Le champ « participants » doit être un tableau.");
    if (raw.length > 500) throw new ValidationError("Le champ « participants » doit contenir au plus 500 éléments.");
    return raw.map((item) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
            throw new ValidationError("Chaque participant doit être un objet { studentId, included }.");
        }
        const entry = item as Record<string, unknown>;
        for (const key of Object.keys(entry)) {
            if (key !== "studentId" && key !== "included") {
                throw new ValidationError(`Champ inconnu : « ${key} ».`);
            }
        }
        if (typeof entry.studentId !== "number" || !Number.isInteger(entry.studentId) || entry.studentId < 1) {
            throw new ValidationError("Le champ « studentId » doit être un entier ≥ 1.");
        }
        if (typeof entry.included !== "boolean") {
            throw new ValidationError("Le champ « included » doit être un booléen.");
        }
        return { studentId: entry.studentId, included: entry.included };
    });
}

// Merged partial template from a validated body (only the provided keys).
function parseSeriesBody(body: Body): RecurrenceInput {
    const parsed: RecurrenceInput = {};
    const label = vString(body, "label", { min: 1, max: 200 });
    if (label !== undefined) parsed.label = label;
    const recurrence = vRecurrence(body);
    if (recurrence !== undefined) parsed.recurrence = recurrence;
    const weekday = vWeekday(body);
    if (weekday !== undefined) parsed.weekday = weekday;
    const localTime = vLocalTime(body, "localTime");
    if (localTime !== undefined) parsed.localTime = localTime;
    const timezone = vString(body, "timezone", { min: 1, max: 64 });
    if (timezone !== undefined) parsed.timezone = timezone;
    const durationMinutes = vInt(body, "durationMinutes", { min: 1, max: 1440 });
    if (durationMinutes !== undefined) parsed.durationMinutes = durationMinutes;
    const startsOn = vLocalDate(body, "startsOn");
    if (startsOn !== undefined) parsed.startsOn = startsOn;
    const endsOn = vEndsOn(body);
    if (endsOn !== undefined) parsed.endsOn = endsOn;
    const groupIds = vIntArray(body, "groupIds", { min: 1, maxItems: 100 });
    if (groupIds !== undefined) parsed.groupIds = groupIds;
    const participants = vParticipants(body);
    if (participants !== undefined) parsed.participants = participants;
    return parsed;
}

seriesRouter.get(
    "/",
    asyncHandler(async (_req, res) => {
        list(res, seriesService.listSeries());
    }),
);

// Creation ONLY persists the template (plus its group scope and individual
// deltas) — no occurrence is invented here ; the scheduler materializes the
// rolling horizon (scheduled rows only, never started).
seriesRouter.post(
    "/",
    asyncHandler(async (req, res) => {
        const body = requireBody(req.body);
        rejectUnknownFields(body, SERIES_CREATE_FIELDS);
        const parsed = parseSeriesBody(body);
        const createdSeries = seriesService.createSeries({
            ...parsed,
            label: vString(body, "label", { required: true, min: 1, max: 200 })!,
            localTime: vLocalTime(body, "localTime", { required: true })!,
            startsOn: vLocalDate(body, "startsOn", { required: true })!,
            groupIds: vIntArray(body, "groupIds", { required: true, min: 1, maxItems: 100 })!,
            participants: parsed.participants,
            // authRequired guarantees req.user here : the series records
            // who created it (copied onto every generated occurrence).
            createdBy: req.user!.id,
        });
        // Same enriched shape as GET /:id (group_ids + participants included).
        created(res, seriesService.getSeries(createdSeries.id));
    }),
);

seriesRouter.get(
    "/:id",
    asyncHandler(async (req, res) => {
        ok(res, seriesService.getSeries(parseIdParam(req.params.id, "série")));
    }),
);

// « À partir de cette date » : the template is rewritten and the future
// scheduled occurrences are reprogrammed in place / cancelled / newly
// materialized around the anchor occurrence (all-or-nothing, one
// transaction — services/seriesService). A patch carrying groupIds and/or
// participants additionally syncs the INHERITED membership copies of the
// rewritten occurrences ; explicit per-occurrence overrides survive.
// fromDate MUST be an existing occurrence date of the series (404 otherwise).
seriesRouter.patch(
    "/:id",
    asyncHandler(async (req, res) => {
        const body = requireBody(req.body);
        rejectUnknownFields(body, SERIES_EDIT_FIELDS);
        const fromDate = vLocalDate(body, "fromDate", { required: true })!;
        const patch = parseSeriesBody(body);
        ok(res, seriesService.editSeriesFrom(parseIdParam(req.params.id, "série"), fromDate, patch));
    }),
);

// Status — the series state machine (cancelled is terminal, 409
// SERIES_CANCELLED). paused keeps the template and the already-materialized
// occurrences but materializes nothing new.
seriesRouter.post(
    "/:id/pause",
    asyncHandler(async (req, res) => {
        ok(res, seriesService.setSeriesStatus(parseIdParam(req.params.id, "série"), "paused"));
    }),
);

seriesRouter.post(
    "/:id/resume",
    asyncHandler(async (req, res) => {
        ok(res, seriesService.setSeriesStatus(parseIdParam(req.params.id, "série"), "active"));
    }),
);

// Cancellation = end the template AND clear its still-planned future (the
// scheduled occurrences from `from` — default : today in the series timezone
// — onward). running / completed / already cancelled occurrences and all
// attendance history survive (services/seriesService.cancelSeries).
seriesRouter.post(
    "/:id/cancel",
    asyncHandler(async (req, res) => {
        const body: Body =
            typeof req.body === "object" && req.body !== null && !Array.isArray(req.body) ? (req.body as Body) : {};
        rejectUnknownFields(body, ["from"]);
        ok(res, seriesService.cancelSeries(parseIdParam(req.params.id, "série"), vLocalDate(body, "from")));
    }),
);
