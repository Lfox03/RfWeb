// Séries récurrentes : API HTTP, calendrier et occurrence (Phase 3) — api:verify section 26
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { Client, ok, REMOTE_HEADERS } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { ada, alan, base, borne, g1, sessionService, teacher } = ctx;
    let res: ApiResponse;
    const scheduler = await import("../../../services/schedulerService"); // same tick driver as section 15

    console.log("── 26. Séries récurrentes : API HTTP, calendrier et occurrence (Phase 3) ──");
    {
        const seriesApi = await import("../../../services/seriesService");
        const dbMod = await import("../../../db");
        const { setClock } = await import("../../../core/clock");
        const { FakeClock } = await import("../../../core/fakeClock");
        const { sessionRepository: sessRepo26 } = await import("../../../db");

        // Neutralise : aucune session ni série ne doit troubler les ticks
        // ci-dessous (les séries des sections précédentes restent paused).
        for (const s of sessionService.list()) {
            if (s.status === "running") await teacher.call("POST", `/api/sessions/${s.id}/stop`);
            if (s.status === "scheduled") await teacher.call("POST", `/api/sessions/${s.id}/cancel`);
        }
        for (const s of seriesApi.listSeries()) {
            if (s.status === "active") seriesApi.setSeriesStatus(s.id, "paused");
        }

        const fake = new FakeClock("2026-06-01T12:00:00.000Z"); // lundi 1er juin 2026
        const restoreClock = setClock(fake);
        try {
            // ── Authentification et rôles (régression kiosk : lecture seule) ──
            const guest26 = new Client(base, REMOTE_HEADERS); // distant : la boucle locale aurait le borne
            res = await guest26.call("GET", "/api/series");
            ok("GET /api/series anonyme (distant) → 401 NOT_AUTHENTICATED", res.status === 401 && res.body.error.code === "NOT_AUTHENTICATED");
            res = await guest26.call("POST", "/api/series", { label: "x", localTime: "08:00", startsOn: "2026-06-01", groupIds: [g1.id] });
            ok("POST /api/series anonyme → 401", res.status === 401);
            res = await borne.call("GET", "/api/series");
            ok("GET /api/series avec kiosk → 200 (lecture autorisée)", res.status === 200);
            res = await borne.call("POST", "/api/series", { label: "Interdite", localTime: "08:00", startsOn: "2026-06-01", groupIds: [g1.id] });
            ok("POST /api/series avec kiosk → 403 lecture seule", res.status === 403 && res.body.error.code === "FORBIDDEN");
            res = await borne.call("POST", "/api/series/1/cancel");
            ok("POST /api/series/:id/cancel avec kiosk → 403", res.status === 403);
            res = await borne.call("PATCH", "/api/sessions/1", { label: "x" });
            ok("PATCH /api/sessions/:id avec kiosk → 403 lecture seule", res.status === 403);
            res = await borne.call("GET", "/api/sessions/calendar?from=2026-06-01&to=2026-06-07");
            ok("GET /api/sessions/calendar avec kiosk → 200 (lecture autorisée)", res.status === 200);

            // ── Validation (forme côté route, sémantique côté service) ──
            res = await teacher.call("POST", "/api/series", { label: "Sans localTime", startsOn: "2026-06-01", groupIds: [g1.id] });
            ok("localTime manquant → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
            res = await teacher.call("POST", "/api/series", { localTime: "08:00", startsOn: "2026-06-01", groupIds: [g1.id] });
            ok("label manquant → 400", res.status === 400);
            res = await teacher.call("POST", "/api/series", { label: "x", localTime: "8:30", startsOn: "2026-06-01", groupIds: [g1.id] });
            ok("localTime « 8:30 » → 400 (HH:MM strict)", res.status === 400);
            res = await teacher.call("POST", "/api/series", { label: "x", localTime: "08:00", startsOn: "2026-6-01", groupIds: [g1.id] });
            ok("startsOn « 2026-6-01 » → 400", res.status === 400);
            res = await teacher.call("POST", "/api/series", { label: "x", localTime: "08:00", startsOn: "2026-02-30", groupIds: [g1.id] });
            ok("startsOn 2026-02-30 (jour que SQLite normaliserait) → 400", res.status === 400);
            res = await teacher.call("POST", "/api/series", { label: "x", localTime: "08:00", recurrence: "mensuelle", startsOn: "2026-06-01", groupIds: [g1.id] });
            ok("récurrence invalide → 400", res.status === 400);
            res = await teacher.call("POST", "/api/series", { label: "x", localTime: "08:00", recurrence: "weekly", startsOn: "2026-06-01", groupIds: [g1.id] });
            ok("weekly sans weekday → 400", res.status === 400);
            res = await teacher.call("POST", "/api/series", { label: "x", localTime: "08:00", recurrence: "daily", weekday: 3, startsOn: "2026-06-01", groupIds: [g1.id] });
            ok("daily avec weekday → 400", res.status === 400);
            res = await teacher.call("POST", "/api/series", { label: "x", localTime: "08:00", startsOn: "2026-06-08", endsOn: "2026-06-01", groupIds: [g1.id] });
            ok("endsOn < startsOn → 400", res.status === 400);
            res = await teacher.call("POST", "/api/series", { label: "x", localTime: "08:00", startsOn: "2026-06-01", groupIds: [987654] });
            ok("groupe inexistant → 400", res.status === 400);
            res = await teacher.call("POST", "/api/series", { label: "x", localTime: "08:00", startsOn: "2026-06-01" });
            ok("sans groupIds → 400", res.status === 400);
            res = await teacher.call("POST", "/api/series", { label: "x", localTime: "08:00", startsOn: "2026-06-01", groupIds: [g1.id], scheduledAt: "2026-06-01T08:00:00.000Z" });
            ok("champ inconnu (scheduledAt) → 400", res.status === 400);
            res = await teacher.call("POST", "/api/series", { label: "x", localTime: "08:00", startsOn: "2026-06-01", groupIds: [g1.id], participants: [{ studentId: ada.id, included: "oui" }] });
            ok("participant : included non booléen → 400", res.status === 400);
            res = await teacher.call("POST", "/api/series", { label: "x", localTime: "08:00", startsOn: "2026-06-01", groupIds: [g1.id], participants: [{ studentId: ada.id, included: true, why: "?" }] });
            ok("participant : champ inconnu → 400", res.status === 400);
            res = await teacher.call("POST", "/api/series", { label: "x", localTime: "08:00", startsOn: "2026-06-01", groupIds: [g1.id], participants: [{ studentId: 987654, included: true }] });
            ok("participant : étudiant inconnu → 400 (service)", res.status === 400);
            res = await teacher.call("GET", "/api/series/abc");
            ok("GET /api/series/abc → 400", res.status === 400);
            res = await teacher.call("GET", "/api/series/987654");
            ok("GET série inconnue → 404", res.status === 404 && res.body.error.code === "NOT_FOUND");

            // ── Création, lecture, génération par tick ──
            res = await teacher.call("POST", "/api/series", {
                label: "API lundi",
                recurrence: "weekly",
                weekday: 1,
                localTime: "08:30",
                timezone: "UTC",
                durationMinutes: 45,
                startsOn: "2026-06-01",
                groupIds: [g1.id],
                participants: [{ studentId: alan.id, included: true }],
            });
            const sApi = res.body.data;
            ok(
                "POST /api/series (teacher) → 201 active, group_ids et patron portés",
                res.status === 201 &&
                    sApi.status === "active" &&
                    sApi.weekday === 1 &&
                    sApi.local_time === "08:30" &&
                    JSON.stringify(sApi.group_ids) === JSON.stringify([g1.id]),
            );
            res = await teacher.call("GET", `/api/series/${sApi.id}`);
            ok(
                "GET /api/series/:id → détail avec participants",
                res.status === 200 &&
                    (res.body.data.participants as any[]).length === 1 &&
                    res.body.data.participants[0].student_id === alan.id &&
                    res.body.data.participants[0].included === 1,
            );
            res = await teacher.call("GET", "/api/series");
            ok(
                "GET /api/series → liste enrichie (group_ids tableaux)",
                res.status === 200 &&
                    (res.body.data as any[]).every((s) => Array.isArray(s.group_ids)) &&
                    (res.body.data as any[]).some((s) => s.id === sApi.id),
            );

            scheduler.runSchedulerTick(); // la génération fait partie du tick
            const apiOccs = seriesApi.listOccurrences(sApi.id);
            ok(
                "génération par tick : 13 lundis (horizon 12 semaines) tous SCHEDULED, aucune session démarrée",
                apiOccs.length === 13 &&
                    apiOccs[0].occurrence_date === "2026-06-01" &&
                    apiOccs.every((r) => r.status === "scheduled") &&
                    sessionService.getActive() === null,
            );

            // ── GET /api/sessions/calendar ──
            res = await teacher.call("POST", "/api/sessions", { label: "Autonome juin", groupId: g1.id, scheduledAt: "2026-06-01T23:00:00.000Z" });
            const sStandalone = res.body.data;
            res = await teacher.call("GET", "/api/sessions/calendar?to=2026-06-30");
            ok("calendar sans from → 400 (bornes obligatoires)", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
            res = await teacher.call("GET", "/api/sessions/calendar?from=non&to=2026-06-30");
            ok("calendar date invalide → 400", res.status === 400);
            res = await teacher.call("GET", "/api/sessions/calendar?from=2026-02-30&to=2026-03-01");
            ok("calendar date inexistante 2026-02-30 → 400", res.status === 400);
            res = await teacher.call("GET", "/api/sessions/calendar?from=2026-06-30&to=2026-06-01");
            ok("calendar plage inversée → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");

            res = await teacher.call("POST", "/api/series", {
                label: "API lundi New York",
                recurrence: "weekly",
                weekday: 1,
                localTime: "23:30",
                timezone: "America/New_York",
                durationMinutes: 30,
                startsOn: "2026-06-01",
                groupIds: [g1.id],
            });
            const sNy = res.body.data;
            seriesApi.generateOccurrences(sNy.id);
            const nyOcc = seriesApi.listOccurrences(sNy.id).find((r) => r.occurrence_date === "2026-06-01")!;
            ok("occurrence fuseau local : 06-01 23:30 New York = 06-02 03:30Z", nyOcc.scheduled_at === "2026-06-02T03:30:00.000Z");
            res = await teacher.call("GET", "/api/sessions/calendar?from=2026-06-01&to=2026-06-01");
            ok(
                "calendar filtre à la date LOCALE : occurrence New York au 01-06, jamais à une autre date locale",
                (res.body.data as any[]).some((r) => r.id === nyOcc.id) &&
                    (res.body.data as any[]).every((r) => r.occurrence_date === null || r.occurrence_date === "2026-06-01"),
            );
            res = await teacher.call("GET", "/api/sessions/calendar?from=2026-06-02&to=2026-06-02");
            ok("calendar : l'occurrence New York ABSENTE du 02-06 (son jour UTC) — la date locale fait foi", !(res.body.data as any[]).some((r) => r.id === nyOcc.id));

            res = await teacher.call("GET", "/api/sessions/calendar?from=2026-06-01&to=2026-06-30");
            const june = res.body.data as any[];
            const juneOwn = june.filter((r) => r.series_id === sApi.id);
            const rowJune1 = juneOwn.find((r) => r.occurrence_date === "2026-06-01");
            ok(
                "calendar juin « API lundi » : 5 lundis triés, métadonnées série + groupes + comptage attendus (2 = groupe + inclusion)",
                juneOwn.length === 5 &&
                    juneOwn.every((r, i, a) => i === 0 || a[i - 1].scheduled_at <= r.scheduled_at) &&
                    rowJune1.series_label === "API lundi" &&
                    rowJune1.series_status === "active" &&
                    rowJune1.series_recurrence === "weekly" &&
                    rowJune1.local_time === "08:30" &&
                    typeof rowJune1.group_name === "string" &&
                    rowJune1.group_name.includes("G1-bis") &&
                    Array.isArray(rowJune1.group_ids) &&
                    rowJune1.group_ids.length === 1 &&
                    rowJune1.participant_count === 2,
            );
            ok(
                "calendar : session autonome matchée au jour UTC de scheduled_at (series_id NULL, comptage live = 1)",
                june.some((r) => r.id === sStandalone.id && r.series_id === null && r.participant_count === 1),
            );

            // ── PATCH /api/sessions/:id (une occurrence scheduled) ──
            res = await teacher.call("PATCH", `/api/sessions/${nyOcc.id}`, { label: "Occurrence déplacée", durationMinutes: 90 });
            ok(
                "PATCH occurrence scheduled : label/durée modifiés, identité de série intacte",
                res.status === 200 &&
                    res.body.data.label === "Occurrence déplacée" &&
                    res.body.data.duration_minutes === 90 &&
                    res.body.data.series_id === sNy.id &&
                    res.body.data.occurrence_date === "2026-06-01" &&
                    res.body.data.status === "scheduled",
            );
            res = await teacher.call("PATCH", `/api/sessions/${nyOcc.id}`, { scheduledAt: "2026-06-01T23:30:00.000Z" });
            ok(
                "PATCH scheduledAt sur occurrence de série → 409 SESSION_OCCURRENCE_MOVE (Phase 5 : l'instant suit le créneau local de la série)",
                res.status === 409 && res.body.error.code === "SESSION_OCCURRENCE_MOVE",
            );
            ok(
                "l'occurrence garde son instant d'origine (aucune écriture partielle)",
                sessRepo26.findById(nyOcc.id)!.scheduled_at === "2026-06-02T03:30:00.000Z",
            );
            res = await teacher.call("PATCH", `/api/sessions/${sStandalone.id}`, { scheduledAt: "2026-06-05T09:00:00.000Z" });
            ok(
                "PATCH scheduledAt session AUTONOME scheduled → 200 (déplacement hors série toujours permis)",
                res.status === 200 && res.body.data.scheduled_at === "2026-06-05T09:00:00.000Z",
            );
            res = await teacher.call("PATCH", `/api/sessions/${nyOcc.id}`, {});
            ok("PATCH sans champ → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
            res = await teacher.call("PATCH", `/api/sessions/${nyOcc.id}`, { statut: "running" });
            ok("PATCH champ inconnu → 400", res.status === 400);
            res = await teacher.call("PATCH", "/api/sessions/987654", { label: "x" });
            ok("PATCH session inconnue → 404", res.status === 404 && res.body.error.code === "NOT_FOUND");
            res = await teacher.call("POST", `/api/sessions/${sStandalone.id}/start`);
            ok("démarrage manuel (pour tester le refus PATCH)", res.status === 200 && res.body.data.status === "running");
            res = await teacher.call("PATCH", `/api/sessions/${sStandalone.id}`, { label: "Trop tard" });
            ok("PATCH session running → 409 SESSION_INVALID_TRANSITION", res.status === 409 && res.body.error.code === "SESSION_INVALID_TRANSITION");
            await teacher.call("POST", `/api/sessions/${sStandalone.id}/stop`);

            // ── PATCH /api/series/:id (édition depuis une occurrence) ──
            res = await teacher.call("PATCH", `/api/series/${sApi.id}`, { fromDate: "2026-06-15", localTime: "10:30" });
            const rEdit = res.body.data;
            ok(
                "PATCH série « à partir de » : 11 futures scheduled réécrites (0 annulée, 0 créée, 0 préservée)",
                res.status === 200 &&
                    rEdit.updated.length === 11 &&
                    rEdit.cancelled.length === 0 &&
                    rEdit.created.length === 0 &&
                    rEdit.preserved.length === 0 &&
                    rEdit.series.local_time === "10:30",
            );
            const occJune8 = seriesApi.listOccurrences(sApi.id).find((r) => r.occurrence_date === "2026-06-08")!;
            const occJune15 = seriesApi.listOccurrences(sApi.id).find((r) => r.occurrence_date === "2026-06-15")!;
            ok(
                "instants réécrits : 06-15 à 10:30, 06-08 (avant l'ancre) intact à 08:30",
                occJune15.scheduled_at === "2026-06-15T10:30:00.000Z" && occJune8.scheduled_at === "2026-06-08T08:30:00.000Z",
            );
            res = await teacher.call("PATCH", `/api/series/${sApi.id}`, { fromDate: "2026-06-16", localTime: "11:00" });
            ok("ancre sans occurrence (mardi) → 404 NOT_FOUND", res.status === 404 && res.body.error.code === "NOT_FOUND");
            res = await teacher.call("PATCH", `/api/series/${sApi.id}`, { fromDate: "2026-02-30", localTime: "11:00" });
            ok("fromDate invalide → 400", res.status === 400);
            res = await teacher.call("PATCH", `/api/series/${sApi.id}`, { fromDate: "2026-06-15", participants: [{ studentId: ada.id, included: true }] });
            ok(
                "PATCH série « participants » éditable (Phase 5) → 200, les 11 scheduled ≥ ancre réécrites",
                res.status === 200 && (res.body.data.updated as number[]).length === 11,
            );
            res = await teacher.call("GET", `/api/series/${sApi.id}`);
            ok(
                "deltas série REMPLACÉS : l'inclusion d'alan a disparu, seule celle d'ada porte",
                res.status === 200 &&
                    (res.body.data.participants as any[]).length === 1 &&
                    res.body.data.participants[0].student_id === ada.id &&
                    res.body.data.participants[0].included === 1,
            );
            res = await teacher.call("PATCH", "/api/series/987654", { fromDate: "2026-06-15", localTime: "11:00" });
            ok("PATCH série inconnue → 404", res.status === 404);

            // ── Pause / reprise ──
            res = await teacher.call("POST", "/api/series", { label: "API pause", recurrence: "daily", localTime: "07:00", startsOn: "2026-06-01", groupIds: [g1.id] });
            const sPause = res.body.data;
            scheduler.runSchedulerTick();
            const countPaused0 = seriesApi.listOccurrences(sPause.id).length;
            ok("tick : génération horizon de « API pause » (> 80 quotidiennes)", countPaused0 > 80);
            res = await teacher.call("POST", `/api/series/${sPause.id}/pause`);
            ok("POST /api/series/:id/pause → paused", res.status === 200 && res.body.data.status === "paused");
            fake.set("2026-06-15T12:00:00.000Z");
            scheduler.runSchedulerTick();
            ok("série paused : le tick ne matérialise rien de nouveau", seriesApi.listOccurrences(sPause.id).length === countPaused0);
            res = await teacher.call("POST", `/api/series/${sPause.id}/resume`);
            ok("POST /api/series/:id/resume → active", res.status === 200 && res.body.data.status === "active");
            scheduler.runSchedulerTick();
            ok("série reprise : horizon roulant prolongé (nouvelles occurrences)", seriesApi.listOccurrences(sPause.id).length > countPaused0);

            // ── Annulation de la série : futur planifié annulé, historique intact ──
            const occs26 = seriesApi.listOccurrences(sApi.id);
            const at26 = (d: string) => occs26.find((r) => r.occurrence_date === d)!;
            const oDone = at26("2026-06-01");
            const oRunning = at26("2026-06-08");
            const oAlready = at26("2026-06-22");
            sessRepo26.start(oDone.id);
            sessRepo26.complete(oDone.id);
            dbMod.attendanceRepository.recordScan({ sessionId: oDone.id, studentId: ada.id, uid: "123" });
            sessRepo26.start(oRunning.id); // running (repository, pas de boucle/WS)
            await sessionService.cancel(oAlready.id);
            // l'horizon roulant a pu matérialiser des lundis supplémentaires entre-temps : attendu dynamique
            const expectedCancelled = seriesApi
                .listOccurrences(sApi.id)
                .filter((r) => r.status === "scheduled" && (r.occurrence_date ?? "") >= "2026-06-15").length;
            res = await teacher.call("POST", `/api/series/${sApi.id}/cancel`);
            const rCancel = res.body.data;
            ok(
                "POST /api/series/:id/cancel → cancelled ET toutes les occurrences futures scheduled annulées",
                res.status === 200 &&
                    rCancel.series.status === "cancelled" &&
                    expectedCancelled >= 10 &&
                    rCancel.cancelled.length === expectedCancelled &&
                    (rCancel.cancelled as number[]).every((id) => sessRepo26.findById(id)!.status === "cancelled"),
            );
            ok(
                "annulation de série : running / completed / déjà-annulée PRÉSERVÉES, présence historique conservée",
                sessRepo26.findById(oRunning.id)!.status === "running" &&
                    sessRepo26.findById(oDone.id)!.status === "completed" &&
                    sessRepo26.findById(oAlready.id)!.status === "cancelled" &&
                    (dbMod.db.prepare("SELECT COUNT(*) AS c FROM app_attendances WHERE session_id = ?").get(oDone.id) as { c: number }).c === 1,
            );
            res = await teacher.call("POST", `/api/series/${sApi.id}/cancel`);
            ok("seconde annulation → 409 SERIES_CANCELLED", res.status === 409 && res.body.error.code === "SERIES_CANCELLED");
            res = await teacher.call("POST", `/api/series/${sApi.id}/resume`);
            ok("reprise après annulation → 409 SERIES_CANCELLED", res.status === 409 && res.body.error.code === "SERIES_CANCELLED");
            res = await teacher.call("PATCH", `/api/series/${sApi.id}`, { fromDate: "2026-07-06", localTime: "09:00" });
            ok("édition après annulation → 409 SERIES_CANCELLED", res.status === 409 && res.body.error.code === "SERIES_CANCELLED");

            // ── Régression : endpoints existants inchangés ──
            res = await teacher.call("GET", "/api/sessions");
            ok("régression GET /api/sessions : group_ids toujours exposés", res.status === 200 && (res.body.data as any[]).every((s) => Array.isArray(s.group_ids)));
            res = await teacher.call("GET", "/api/reports/sessions");
            ok("régression GET /api/reports/sessions : réponse inchangée", res.status === 200 && Array.isArray(res.body.data));
        } finally {
            restoreClock();
        }
    }
}
