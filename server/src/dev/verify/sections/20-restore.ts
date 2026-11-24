// Base de données : restauration complète (.db, admin seul) — api:verify section 20
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "../environment";
import { ok } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { admin, base, teacher } = ctx;
    let res: ApiResponse;

    console.log("── 20. Base de données : restauration complète (.db, admin seul) ──");
    {
        const Database = (await import("better-sqlite3")).default;
        const dbBefore = (await import("../../../db")).db;
        const backupDirPath = process.env.BACKUP_DIR ?? "";

        const restoreRaw = async (body: Uint8Array, cookie?: string): Promise<ApiResponse> => {
            const r = await fetch(`${base}/api/backups/restore`, {
                method: "POST",
                headers: {
                    "content-type": "application/octet-stream",
                    ...(cookie ? { cookie } : {}),
                },
                body,
            });
            let parsed: unknown = null;
            try {
                parsed = await r.json();
            } catch {
                /* empty response */
            }
            return { status: r.status, body: parsed };
        };

        // ── Authentification : admin uniquement ──
        let r20 = await restoreRaw(Buffer.alloc(0));
        ok(
            "POST /api/backups/restore sans session → 401 NOT_AUTHENTICATED",
            r20.status === 401 && r20.body.error.code === "NOT_AUTHENTICATED",
        );
        r20 = await restoreRaw(Buffer.alloc(0), teacher.cookie);
        ok("POST /api/backups/restore avec teacher → 403 FORBIDDEN", r20.status === 403 && r20.body.error.code === "FORBIDDEN");

        // ── Fichiers invalides refusés, base vivante jamais touchée ──
        r20 = await restoreRaw(Buffer.alloc(0), admin.cookie);
        ok("corps vide → 400 VALIDATION_ERROR", r20.status === 400 && r20.body.error.code === "VALIDATION_ERROR");
        r20 = await restoreRaw(Buffer.from("ceci n'est pas une base SQLite"), admin.cookie);
        ok("octets qui ne sont pas du SQLite → 400 VALIDATION_ERROR", r20.status === 400 && r20.body.error.code === "VALIDATION_ERROR");
        res = await teacher.call("POST", "/api/groups", { name: "G-ENCORE-LA" });
        ok("base vivante toujours utilisable après les refus (aucun fichier touché)", res.status === 201);

        // ── Base SQLite corrompue → integrity_check la refuse ──
        // Fichier SQLite valide (grosses données), puis une page centrale
        // — forcément allouée — est remise à zéro : l'integrity_check
        // détecte la page invalide et la restauration est refusée.
        const corruptPath = path.join(tmpDir, "corrompu.db");
        {
            const cdb = new Database(corruptPath);
            cdb.exec("CREATE TABLE t (x TEXT NOT NULL)");
            const insert = cdb.prepare("INSERT INTO t (x) VALUES (?)");
            // UNE seule transaction : sans elle, 2 000 commits fsyncés
            // bloquent la boucle d'événements plusieurs secondes, le
            // keep-alive du serveur expire et la requête suivante part
            // sur un socket mort (ECONNRESET aléatoire).
            cdb.transaction(() => {
                for (let i = 0; i < 2000; i++) insert.run(`ligne-${i}-${"x".repeat(64)}`);
            })();
            cdb.close(); // checkpoint : toutes les pages sont dans le fichier
            const corrupt = fs.readFileSync(corruptPath);
            const pageStart = Math.floor(corrupt.length / 2 / 4096) * 4096;
            corrupt.fill(0, pageStart, pageStart + 4096);
            r20 = await restoreRaw(corrupt, admin.cookie);
            ok(
                "base SQLite corrompue → 400 VALIDATION_ERROR (contrôle d'intégrité)",
                r20.status === 400 &&
                    r20.body.error.code === "VALIDATION_ERROR" &&
                    /intégrit/i.test(r20.body.error.message ?? ""),
            );
        }

        // ── Version de schéma postérieure à l'application → refus ──
        const futurePath = path.join(tmpDir, "future.db");
        {
            const fdb = new Database(futurePath);
            fdb.exec("CREATE TABLE t (x TEXT)");
            fdb.pragma("user_version = 999");
            fdb.close();
            r20 = await restoreRaw(fs.readFileSync(futurePath), admin.cookie);
            ok(
                "version de schéma 999 (future) → 400 VALIDATION_ERROR",
                r20.status === 400 && r20.body.error.code === "VALIDATION_ERROR",
            );
        }

        // ── SQLite valide mais étranger à l'application (tables absentes) ──
        const emptyTargetPath = path.join(tmpDir, "vide-cible.db");
        {
            const { TARGET_SCHEMA_VERSION: targetVersion } = await import("../../../db");
            const edb = new Database(emptyTargetPath);
            // Version cible exacte : aucune migration n'est rejouée sur ce
            // fichier vide, c'est bien le contrôle des tables attendues
            // qui doit refuser la restauration.
            edb.pragma(`user_version = ${targetVersion}`);
            edb.close();
            r20 = await restoreRaw(fs.readFileSync(emptyTargetPath), admin.cookie);
            ok(
                "SQLite intègre sans les tables de l'application → 400 (tables attendues absentes)",
                r20.status === 400 &&
                    r20.body.error.code === "VALIDATION_ERROR" &&
                    /tables attendues absentes/i.test(r20.body.error.message ?? ""),
            );
        }

        // ── Session active → restauration bloquée (409), aucune trace ──
        res = await teacher.call("POST", "/api/groups", { name: "G-SESSION-20" });
        const g20 = res.body.data;
        res = await teacher.call("POST", "/api/sessions", { label: "Session bloc-restaure", groupId: g20.id });
        const s20 = res.body.data;
        res = await teacher.call("POST", `/api/sessions/${s20.id}/start`);
        ok("session active créée pour tester le blocage → running", res.status === 200 && res.body.data.status === "running");

        res = await admin.call("GET", "/api/backups");
        const listBefore = res.body.meta.total as number;
        const usableName = res.body.data[0].filename as string;
        const usableBytes = fs.readFileSync(path.join(backupDirPath, usableName));
        r20 = await restoreRaw(usableBytes, admin.cookie);
        ok(
            "session active → 409 RESTORE_SESSION_RUNNING (fichier valide mais restauration refusée)",
            r20.status === 409 && r20.body.error.code === "RESTORE_SESSION_RUNNING",
        );
        res = await admin.call("GET", "/api/backups");
        ok("refus sur session active : aucune sauvegarde de sécurité parasite", res.body.meta.total === listBefore);
        res = await teacher.call("POST", `/api/sessions/${s20.id}/stop`);
        ok("session arrêtée → restauration de nouveau possible", res.status === 200);

        // ── Restauration réussie ──
        // 1. Instantané de l'état courant, utilisé comme fichier restauré.
        res = await admin.call("POST", "/api/backups");
        const snapshot = res.body.data;
        const snapshotBytes = fs.readFileSync(path.join(backupDirPath, snapshot.filename));
        ok("instantané courant créé pour tester la restauration → 201", res.status === 201 && snapshotBytes.length > 0);

        // 2. Témoin créé APRÈS l'instantané : la restauration doit l'effacer.
        res = await teacher.call("POST", "/api/groups", { name: "G-EFFACEE-PAR-RESTAURATION" });
        ok("groupe créé après l'instantané (devra disparaître) → 201", res.status === 201);

        // 3. Restauration à proprement parler.
        r20 = await restoreRaw(snapshotBytes, admin.cookie);
        ok(
            "POST /api/backups/restore (admin, fichier valide) → 200 { restored_size_bytes, safety_backup horodaté }",
            r20.status === 200 &&
                r20.body.data.restored_size_bytes === snapshotBytes.length &&
                /^attendance-\d{8}-\d{6}(?:-\d{1,2})?\.db$/.test(r20.body.data.safety_backup?.filename ?? "") &&
                r20.body.data.safety_backup?.size_bytes > 0,
        );
        const safetyName = r20.body.data.safety_backup.filename as string;

        // 4. La sauvegarde de sécurité contient l'état d'AVANT restauration.
        const safetyPath = path.join(backupDirPath, safetyName);
        ok("sauvegarde de sécurité écrite dans BACKUP_DIR", fs.existsSync(safetyPath));
        const safetyDb = new Database(safetyPath, { readonly: true, fileMustExist: true });
        try {
            ok(
                "sauvegarde de sécurité : integrity_check ok + état d'avant conservé (témoin présent)",
                safetyDb.pragma("integrity_check", { simple: true }) === "ok" &&
                    (safetyDb.prepare("SELECT COUNT(*) AS n FROM groups WHERE name = ?").get("G-EFFACEE-PAR-RESTAURATION") as { n: number }).n === 1,
            );
        } finally {
            safetyDb.close();
        }

        // 5. La base vivante est le fichier restauré, via une connexion rouverte.
        const dbAfter = (await import("../../../db")).db;
        ok("connexion SQLite refermée puis rouverte (nouvelle poignée active)", dbAfter !== dbBefore);
        const countGroup = (name: string): number =>
            (dbAfter.prepare("SELECT COUNT(*) AS n FROM groups WHERE name = ?").get(name) as { n: number }).n;
        ok(
            "base restaurée : le témoin d'après-instantané a disparu, les écritures antérieures sont présentes",
            countGroup("G-EFFACEE-PAR-RESTAURATION") === 0 &&
                countGroup("G-DANS-BACKUP") === 1 &&
                countGroup("G-ENCORE-LA") === 1,
        );
        ok(
            "base restaurée intègre (integrity_check) et toujours en mode WAL",
            dbAfter.pragma("integrity_check", { simple: true }) === "ok" &&
                dbAfter.pragma("journal_mode", { simple: true }) === "wal",
        );

        // 6. API et services passent transparentement sur la nouvelle connexion.
        res = await teacher.call("GET", "/api/groups");
        ok(
            "API sur la nouvelle connexion : le groupe effacé n'est plus listé",
            res.status === 200 && !(res.body.data as any[]).some((g) => g.name === "G-EFFACEE-PAR-RESTAURATION"),
        );
        res = await teacher.call("POST", "/api/groups", { name: "G-APRES-RESTAURE" });
        ok("nouvelle écriture après restauration → 201 (services rebranchés)", res.status === 201);
        res = await admin.call("GET", "/api/auth/me");
        ok("session de connexion toujours valide (compte présent dans la base restaurée)", res.status === 200 && res.body.data.user.username === "root");

        // 7. La sauvegarde de sécurité reste listée et téléchargeable.
        res = await admin.call("GET", "/api/backups");
        ok(
            "sauvegarde de sécurité listée parmi les sauvegardes (récupérable)",
            res.status === 200 && (res.body.data as any[]).some((b) => b.filename === safetyName),
        );

        // 8. Aucun fichier temporaire résiduel à côté de la base.
        const leftovers = fs
            .readdirSync(path.dirname(process.env.DB_PATH!))
            .filter((f) => f.includes(".restore-") || f.includes("-journal"));
        ok("aucun fichier temporaire (.restore-*, -journal) résiduel à côté de la base", leftovers.length === 0);
    }
}
