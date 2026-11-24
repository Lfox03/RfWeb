// Base de données : sauvegarde SQLite (.db, admin seul) — api:verify section 19
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "../environment";
import { Client, ok, REMOTE_HEADERS } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { admin, base, teacher } = ctx;
    let res: ApiResponse;

    console.log("── 19. Base de données : sauvegarde SQLite (.db, admin seul) ──");
    {
        const Database = (await import("better-sqlite3")).default;
        const { db, TARGET_SCHEMA_VERSION } = await import("../../../db");

        // NB: « anon » a été authentifié root en section 13 — un client
        // neuf, distant (X-Forwarded-For), est nécessaire pour le cas
        // vraiment anonyme (la boucle locale aurait le borne implicite).
        const noCookie = new Client(base, REMOTE_HEADERS);
        res = await noCookie.call("GET", "/api/backups");
        ok("GET /api/backups sans session (distant) → 401 NOT_AUTHENTICATED", res.status === 401 && res.body.error.code === "NOT_AUTHENTICATED");
        res = await teacher.call("GET", "/api/backups");
        ok("GET /api/backups avec teacher → 403 FORBIDDEN", res.status === 403 && res.body.error.code === "FORBIDDEN");
        res = await teacher.call("POST", "/api/backups");
        ok("POST /api/backups avec teacher → 403 FORBIDDEN", res.status === 403 && res.body.error.code === "FORBIDDEN");

        // Witness row created right before the snapshot: fresh writes live
        // in the WAL (not checkpointed yet), so finding this group inside
        // the backup proves the online backup integrated the WAL.
        res = await teacher.call("POST", "/api/groups", { name: "G-DANS-BACKUP" });
        ok("groupe témoin créé avant la sauvegarde → 201", res.status === 201);

        res = await admin.call("POST", "/api/backups");
        const backup = res.body.data;
        ok(
            "POST /api/backups (admin) → 201 { filename horodaté, size_bytes > 0, created_at }",
            res.status === 201 &&
                /^attendance-\d{8}-\d{6}(?:-\d{1,2})?\.db$/.test(backup.filename ?? "") &&
                backup.size_bytes > 0 &&
                typeof backup.created_at === "string",
        );
        ok(
            "nom de fichier sûr : aucun chemin ni séparateur exposé",
            !backup.filename.includes("/") && !backup.filename.includes("\\") && !backup.filename.includes(".."),
        );

        // Row created AFTER the snapshot must be absent from it.
        res = await teacher.call("POST", "/api/groups", { name: "G-APRES-BACKUP" });
        ok("groupe créé après la sauvegarde → 201", res.status === 201);

        const second = await admin.call("POST", "/api/backups");
        ok(
            "seconde sauvegarde → 201 avec nom distinct (suffixe anti-collision)",
            second.status === 201 && second.body.data.filename !== backup.filename,
        );

        res = await admin.call("GET", "/api/backups");
        ok(
            "GET /api/backups → les 2 sauvegardes listées, plus récente d'abord",
            res.status === 200 &&
                res.body.meta.total === 2 &&
                res.body.data[0].filename === second.body.data.filename &&
                res.body.data[1].filename === backup.filename,
        );

        // ── Download the stored backup as a raw .db attachment ──
        const dl = await fetch(`${base}/api/backups/${backup.filename}`, {
            headers: { cookie: admin.cookie ?? "" },
        });
        const disposition = dl.headers.get("content-disposition") ?? "";
        const bytes = Buffer.from(await dl.arrayBuffer());
        ok(
            "GET /api/backups/:filename → 200 + Content-Disposition attachment « ...db »",
            dl.status === 200 && /^attachment; filename="attendance-\d{8}-\d{6}(?:-\d{1,2})?\.db"$/.test(disposition),
        );
        ok(
            "octets téléchargés : en-tête SQLite valide + taille annoncée cohérente",
            bytes.subarray(0, 15).toString("latin1") === "SQLite format 3" &&
                Number(dl.headers.get("content-length")) === bytes.length,
        );

        // ── Open the backup independently (own file, read-only) ──
        const extractedPath = path.join(tmpDir, "backup-extrait.db");
        fs.writeFileSync(extractedPath, bytes);
        const extracted = new Database(extractedPath, { readonly: true, fileMustExist: true });
        try {
            ok(
                "sauvegarde ouverte seule : PRAGMA integrity_check → ok",
                extracted.pragma("integrity_check", { simple: true }) === "ok",
            );
            ok(
                "sauvegarde ouverte seule : version de schéma = TARGET_SCHEMA_VERSION",
                extracted.pragma("user_version", { simple: true }) === TARGET_SCHEMA_VERSION,
            );
            const liveUsers = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
            const backupUsers = extracted.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
            ok("contenu cohérent : même nombre d'utilisateurs que la base vivante", backupUsers.n === liveUsers.n);
            const witness = extracted.prepare("SELECT COUNT(*) AS n FROM groups WHERE name = ?").get("G-DANS-BACKUP") as { n: number };
            ok("l'écriture récente (journal WAL non checkpointé) EST dans la sauvegarde", witness.n === 1);
            const tooLate = extracted.prepare("SELECT COUNT(*) AS n FROM groups WHERE name = ?").get("G-APRES-BACKUP") as { n: number };
            ok("sémantique d'instantané : le groupe créé après la sauvegarde est absent", tooLate.n === 0);
        } finally {
            extracted.close();
        }

        // ── The live database is untouched by the backup (no file copy) ──
        ok("base vivante toujours intègre après sauvegarde (integrity_check)", db.pragma("integrity_check", { simple: true }) === "ok");
        res = await teacher.call("POST", "/api/groups", { name: "G-APRES-TELECHARGEMENT" });
        ok("base vivante toujours inscriptible après la sauvegarde (aucun verrou)", res.status === 201);
        ok(
            "la sauvegarde est bien stockée dans BACKUP_DIR (répertoire dédié, hors base)",
            fs.existsSync(path.join(process.env.BACKUP_DIR ?? "", backup.filename)),
        );

        // ── Hardening: unknown file, traversal, non-admin download ──
        res = await admin.call("GET", "/api/backups/attendance-20000101-000000.db");
        ok(
            "sauvegarde au nom valide mais inconnue → 404 NOT_FOUND sans fuite de chemin",
            res.status === 404 && res.body.error.code === "NOT_FOUND" && !JSON.stringify(res.body).includes(tmpDir),
        );
        res = await admin.call("GET", "/api/backups/inconnu-00000000-000000.db");
        ok(
            "nom hors format (whitelist stricte) → 400 VALIDATION_ERROR",
            res.status === 400 && res.body.error.code === "VALIDATION_ERROR",
        );
        res = await admin.call("GET", `/api/backups/${encodeURIComponent("../verify.db")}`);
        ok(
            "traversal de chemin (« ..%2F ») refusé (400/404) sans divulgation",
            (res.status === 400 || res.status === 404) && !JSON.stringify(res.body).includes(tmpDir),
        );
        res = await teacher.call("GET", `/api/backups/${backup.filename}`);
        ok("téléchargement par teacher → 403 FORBIDDEN", res.status === 403 && res.body.error.code === "FORBIDDEN");
    }
}
