// Assembly of the /api router — versioned, consistent, session-protected.
//
// Policy: /api/health and /api/auth/* are public; EVERYTHING else requires a
// valid session (authRequired); account management, database backups and the
// server log tail are reserved for admins (requireRole in routers/users.ts,
// routers/backups.ts, routers/logs.ts); the « kiosk » role (kiosk terminal) is
// READ-ONLY across the whole API (it displays, never modifies).

import { Router } from "express";
import type { NextFunction, Request, Response } from "express";

import { AuthorizationError } from "../../core/errors";
import { healthRouter } from "../health";
import { apiNotFound } from "../middleware/error";
import { attachAuth, authRequired } from "../middleware/auth";
import { authRouter } from "./auth";
import { usersRouter } from "./users";
import { groupsRouter } from "./groups";
import { studentsRouter } from "./students";
import { cardsRouter } from "./cards";
import { sessionsRouter } from "./sessions";
import { seriesRouter } from "./series";
import { reportsRouter } from "./reports";
import { backupsRouter } from "./backups";
import { readerRouter } from "./reader";
import { logsRouter } from "./logs";

export const apiRouter = Router();

apiRouter.use(attachAuth);

// Public.
apiRouter.use(healthRouter);
apiRouter.use("/auth", authRouter);

// Session-protected.
apiRouter.use(authRequired);

// « Kiosk terminal » account: the display must not be able to write anything
// (the /kiosk page is a pure projection of backend state: GET only).
apiRouter.use((req: Request, _res: Response, next: NextFunction): void => {
    if (req.user?.role === "kiosk" && req.method !== "GET" && req.method !== "HEAD") {
        next(new AuthorizationError("Le compte de borne est en lecture seule."));
        return;
    }
    next();
});

apiRouter.use("/users", usersRouter);
apiRouter.use("/groups", groupsRouter);
apiRouter.use("/students", studentsRouter);
apiRouter.use("/cards", cardsRouter);
apiRouter.use("/sessions", sessionsRouter);
apiRouter.use("/series", seriesRouter);
apiRouter.use("/reports", reportsRouter);
apiRouter.use("/backups", backupsRouter);
apiRouter.use("/reader", readerRouter);
apiRouter.use("/logs", logsRouter);

apiRouter.use(apiNotFound);
