// Rate limiting of POST /api/auth/login (anti-brute-force) — api:verify section 17
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { ok } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { admin, base } = ctx;
    let res: ApiResponse;

    console.log("── 17. Rate limiting of POST /api/auth/login (anti-brute-force) ──");
    {
        const { resetLoginRateLimits, shiftLoginRateLimitClock } = await import("../../../api/middleware/loginRateLimit");
        const rateCfg = await import("../../../config/env");

        const loginRaw = async (
            body: unknown,
            headers?: Record<string, string>,
        ): Promise<{ status: number; body: any; retryAfter: string | null }> => {
            const r = await fetch(`${base}/api/auth/login`, {
                method: "POST",
                headers: { "content-type": "application/json", ...(headers ?? {}) },
                body: JSON.stringify(body),
            });
            let parsed: any = null;
            const t = await r.text();
            if (t) {
                try {
                    parsed = JSON.parse(t);
                } catch {
                    /* empty response */
                }
            }
            return { status: r.status, body: parsed, retryAfter: r.headers.get("retry-after") };
        };

        ok(
            "réglages par défaut du limiteur (10/IP, 5/utilisateur, 15 min, backoff 30 s)",
            rateCfg.LOGIN_FAIL_LIMIT_PER_IP === 10 &&
                rateCfg.LOGIN_FAIL_LIMIT_PER_USER === 5 &&
                rateCfg.LOGIN_RATE_WINDOW_MINUTES === 15 &&
                rateCfg.LOGIN_BACKOFF_BASE_SECONDS === 30 &&
                rateCfg.LOGIN_BACKOFF_MAX_MINUTES === 15,
        );

        resetLoginRateLimits();
        res = await admin.call("POST", "/api/users", { username: "fragile", password: "fragile-pass-123", role: "teacher" });
        ok("utilisateur « fragile » dédié au limiteur créé → 201", res.status === 201);

        // ── Dimension par NOM D'UTILISATEUR : seuil → verrouillage ──
        let failedAttempts = 0;
        for (let i = 1; i <= rateCfg.LOGIN_FAIL_LIMIT_PER_USER; i++) {
            const r = await loginRaw({ username: "fragile", password: `mauvais-${i}` });
            if (r.status === 401 && r.body.error.code === "INVALID_CREDENTIALS") failedAttempts += 1;
        }
        ok(
            `${rateCfg.LOGIN_FAIL_LIMIT_PER_USER} mots de passe erronés (fragile) → 401 à chaque tentative`,
            failedAttempts === rateCfg.LOGIN_FAIL_LIMIT_PER_USER,
        );

        const lockedFragile = await loginRaw({ username: "fragile", password: "fragile-pass-123" });
        ok(
            "mot de passe correct juste après le seuil → 429 RATE_LIMITED (enveloppe {error})",
            lockedFragile.status === 429 &&
                lockedFragile.body.error.code === "RATE_LIMITED" &&
                typeof lockedFragile.body.error.message === "string",
        );
        ok(
            "429 avec Retry-After (entier, 1 à 30 s)",
            /^\d+$/.test(lockedFragile.retryAfter ?? "") &&
                Number(lockedFragile.retryAfter) >= 1 &&
                Number(lockedFragile.retryAfter) <= 30,
        );
        const malformedLocked = await loginRaw({ username: "fragile" });
        ok("requête mal formée pendant le verrouillage → 429 (pas 400 — cohérent)", malformedLocked.status === 429);
        const otherUser = await loginRaw({ username: "root", password: "root-pass-123" });
        ok("autre utilisateur non affecté par le verrouillage de « fragile » → 200", otherUser.status === 200);

        shiftLoginRateLimitClock(31_000); // expiration simulée du verrouillage (30 s)
        const fragileBack = await loginRaw({ username: "fragile", password: "fragile-pass-123" });
        ok("verrouillage expiré (temps simulé) → login correct de nouveau accepté", fragileBack.status === 200);

        // ── Dimension par IP : varier les noms d'utilisateur ne trompe pas ──
        let sprayed = 0;
        for (let i = 1; i <= rateCfg.LOGIN_FAIL_LIMIT_PER_IP; i++) {
            const r = await loginRaw({ username: `probe-${String(i).padStart(2, "0")}`, password: "pas-le-bon" });
            if (r.status === 401) sprayed += 1;
        }
        ok(
            `${rateCfg.LOGIN_FAIL_LIMIT_PER_IP} noms d'utilisateur distincts refusés → 401 chacun (le compteur IP s'accumule)`,
            sprayed === rateCfg.LOGIN_FAIL_LIMIT_PER_IP,
        );
        const bypassAttempt = await loginRaw({ username: "root", password: "root-pass-123" });
        ok(
            "login correct après le seuil IP → 429 (varier les usernames ne contourne pas la limite)",
            bypassAttempt.status === 429 && bypassAttempt.body.error.code === "RATE_LIMITED",
        );
        ok(
            "messages 429 identiques (utilisateur existant verrouillé vs IP) → aucune divulgation d'existence",
            bypassAttempt.body.error.message === lockedFragile.body.error.message,
        );
        const otherIp = await loginRaw({ username: "root", password: "root-pass-123" }, { "x-forwarded-for": "9.9.9.9" });
        ok(
            "même login refusé depuis une autre IP (X-Forwarded-For, TRUST_PROXY=1) → 200 (isolation par IP)",
            otherIp.status === 200,
        );

        // ── Backoff progressif : chaque dépassement double la durée ──
        shiftLoginRateLimitClock(31_000); // premier verrouillage IP (30 s) expiré
        const probeAgain = await loginRaw({ username: "probe-99", password: "pas-le-bon" });
        ok("échec autorisé après expiration du court verrouillage → 401", probeAgain.status === 401);
        const lockedHarder = await loginRaw({ username: "root", password: "root-pass-123" });
        ok(
            "second verrouillage plus long que le premier (30 s → 60 s)",
            lockedHarder.status === 429 && Number(lockedHarder.retryAfter) > 30 && Number(lockedHarder.retryAfter) <= 60,
        );

        // ── Expiration + remise à zéro par un login réussi ──
        shiftLoginRateLimitClock(61_000);
        const finalOk = await loginRaw({ username: "root", password: "root-pass-123" });
        ok("second verrouillage expiré → login réussi (remet les compteurs à zéro)", finalOk.status === 200);
        let afterReset = 0;
        for (let i = 1; i <= rateCfg.LOGIN_FAIL_LIMIT_PER_IP - 1; i++) {
            const r = await loginRaw({ username: `reset-${String(i).padStart(2, "0")}`, password: "pas-le-bon" });
            if (r.status === 401) afterReset += 1;
        }
        ok(
            "compteurs remis à zéro par le succès : 9 nouvelles tentatives toutes en 401 (aucun blocage anticipé)",
            afterReset === rateCfg.LOGIN_FAIL_LIMIT_PER_IP - 1,
        );
        resetLoginRateLimits(); // la suite se termine sans verrouillage résiduel
    }
}
