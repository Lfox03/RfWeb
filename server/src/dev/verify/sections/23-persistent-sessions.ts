// Sessions d'authentification persistantes (SQLite, hash SHA-256, redémarrage) — api:verify section 23
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import fs from "node:fs";
import { ok } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { admin, base } = ctx;
    let res: ApiResponse;

    console.log("── 23. Sessions d'authentification persistantes (SQLite, hash SHA-256, redémarrage) ──");
    {
        const authService = await import("../../../services/authService");
        const dbMod = await import("../../../db");
        const { hashToken } = await import("../../../auth/sessionStore");
        const { SESSION_TTL_HOURS } = await import("../../../config/env");
        const ISO23 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
        const sessions = () => dbMod.authSessionRepository; // live binding (rebound on reopen)

        // Raw helpers (independent from the shared clients) to capture the
        // cookie token and probe authentication WITHOUT touching any state.
        const loginRaw = async (username: string, password: string): Promise<string> => {
            const r = await fetch(`${base}/api/auth/login`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ username, password }),
            });
            const tok = /sid=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")?.[1] ?? "";
            if (r.status !== 200 || !tok) throw new Error(`login raw inattendu (${r.status})`);
            return tok;
        };
        const whoami = async (token: string): Promise<number> =>
            (await fetch(`${base}/api/auth/me`, { headers: { cookie: `sid=${token}` } })).status;

        res = await admin.call("POST", "/api/users", { username: "persist1", password: "persist1-pass-123", role: "teacher" });
        ok("compte dédié à la persistance créé → 201", res.status === 201);
        // The repository is read from the MODULE (live binding): sections
        // 19-20 already swapped the underlying connection through a restore.
        const persistUser = dbMod.userRepository.findByUsername("persist1")!;

        // 1) Creation — the session becomes a persistent ROW, keyed by a hash.
        const count0 = sessions().count();
        const t1 = await loginRaw("persist1", "persist1-pass-123");
        ok("login → une ligne auth_sessions ajoutée (plus de Map mémoire)", sessions().count() === count0 + 1);
        const row1 = sessions().findByTokenHash(hashToken(t1));
        ok("session retrouvée par SHA-256(jeton), jamais par le jeton brut", row1 !== undefined && sessions().findByTokenHash(t1) === undefined);
        ok(
            "le jeton brut n'est JAMAIS stocké en clair dans la base",
            (dbMod.db.prepare("SELECT COUNT(*) AS c FROM auth_sessions WHERE token_hash = ?").get(t1) as { c: number }).c === 0 &&
                /^[0-9a-f]{64}$/.test(row1!.token_hash) &&
                row1!.token_hash !== t1,
        );
        ok(
            "horodatages created_at / expires_at / last_seen_at en ISO UTC",
            ISO23.test(row1!.created_at) && ISO23.test(row1!.expires_at) && ISO23.test(row1!.last_seen_at),
        );
        ok(
            "TTL persisté : expires_at = created_at + SESSION_TTL_HOURS",
            Date.parse(row1!.expires_at) - Date.parse(row1!.created_at) === SESSION_TTL_HOURS * 3_600_000,
        );
        ok(
            "jeton brut introuvable dans les OCTETS du fichier de base (et du WAL)",
            [process.env.DB_PATH!, `${process.env.DB_PATH!}-wal`]
                .filter((f) => fs.existsSync(f))
                .every((f) => !fs.readFileSync(f).toString("latin1").includes(t1)),
        );

        // 2) Concurrent sessions — two independent rows for the same account.
        const t1b = await loginRaw("persist1", "persist1-pass-123");
        ok(
            "sessions simultanées : deux jetons distincts tous deux valides",
            t1b !== t1 && (await whoami(t1)) === 200 && (await whoami(t1b)) === 200,
        );
        ok("deux lignes distinctes pour ce compte", new Set(sessions().listTokenHashesByUser(persistUser.id)).size === 2);

        // 3) Persistence across a restart — close and reopen the SAME file,
        //    exactly what the database restore does; the cookies still work.
        dbMod.reopenDatabase(dbMod.getCurrentDbPath());
        ok(
            "persistance après redémarrage simulé (base refermée/rouverte) : t1 et t1b toujours valides",
            (await whoami(t1)) === 200 && (await whoami(t1b)) === 200,
        );

        // 4) Logout — one row dies, the concurrent one survives.
        const logoutRes = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie: `sid=${t1}` } });
        ok("POST /api/auth/logout → 204", logoutRes.status === 204);
        ok("logout : la ligne de t1 est supprimée, t1 → 401", sessions().findByTokenHash(hashToken(t1)) === undefined && (await whoami(t1)) === 401);
        ok("session simultanée t1b toujours valide après le logout de t1", (await whoami(t1b)) === 200);

        // 5a) Expiration then request — lazy purge removes the row on rejection.
        ok("expiration simulée de t1b (TTL)", authService.expireSession(t1b));
        ok("session expirée → 401", (await whoami(t1b)) === 401);
        ok("ligne expirée nettoyée dès la résolution (purge paresseuse)", sessions().findByTokenHash(hashToken(t1b)) === undefined);

        // 5b) Expiration without any request — the periodic sweep cleans up.
        const tExp = await loginRaw("persist1", "persist1-pass-123");
        ok("expiration simulée sans requête (ligne encore présente avant purge)", authService.expireSession(tExp) && sessions().findByTokenHash(hashToken(tExp)) !== undefined);
        const purged = authService.purgeExpiredSessions();
        ok("purgeExpiredSessions retire les lignes expirées sans requête", purged >= 1 && sessions().findByTokenHash(hashToken(tExp)) === undefined);

        // 6) Password change invalidates the target's sessions, keeps the actor.
        const tVictim = await loginRaw("persist1", "persist1-pass-123");
        const rootToken = (admin.cookie ?? "").replace(/^sid=/, "");
        ok("session de la cible valide avant la réinitialisation", (await whoami(tVictim)) === 200);
        res = await admin.call("PATCH", `/api/users/${persistUser.id}`, { password: "persist1-new-123" });
        ok("réinitialisation du mot de passe (admin) → 200", res.status === 200);
        ok(
            "toutes les sessions de la cible invalidées (cookie 401 + aucune ligne en base)",
            (await whoami(tVictim)) === 401 && sessions().listTokenHashesByUser(persistUser.id).length === 0,
        );
        ok("session active de l'admin (root) préservée après sa réinitialisation", rootToken !== "" && (await whoami(rootToken)) === 200);

        // 7) Role change applies immediately to the SAME live session.
        const tRole = await loginRaw("persist1", "persist1-new-123");
        const as403 = await fetch(`${base}/api/users`, { headers: { cookie: `sid=${tRole}` } });
        ok("même cookie, rôle teacher : GET /api/users refusé (403)", as403.status === 403);
        await admin.call("PATCH", `/api/users/${persistUser.id}`, { role: "admin" });
        const as200 = await fetch(`${base}/api/users`, { headers: { cookie: `sid=${tRole}` } });
        ok("changement de rôle appliqué immédiatement sur la MÊME session (200)", as200.status === 200);
        ok(
            "le changement de rôle ne recrée pas la session (même jeton/hash toujours en base)",
            sessions().findByTokenHash(hashToken(tRole)) !== undefined && (await whoami(tRole)) === 200,
        );
        await admin.call("PATCH", `/api/users/${persistUser.id}`, { role: "teacher" }); // restore suite state
    }
}
