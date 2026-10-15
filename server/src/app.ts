// HTTP application factory — decoupled from startup (reused by the
// API verification on a temporary database). No legacy dependency: the
// legacy public/ frontend was deleted — only the React client (client/dist) is served.

import express from "express";
import fs from "node:fs";
import path from "node:path";

import { PROJECT_ROOT, TRUST_PROXY } from "./config/env";
import { apiRouter } from "./api/routers";
import { errorHandler } from "./api/middleware/error";

export function createApp(): express.Express {
    const app = express();

    // X-Forwarded-For is only honored when explicitly configured (TRUST_PROXY)
    // — otherwise a client could forge its IP to evade the login rate limiter.
    if (TRUST_PROXY) {
        app.set("trust proxy", 1);
    }

    app.use(express.json({ limit: "100kb" }));

    app.use("/api", apiRouter);

    // Built React client (production) — served if it exists, SPA fallback.
    const clientDist = path.join(PROJECT_ROOT, "client", "dist");
    if (fs.existsSync(clientDist)) {
        app.use(express.static(clientDist));
        app.get(/.*/, (req, res, next) => {
            if (req.method !== "GET" || req.path.startsWith("/api") || path.extname(req.path)) {
                return next();
            }
            res.sendFile(path.join(clientDist, "index.html"));
        });
    }

    app.use(errorHandler);
    return app;
}
