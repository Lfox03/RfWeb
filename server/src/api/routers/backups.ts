// « Base de données » routes — admin-only (SQLite backup management).
// POST /            → create a consistent .db snapshot (online backup API)
// POST /restore     → replace the live database with an uploaded .db file
// GET  /            → list the backups stored server-side (newest first)
// GET  /:filename   → download one backup as a raw .db file attachment

import express, { Router } from "express";

import { requireRole } from "../middleware/auth";
import { asyncHandler, created, list, ok } from "../http";
import { ValidationError } from "../../core/errors";
import { BACKUP_RESTORE_MAX_MB } from "../../config/env";
import { createBackup, listBackups, readBackup, restoreBackup } from "../../services/backupService";

export const backupsRouter = Router();

backupsRouter.use(requireRole("admin"));

backupsRouter.post(
    "/",
    asyncHandler(async (_req, res) => {
        created(res, await createBackup());
    }),
);

// Full restore from an uploaded .db file (raw body, application/octet-stream,
// BACKUP_RESTORE_MAX_MB maximum). The server validates the uploaded database
// (SQLite format, integrity_check, schema) and creates a safety backup of the
// current database BEFORE any replacement — an invalid file can never become
// the live database.
backupsRouter.post(
    "/restore",
    express.raw({ type: "application/octet-stream", limit: `${BACKUP_RESTORE_MAX_MB}mb` }),
    asyncHandler(async (req, res) => {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            throw new ValidationError(
                "Fichier .db attendu : envoyez le contenu de la sauvegarde en application/octet-stream.",
            );
        }
        ok(res, await restoreBackup(req.body));
    }),
);

backupsRouter.get(
    "/",
    asyncHandler(async (_req, res) => {
        list(res, await listBackups());
    }),
);

// Réponse fichier brute (pas l'enveloppe JSON habituelle), comme l'export
// CSV : l'erreur éventuelle (400/404) garde le format { error } standard car
// elle est levée avant tout envoi d'en-tête.
backupsRouter.get(
    "/:filename",
    asyncHandler(async (req, res) => {
        const { filename, sizeBytes, content } = await readBackup(String(req.params.filename));
        res.status(200)
            .set("Content-Type", "application/octet-stream")
            .set("Content-Disposition", `attachment; filename="${filename}"`)
            .set("Content-Length", String(sizeBytes))
            .send(content);
    }),
);
