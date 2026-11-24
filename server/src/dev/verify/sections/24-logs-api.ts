// Journaux serveur : tampon mémoire en lecture admin (GET /api/logs) — api:verify section 24
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { Client, ok, REMOTE_HEADERS } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { admin, base, teacher } = ctx;
    let res: ApiResponse;

    console.log("── 24. Journaux serveur : tampon mémoire en lecture admin (GET /api/logs) ──");
    {
        const { logger } = await import("../../../core/logger");
        const guest = new Client(base, REMOTE_HEADERS); // distant sans session : sonne l'alarme 401
        const vlog = logger.child({ component: "verify" });
        const tail = async (qs = ""): Promise<any[]> => {
            const r = await admin.call("GET", `/api/logs${qs}`);
            return (r.body.data ?? []) as any[];
        };
        const findIn = (rows: any[], event: string): any | undefined => rows.find((e) => e.event === event);

        // 1) Accès : admin seul. Anonyme distant → 401, teacher → 403 (le
        //    tampon peut porter des stack traces de 500 → jamais exposé
        //    aux autres ; la boucle locale anonyme → 403, section 31).
        res = await guest.call("GET", "/api/logs");
        ok("anonyme (distant) → 401 NOT_AUTHENTICATED", res.status === 401 && res.body.error.code === "NOT_AUTHENTICATED");
        res = await teacher.call("GET", "/api/logs");
        ok("teacher → 403 FORBIDDEN", res.status === 403 && res.body.error.code === "FORBIDDEN");
        res = await admin.call("GET", "/api/logs");
        ok(
            "admin → 200 { data:[], meta.capacity }",
            res.status === 200 &&
                Array.isArray(res.body.data) &&
                typeof res.body.meta.capacity === "number" &&
                res.body.meta.capacity >= 1,
        );

        // 2) Les lignes déjà émises par le serveur peuplent le tampon (le
        //    logger alimente le tampon indépendamment du sink de la
        //    section 22). Une erreur 500 antérieure doit être présente.
        const all = await tail();
        ok(
            "le tampon contient les lignes émises (événement + niveau + tri chronologique)",
            all.length > 0 &&
                all.every((e) => typeof e.seq === "number" && typeof e.level === "string" && typeof e.event === "string") &&
                all.every((e, i) => i === 0 || all[i - 1].seq <= e.seq),
        );

        // 3) Un marqueur émis maintenant est récupérable, AVEC les
        //    masquages du logger (mot de passe [redacted], uid tronqué).
        vlog.info("verify.tail_marker", { note: "visible", password: "SECRET-JAMAIS-DANS-LOGS", uid: "9000009" });
        const withMarker = await tail();
        const marker = findIn(withMarker, "verify.tail_marker");
        ok(
            "marqueur présent, level info, component verify, contexte non sensible intact",
            marker !== undefined &&
                marker.level === "info" &&
                marker.component === "verify" &&
                marker.fields.note === "visible",
        );
        ok(
            "masquage appliqué au tampon : password [redacted] + uid tronqué, secret jamais présent",
            marker.fields.password === "[redacted]" &&
                marker.fields.uid === "***0009" &&
                !JSON.stringify(marker.fields).includes("SECRET-JAMAIS-DANS-LOGS") &&
                !marker.line.includes("SECRET-JAMAIS-DANS-LOGS"),
        );

        // 4) Filtre par niveau exact : le marqueur (info) disparaît quand on
        //    ne demande que les erreurs.
        const errorsOnly = await tail("?level=error");
        ok("level=error : le marqueur info est filtré", findIn(errorsOnly, "verify.tail_marker") === undefined);
        ok("level=warn : aucune erreur mêlée", (await tail("?level=warn")).every((e) => e.level === "warn"));

        // 5) Fenêtre : limit borne le nombre de lignes (les plus récentes).
        const one = await tail("?limit=1");
        ok("limit=1 : au plus une ligne retournée", one.length === 1);

        // 6) Curseur incrémental (since) : uniquement les lignes d'après un
        //    seq donné — le mode « tail » du client.
        const markerSeq = marker.seq as number;
        vlog.info("verify.tail_after", { rank: 2 });
        const after = await tail(`?since=${markerSeq}`);
        ok(
            "since=<seq> : exclut le marqueur, inclut la ligne émise ensuite, tout > seq",
            findIn(after, "verify.tail_marker") === undefined &&
                findIn(after, "verify.tail_after") !== undefined &&
                after.every((e) => e.seq > markerSeq),
        );

        // 7) Validation des paramètres (même rigueur que le reste de l'API).
        res = await admin.call("GET", "/api/logs?level=critique");
        ok("level invalide → 400 VALIDATION_ERROR", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
        res = await admin.call("GET", "/api/logs?limit=0");
        ok("limit=0 → 400", res.status === 400);
        res = await admin.call("GET", "/api/logs?limit=999999");
        ok("limit démesuré → 400", res.status === 400);
    }
}
