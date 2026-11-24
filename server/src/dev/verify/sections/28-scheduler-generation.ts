// Scheduler : génération roulante au démarrage/tick, isolation des échecs — api:verify section 28
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { ok } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { sessionService, teacher } = ctx;
    let res: ApiResponse;

    console.log("── 28. Scheduler : génération roulante au démarrage/tick, isolation des échecs ──");
    {
        const dbMod = await import("../../../db");
        const series28 = await import("../../../services/seriesService");
        const scheduler28 = await import("../../../services/schedulerService");
        const { setClock } = await import("../../../core/clock");
        const { FakeClock } = await import("../../../core/fakeClock");
        const { setLogSink } = await import("../../../core/logger");
        const root28 = dbMod.userRepository.findByUsername("root")!;

        // Silence total : aucune session en cours/programmée, aucune série
        // active hormis celles créées ici.
        for (const s of sessionService.list()) {
            if (s.status === "running") await teacher.call("POST", `/api/sessions/${s.id}/stop`);
            if (s.status === "scheduled") await teacher.call("POST", `/api/sessions/${s.id}/cancel`);
        }
        for (const s of series28.listSeries()) {
            if (s.status === "active") series28.setSeriesStatus(s.id, "paused");
        }

        const g28 = dbMod.groupRepository.create("G-SCHED28");
        dbMod.studentRepository.create({ firstName: "S28", groupId: g28.id });

        const fake = new FakeClock("2026-07-01T00:00:00.000Z");
        const restoreClock = setClock(fake);
        const captured: Array<{ level: string; record: any }> = [];
        const restoreSink = setLogSink((line, level, record) => captured.push({ level, record }));
        try {
            const sessionsOf = (seriesId: number) => series28.listOccurrences(seriesId);
            const countSessions = () => (dbMod.db.prepare("SELECT COUNT(*) AS c FROM app_sessions").get() as { c: number }).c;

            // 1) Le hook de démarrage matérialise l'horizon… en SCHEDULED seulement.
            const daily28 = series28.createSeries({
                label: "SCHED28 quotidien",
                recurrence: "daily",
                localTime: "07:00",
                timezone: "UTC",
                durationMinutes: 10,
                startsOn: "2026-07-01",
                groupIds: [g28.id],
                createdBy: root28.id,
            });
            scheduler28.runSeriesGeneration(); // appelé par startSessionScheduler au boot
            const genDaily = sessionsOf(daily28.id);
            ok(
                "démarrage : runSeriesGeneration matérialise l'horizon roulant, toutes SCHEDULED, rien de démarré",
                genDaily.length >= 30 && genDaily.every((r) => r.status === "scheduled") && sessionService.getActive() === null,
            );

            // 2) Le tick génère (fenêtre pas encore ouverte → pas de démarrage).
            const weekly28 = series28.createSeries({
                label: "SCHED28 lundi",
                recurrence: "weekly",
                weekday: 1,
                localTime: "09:00",
                timezone: "UTC",
                durationMinutes: 45,
                startsOn: "2026-07-01",
                groupIds: [g28.id],
                createdBy: root28.id,
            });
            scheduler28.runSchedulerTick();
            const genWeekly = sessionsOf(weekly28.id);
            ok(
                "tick : les lundis sont générés d'avance (première occurrence 07-06), aucune démarrée",
                genWeekly.length >= 8 && genWeekly[0].occurrence_date === "2026-07-06" && sessionService.getActive() === null,
            );

            // 3) Fenêtre atteinte → l'occurrence démarre automatiquement, roster figé.
            fake.set("2026-07-06T09:00:00.000Z");
            scheduler28.runSchedulerTick();
            const occStart = sessionsOf(weekly28.id).find((r) => r.occurrence_date === "2026-07-06")!;
            const rowStart = sessionService.get(occStart.id);
            ok(
                "tick à la fenêtre de l'occurrence : démarrage automatique + roster figé (groupe copié)",
                rowStart.status === "running" && rowStart.roster_frozen_at !== null && dbMod.sessionRosterRepository.countBySession(occStart.id) === 1,
            );
            ok("mono-lecteur : exactement une running après le tick", sessionService.list().filter((s) => s.status === "running").length === 1);

            // 4) Fin de fenêtre → arrêt automatique (auto_end), toujours sous génération active.
            fake.set("2026-07-06T09:45:00.000Z");
            scheduler28.runSchedulerTick();
            ok("fin de fenêtre : arrêt automatique (auto_end)", sessionService.get(occStart.id).status === "completed");

            // 5) Occurrence générée d'avance dont la fenêtre est déjà passée :
            //    pas de rattrapage, même produite par la génération du tick.
            fake.set("2026-07-13T12:00:00.000Z");
            scheduler28.runSchedulerTick();
            const occ13 = sessionsOf(weekly28.id).find((r) => r.occurrence_date === "2026-07-13");
            ok("pas de rattrapage pour une occurrence déjà écoulée à sa génération", occ13 !== undefined && sessionService.get(occ13.id).status === "scheduled");

            // 6) Isolation des échecs : une série cassée ne bloque JAMAIS le tick.
            const broken = series28.createSeries({
                label: "SCHED28 cassé",
                recurrence: "daily",
                localTime: "08:00",
                timezone: "UTC",
                durationMinutes: 30,
                startsOn: "2026-07-01",
                groupIds: [g28.id],
                createdBy: root28.id,
            });
            dbMod.db.prepare("UPDATE session_series SET timezone = ? WHERE id = ?").run("Not/AZone", broken.id); // fuseau invalide (contournement SQL)
            res = await teacher.call("POST", "/api/sessions", { label: "Fenêtre 28", groupId: g28.id, scheduledAt: "2026-07-13T12:00:00.000Z", durationMinutes: 30 });
            const sWindow = res.body.data;
            captured.length = 0;
            scheduler28.runSchedulerTick(); // ne doit PAS lever
            ok(
                "série cassée (fuseau invalide) : warn series.generation_failed journalisée avec series_id",
                captured.some((c) => c.level === "warn" && c.record.event === "series.generation_failed" && c.record.series_id === broken.id),
            );
            ok(
                "tick insensible à la série cassée : la session dans sa fenêtre démarre quand même (mono-lecteur respecté)",
                sessionService.get(sWindow.id).status === "running" &&
                    sessionService.list().filter((s) => s.status === "running").length === 1,
            );

            // 7) Aucune série active : la génération ne crée AUCUNE session
            //    (le démarrage ne peut donc jamais en inventer ni en démarrer).
            await teacher.call("POST", `/api/sessions/${sWindow.id}/stop`);
            for (const s of series28.listSeries()) {
                if (s.status === "active") series28.setSeriesStatus(s.id, "paused");
            }
            const countBefore = countSessions();
            scheduler28.runSeriesGeneration();
            ok(
                "aucune série active : génération = aucune session créée, aucune démarrée (démarrage inerte)",
                countSessions() === countBefore && sessionService.getActive() === null,
            );
        } finally {
            restoreSink();
            restoreClock();
        }
    }
}
