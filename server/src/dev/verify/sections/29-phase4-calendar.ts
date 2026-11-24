// Phase 4 : contrats du planning hebdomadaire consommés par le client — api:verify section 29
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { ok } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { borne, sessionService, teacher } = ctx;
    let res: ApiResponse;

    console.log("── 29. Phase 4 : contrats du planning hebdomadaire consommés par le client ──");
    {
        const dbMod = await import("../../../db");
        const series29 = await import("../../../services/seriesService");
        const { setClock } = await import("../../../core/clock");
        const { FakeClock } = await import("../../../core/fakeClock");

        // Silence : rien d'autre ne doit polluer les fenêtres du calendrier.
        for (const s of sessionService.list()) {
            if (s.status === "running") await teacher.call("POST", `/api/sessions/${s.id}/stop`);
            if (s.status === "scheduled") await teacher.call("POST", `/api/sessions/${s.id}/cancel`);
        }
        for (const s of series29.listSeries()) {
            if (s.status === "active") series29.setSeriesStatus(s.id, "paused");
        }

        // Vendredi 20 mars 2026 : le passage à l'heure d'été européen tombe
        // le 29 mars EN PLEIN HORIZON — la navigation du calendrier et
        // l'heure murale doivent rester correctes de part et d'autre.
        const fake = new FakeClock("2026-03-20T12:00:00.000Z");
        const restoreClock = setClock(fake);
        try {
            res = await teacher.call("POST", "/api/groups", { name: "G-CAL29" });
            const g29 = res.body.data;
            res = await teacher.call("POST", "/api/series", {
                label: "Mercredi 29",
                recurrence: "weekly",
                weekday: 3,
                localTime: "08:30",
                timezone: "Europe/Paris",
                durationMinutes: 60,
                startsOn: "2026-03-04", // passé : l'horizon part d'aujourd'hui
                groupIds: [g29.id],
            });
            ok("POST /api/series (schéma exact du formulaire Phase 4) → 201", res.status === 201);
            const s29 = res.body.data;
            const gen29 = series29.generateOccurrences(s29.id);
            const occ29 = series29.listOccurrences(s29.id);
            const at = (d: string) => occ29.find((r) => r.occurrence_date === d)!;
            ok(
                "horizon roulant 12 semaines dès aujourd'hui : 12 mercredis, premier 2026-03-25, tous scheduled",
                gen29.created.length === 12 &&
                    occ29.length === 12 &&
                    occ29[0].occurrence_date === "2026-03-25" &&
                    occ29.every((r) => r.status === "scheduled"),
            );
            ok(
                "affichage fuseau : 08:30 heure murale DE PART ET D'AUTRE du passage à l'heure d'été, instants UTC décalés (07:30Z puis 06:30Z)",
                at("2026-03-25").scheduled_at === "2026-03-25T07:30:00.000Z" &&
                    at("2026-04-01").scheduled_at === "2026-04-01T06:30:00.000Z" &&
                    at("2026-04-01").local_time === "08:30" &&
                    at("2026-04-01").timezone === "Europe/Paris",
            );

            // ── Navigation par semaine (le client envoie lundi…dimanche) ──
            res = await teacher.call("GET", "/api/sessions/calendar?from=2026-03-23&to=2026-03-29");
            const weekA = (res.body.data as any[]).filter((r) => r.series_id === s29.id);
            ok(
                "navigation semaine inclusive [lun–dim] : exactement le mercredi 25, forme UI (group_ids tableau, participant_count numérique)",
                res.status === 200 &&
                    weekA.length === 1 &&
                    weekA[0].occurrence_date === "2026-03-25" &&
                    Array.isArray(weekA[0].group_ids) &&
                    typeof weekA[0].participant_count === "number",
            );
            res = await teacher.call("GET", "/api/sessions/calendar?from=2026-03-25&to=2026-03-25");
            ok("navigation : fenêtre d'une seule journée inclut ses deux bornes", (res.body.data as any[]).some((r) => r.id === at("2026-03-25").id));
            res = await teacher.call("GET", "/api/sessions/calendar?from=2026-03-16&to=2026-03-22");
            ok("navigation semaine précédente (avant la première occurrence) : semaine vide côté série", !(res.body.data as any[]).some((r) => r.series_id === s29.id));

            // ── Édition d'UNE occurrence : la géométrie remonte au calendrier ──
            res = await teacher.call("PATCH", `/api/sessions/${at("2026-03-25").id}`, {
                durationMinutes: 90,
                label: "Mercredi 29 — prolongé",
            });
            ok("PATCH /api/sessions/:id occurrence scheduled → 200", res.status === 200 && res.body.data.status === "scheduled");
            res = await teacher.call("GET", "/api/sessions/calendar?from=2026-03-23&to=2026-03-29");
            const row25 = (res.body.data as any[]).find((r) => r.id === at("2026-03-25").id);
            ok(
                "rechargement du calendrier : durée 90 visible, identité de série intacte (série toujours active)",
                row25.duration_minutes === 90 &&
                    row25.label === "Mercredi 29 — prolongé" &&
                    row25.series_id === s29.id &&
                    row25.occurrence_date === "2026-03-25" &&
                    row25.series_status === "active",
            );

            // ── « Cette occurrence et les suivantes » (PATCH /api/series/:id) ──
            res = await teacher.call("PATCH", `/api/series/${s29.id}`, {
                fromDate: "2026-03-25", // date de l'occurrence cliquée
                durationMinutes: 45,
            });
            const rEdit = res.body.data;
            ok(
                "édition série depuis l'occurrence : les 12 scheduled ≥ ancre réécrites (0 créée, 0 annulée), modèle à 45 min",
                res.status === 200 &&
                    rEdit.updated.length === 12 &&
                    rEdit.created.length === 0 &&
                    rEdit.cancelled.length === 0 &&
                    rEdit.skipped.length === 0 &&
                    rEdit.series.duration_minutes === 45,
            );
            ok(
                "aucune occurrence avant l'ancre n'existait (starts_on passé, horizon) : rien de préservé ni d'écrasé",
                rEdit.preserved.length === 0,
            );
            res = await teacher.call("GET", "/api/sessions/calendar?from=2026-03-30&to=2026-04-05");
            const rowApr1 = (res.body.data as any[]).find((r) => r.id === at("2026-04-01").id);
            ok("l'occurrence suivante vue du calendrier porte la nouvelle durée (45 min, heure murale inchangée)", rowApr1.duration_minutes === 45 && rowApr1.local_time === "08:30");

            // ── Annulation de la série À PARTIR de cette occurrence (body from) ──
            const expectedFuture = occ29.filter((r) => (r.occurrence_date ?? "") >= "2026-04-08").length;
            res = await teacher.call("POST", `/api/series/${s29.id}/cancel`, { from: "2026-04-08" });
            const rCancel = res.body.data;
            ok(
                "POST /api/series/:id/cancel {from} → modèle annulé ET exactement les scheduled ≥ from annulées",
                res.status === 200 &&
                    rCancel.series.status === "cancelled" &&
                    rCancel.cancelled.length === expectedFuture &&
                    (rCancel.cancelled as number[]).every((id) => dbMod.sessionRepository.findById(id)!.status === "cancelled"),
            );
            ok(
                "l'occurrence du 04-01, AVANT la date `from`, reste programmée (annulation à partir de, pas rétroactive)",
                dbMod.sessionRepository.findById(at("2026-04-01").id)!.status === "scheduled",
            );
            res = await teacher.call("POST", `/api/series/${s29.id}/cancel`);
            ok("seconde annulation de la série → 409 SERIES_CANCELLED (bouton rejoué)", res.status === 409 && res.body.error.code === "SERIES_CANCELLED");
            res = await teacher.call("POST", `/api/series/${s29.id}/resume`);
            ok("reprise après annulation → 409 SERIES_CANCELLED", res.status === 409);

            // ── Autorisation : le compte borne ne planifie pas ──
            res = await borne.call("POST", `/api/series/${s29.id}/pause`);
            ok("POST /api/series/:id/pause avec kiosk → 403 lecture seule", res.status === 403 && res.body.error.code === "FORBIDDEN");

            // ── Régressions : endpoints historiques intacts après Phase 4 ──
            res = await teacher.call("GET", "/api/sessions");
            ok("régression GET /api/sessions : group_ids partout", res.status === 200 && (res.body.data as any[]).every((s) => Array.isArray(s.group_ids)));
            res = await teacher.call("GET", "/api/reports/sessions");
            ok("régression GET /api/reports/sessions : 200 tableau", res.status === 200 && Array.isArray(res.body.data));

            // Rangement : les deux occurrences restées scheduled ne doivent
            // pas pouvoir s'auto-démarrer plus tard.
            for (const o of series29.listOccurrences(s29.id)) {
                if (o.status === "scheduled") await teacher.call("POST", `/api/sessions/${o.id}/cancel`);
            }
        } finally {
            restoreClock();
        }
    }
}
