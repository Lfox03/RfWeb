// Centralized API error handling.
// Single error response shape: { "error": { "code", "message" } } — never a
// stack trace nor a raw SQLite error on the client side; the full detail is
// logged server-side.

import type { ErrorRequestHandler, RequestHandler } from "express";

import { AppError, RateLimitError } from "../../core/errors";
import { errorFields, logger } from "../../core/logger";
import { BACKUP_RESTORE_MAX_MB } from "../../config/env";

interface SqliteErrorLike {
    code?: string;
    message?: string;
}

// 404 for unknown /api routes (mounted AFTER all routers).
export const apiNotFound: RequestHandler = (req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: `Route inconnue : ${req.method} ${req.path}` } });
};

function translate(
    err: unknown,
    path: string,
): { status: number; code: string; message: string; retryAfterSeconds?: number } {
    if (err instanceof AppError) {
        const retryAfterSeconds = err instanceof RateLimitError ? err.retryAfterSeconds : undefined;
        return { status: err.status, code: err.code, message: err.message, retryAfterSeconds };
    }

    // Illegal JSON body (express.json).
    const parseErr = err as { type?: string; status?: number };
    if (parseErr.type === "entity.parse.failed" || parseErr.status === 400) {
        return { status: 400, code: "INVALID_JSON", message: "Corps de requête JSON invalide." };
    }

    // Body too large (CSV import > 2 MB, database restore > BACKUP_RESTORE_MAX_MB).
    if (parseErr.type === "entity.too.large" || parseErr.status === 413) {
        if (path.startsWith("/api/backups/restore")) {
            return {
                status: 413,
                code: "PAYLOAD_TOO_LARGE",
                message: `Fichier trop volumineux (${BACKUP_RESTORE_MAX_MB} Mo maximum).`,
            };
        }
        return { status: 413, code: "PAYLOAD_TOO_LARGE", message: "Fichier trop volumineux (2 Mo maximum)." };
    }

    // SQLite constraints surfaced as-is → clean conflicts.
    const sqlite = (err as SqliteErrorLike).code ?? "";
    if (typeof sqlite === "string") {
        if (sqlite.startsWith("SQLITE_CONSTRAINT_UNIQUE")) {
            return { status: 409, code: "ALREADY_EXISTS", message: "Cette ressource existe déjà (valeur unique en double)." };
        }
        if (sqlite.startsWith("SQLITE_CONSTRAINT_FOREIGNKEY")) {
            return { status: 400, code: "INVALID_REFERENCE", message: "Référence invalide (ressource associée inconnue)." };
        }
        if (sqlite.startsWith("SQLITE_CONSTRAINT")) {
            return { status: 400, code: "CONSTRAINT_VIOLATED", message: "Valeur refusée par une contrainte de la base." };
        }
    }

    return { status: 500, code: "INTERNAL", message: "Erreur interne du serveur." };
}

const log = logger.child({ component: "http" });

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    const { status, code, message, retryAfterSeconds } = translate(err, req.originalUrl);
    if (code === "INTERNAL") {
        // Seule erreur interne : stack complète côté serveur (jamais dans la
        // réponse — l'enveloppe { error } reste générique).
        log.error("http.request_error", {
            method: req.method,
            path: req.originalUrl,
            status,
            code,
            ...errorFields(err, { stack: true }),
        });
    } else {
        log.info("http.request_error", { method: req.method, path: req.originalUrl, status, code, message });
    }
    if (retryAfterSeconds !== undefined) {
        res.set("Retry-After", String(retryAfterSeconds));
    }
    res.status(status).json({ error: { code, message } });
};
