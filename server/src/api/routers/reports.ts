// Phase 7 — reporting endpoints (attendance history + CSV export).
// Read-only; available to every authenticated role (admin and teacher).

import { Router } from "express";

import { asyncHandler, list, ok } from "../http";
import { parseIdParam, qDate, qEnum, qInt } from "../validate";
import * as reportingService from "../../services/reportingService";

export const reportsRouter = Router();

const SESSION_STATUSES = ["scheduled", "running", "completed", "cancelled"] as const;

// Sessions matching the filters (date range on scheduled_at, group, status)
// with per-session attendance/scan counters.
reportsRouter.get(
    "/sessions",
    asyncHandler(async (req, res) => {
        const query = req.query as unknown as Record<string, unknown>;
        list(
            res,
            reportingService.listReportSessions({
                from: qDate(query, "from"),
                to: qDate(query, "to"),
                groupId: qInt(query, "groupId", { min: 1 }),
                status: qEnum(query, "status", SESSION_STATUSES),
            }),
        );
    }),
);

// Full report for one session: roster with present/absent status, first
// accepted scan time and summary counts.
reportsRouter.get(
    "/sessions/:id",
    asyncHandler(async (req, res) => {
        ok(res, reportingService.getSessionReport(parseIdParam(req.params.id, "session")));
    }),
);

// Server-side CSV of the same authoritative report (file response instead of
// the usual JSON envelope).
reportsRouter.get(
    "/sessions/:id/export",
    asyncHandler(async (req, res) => {
        const { filename, csv } = reportingService.buildSessionExport(parseIdParam(req.params.id, "session"));
        res.status(200)
            .set("Content-Type", "text/csv; charset=utf-8")
            .set("Content-Disposition", `attachment; filename="${filename}"`)
            .send(csv);
    }),
);
