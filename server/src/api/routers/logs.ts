// « Journaux » routes — admin-only view of the server's recent structured logs.
//
// GET / → the volatile in-memory tail (core/logBuffer) as sanitized entries.
// Query: level (debug|info|warn|error exact filter), limit (most recent N),
// since (only entries with seq > since, for an incremental tail). Entries come
// back oldest → newest; `meta` carries the buffer size so the client can render
// a "last N lines" hint. Read-only: no way to mutate the log pipeline.

import { Router } from "express";

import { requireRole } from "../middleware/auth";
import { asyncHandler, list } from "../http";
import { qEnum, qInt } from "../validate";
import { listRecentLogs } from "../../services/logService";

const LEVELS = ["debug", "info", "warn", "error"] as const;

// Hard API cap on the requested window (the buffer itself may hold fewer).
const MAX_LIMIT = 5000;

export const logsRouter = Router();

logsRouter.use(requireRole("admin"));

logsRouter.get(
    "/",
    asyncHandler(async (req, res) => {
        const query = req.query as unknown as Record<string, unknown>;
        const page = listRecentLogs({
            level: qEnum(query, "level", LEVELS),
            limit: qInt(query, "limit", { min: 1, max: MAX_LIMIT }),
            sinceSeq: qInt(query, "since", { min: 0 }),
        });
        list(res, page.entries, { capacity: page.capacity, buffered: page.buffered });
    }),
);
