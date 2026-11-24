// Phase 5 : provenance des appartenances, propagation d'édition, resync WS — api:verify section 30
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { ok } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { httpPort, sessionService, teacher } = ctx;
    let res: ApiResponse;
    const scheduler = await import("../../../services/schedulerService"); // same tick driver as section 15

    console.log("── 30. Phase 5 : provenance des appartenances, propagation d'édition, resync WS ──");
    {
        const db30 = await import("../../../db");
        const series30 = await import("../../../services/seriesService");
        const { setClock } = await import("../../../core/clock");
        const { FakeClock } = await import("../../../core/fakeClock");
        const { sessionParticipantRepository: deltas30, sessionRepository: sessRepo30, sessionRosterRepository: roster30 } = db30;

        // Silence : rien d'autre ne doit troubler ticks ni diffusions.
        for (const s of sessionService.list()) {
            if (s.status === "running") await teacher.call("POST", `/api/sessions/${s.id}/stop`);
            if (s.status === "scheduled") await teacher.call("POST", `/api/sessions/${s.id}/cancel`);
        }
        for (const s of series30.listSeries()) {
            if (s.status === "active") series30.setSeriesStatus(s.id, "paused");
        }

        const fake = new FakeClock("2026-06-01T12:00:00.000Z"); // lundi 1er juin 2026
        const restoreClock = setClock(fake);

        // Le point de vue du client du calendrier : on écoute series:changed.
        const { WebSocket } = await import("ws");
        const ws30 = new WebSocket(`ws://127.0.0.1:${httpPort}/ws`, { headers: { cookie: teacher.cookie ?? "" } });
        ws30.on("error", () => { /* la clôture en finally suffit */ });
        const seriesEvents: any[] = [];
        ws30.on("message", (m: Buffer) => {
            const msg = JSON.parse(m.toString());
            if (msg.event === "series:changed") seriesEvents.push(msg.content);
        });
        const eventSeen = (pred: (e: any) => boolean): Promise<any> =>
            new Promise((resolve, reject) => {
                const t0 = Date.now();
                const poll = (): void => {
                    const hit = seriesEvents.find(pred);
                    if (hit) resolve(hit);
                    else if (Date.now() - t0 > 3000) reject(new Error("timeout series:changed"));
                    else setTimeout(poll, 25);
                };
                poll();
            });
        const generatedCount = (sid: number): number =>
            seriesEvents.filter((e) => e.action === "generated" && e.series_id === sid).length;

        try {
            // Données dédiées
            res = await teacher.call("POST", "/api/groups", { name: "G-P5A" });
            const gA = res.body.data;
            res = await teacher.call("POST", "/api/groups", { name: "G-P5B" });
            const gB = res.body.data;
            res = await teacher.call("POST", "/api/students", { firstName: "Ines", lastName: "P5", groupId: gA.id });
            const ines = res.body.data;
            res = await teacher.call("POST", "/api/students", { firstName: "Nino", lastName: "P5" }); // hors groupe
            const nino = res.body.data;
            res = await teacher.call("POST", "/api/students", { firstName: "Lova", lastName: "P5", groupId: gA.id });
            const lova = res.body.data;

            // ── création + génération : la provenance est écrite ──
            res = await teacher.call("POST", "/api/series", {
                label: "P5 lundi",
                recurrence: "weekly",
                weekday: 1,
                localTime: "08:00",
                timezone: "UTC",
                durationMinutes: 60,
                startsOn: "2026-06-01",
                groupIds: [gA.id],
                participants: [{ studentId: nino.id, included: true }],
            });
            const s30 = res.body.data;
            ok("POST /api/series (schéma Phase 5 avec participants) → 201", res.status === 201);
            const evCreated = await eventSeen((e) => e.action === "created" && e.series_id === s30.id);
            ok("WS series:changed « created » reçu", evCreated.action === "created" && evCreated.series_id === s30.id);

            scheduler.runSchedulerTick();
            const occs30 = series30.listOccurrences(s30.id);
            const atP5 = (d: string) => occs30.find((r) => r.occurrence_date === d)!;
            ok("tick : 13 lundis matérialisés, tous scheduled", occs30.length === 13 && occs30.every((r) => r.status === "scheduled"));
            const occJune1 = atP5("2026-06-01");
            const occJune8 = atP5("2026-06-08");
            const occJune15 = atP5("2026-06-15");
            const grpRows = (sid: number) =>
                db30.db.prepare("SELECT group_id, inherited FROM session_groups WHERE session_id = ? ORDER BY group_id").all(sid) as Array<{ group_id: number; inherited: number }>;
            const deltaRows = (sid: number) =>
                db30.db.prepare("SELECT student_id, included, inherited FROM session_participants WHERE session_id = ? ORDER BY student_id").all(sid) as Array<{ student_id: number; included: number; inherited: number }>;
            ok(
                "génération : groupes et deltas de chaque occurrence portent inherited = 1 (copies de la série)",
                JSON.stringify(grpRows(occJune1.id)) === JSON.stringify([{ group_id: gA.id, inherited: 1 }]) &&
                    JSON.stringify(deltaRows(occJune1.id)) === JSON.stringify([{ student_id: nino.id, included: 1, inherited: 1 }]),
            );
            const evGen1 = await eventSeen((e) => e.action === "generated" && e.series_id === s30.id);
            ok("WS series:changed « generated » reçu avec le nombre créé", evGen1.occurrences === 13);

            // Idempotence : rien ne se rematchérialise, aucune diffusion superflue.
            const genBefore = generatedCount(s30.id);
            scheduler.runSchedulerTick();
            const genIdem = series30.generateOccurrences(s30.id);
            ok(
                "idempotence : regénération = 0 créée, 13 existantes, aucun « generated » de plus",
                genIdem.created.length === 0 && genIdem.existing === 13 && generatedCount(s30.id) === genBefore,
            );

            // ── override explicite par occurrence : survit à l'édition ──
            deltas30.upsert(occJune15.id, nino.id, false); // exclusion explicite (flip inherited → 0)
            res = await teacher.call("PATCH", `/api/series/${s30.id}`, {
                fromDate: "2026-06-08",
                groupIds: [gA.id, gB.id],
                participants: [
                    { studentId: nino.id, included: true },
                    { studentId: ines.id, included: true },
                ],
            });
            ok(
                "PATCH série avec portée (groupes + participants) → 200, 12 scheduled ≥ ancre réécrites",
                res.status === 200 && (res.body.data.updated as number[]).length === 12,
            );
            ok(
                "avant l'ancre (06-01) : RIEN ne bouge — ni le groupe ajouté, ni le delta ajouté",
                JSON.stringify(grpRows(occJune1.id)) === JSON.stringify([{ group_id: gA.id, inherited: 1 }]) &&
                    JSON.stringify(deltaRows(occJune1.id)) === JSON.stringify([{ student_id: nino.id, included: 1, inherited: 1 }]),
            );
            ok(
                "dès l'ancre (06-08) : gB ajouté en hérité, deltas remplacés en hérité (ines + nino)",
                JSON.stringify(grpRows(occJune8.id)) === JSON.stringify([{ group_id: gA.id, inherited: 1 }, { group_id: gB.id, inherited: 1 }]) &&
                    JSON.stringify(deltaRows(occJune8.id)) === JSON.stringify([
                        { student_id: ines.id, included: 1, inherited: 1 },
                        { student_id: nino.id, included: 1, inherited: 1 },
                    ]),
            );
            ok(
                "dérogation explicite du 06-15 : l'exclusion de nino SURVIT (inherited = 0) malgré le delta hérité contraire",
                JSON.stringify(deltaRows(occJune15.id)) === JSON.stringify([
                    { student_id: ines.id, included: 1, inherited: 1 },
                    { student_id: nino.id, included: 0, inherited: 0 },
                ]),
            );

            // ── doublons soumis : dernier gagne ; liste vide = purge des hérités ──
            res = await teacher.call("PATCH", `/api/series/${s30.id}`, {
                fromDate: "2026-06-08",
                participants: [
                    { studentId: lova.id, included: false },
                    { studentId: lova.id, included: true },
                ],
            });
            ok("participants soumis en doublon : dernier gagne, aucune erreur", res.status === 200);
            res = await teacher.call("GET", `/api/series/${s30.id}`);
            ok(
                "deltas série remplacés : seul lova inclus subsiste (remplacement complet de la liste)",
                (res.body.data.participants as any[]).length === 1 &&
                    res.body.data.participants[0].student_id === lova.id &&
                    res.body.data.participants[0].included === 1,
            );
            ok(
                "propagation : 06-08 porte lova (hérité) ; au 06-15 l'explicite (nino exclu) survit à côté du lova hérité",
                JSON.stringify(deltaRows(occJune8.id)) === JSON.stringify([{ student_id: lova.id, included: 1, inherited: 1 }]) &&
                    JSON.stringify(deltaRows(occJune15.id)) === JSON.stringify([
                        { student_id: nino.id, included: 0, inherited: 0 },
                        { student_id: lova.id, included: 1, inherited: 1 },
                    ]),
            );

            // ── le roster figé suit la portée propagée ──
            res = await teacher.call("POST", `/api/sessions/${occJune8.id}/start`);
            ok("démarrage manuel anticipé de l'occurrence éditée → 200 running", res.status === 200 && res.body.data.status === "running");
            const rosterRows = roster30.listBySession(occJune8.id);
            ok(
                "roster figé à la portée propagée : ines et lova, jamais nino (plus dans le schéma d'inclusion)",
                rosterRows.length === 2 &&
                    rosterRows.every((r) => r.student_id === ines.id || r.student_id === lova.id) &&
                    sessRepo30.findById(occJune8.id)!.roster_frozen_at !== null,
            );
            res = await teacher.call("POST", `/api/sessions/${occJune8.id}/stop`);
            ok("arrêt → completed", res.status === 200 && res.body.data.status === "completed");

            // ── diffusion des changements de statut ──
            res = await teacher.call("POST", `/api/series/${s30.id}/pause`);
            await eventSeen((e) => e.action === "paused" && e.series_id === s30.id);
            ok("POST pause → 200 + WS « paused »", res.status === 200);
            res = await teacher.call("POST", `/api/series/${s30.id}/resume`);
            await eventSeen((e) => e.action === "resumed" && e.series_id === s30.id);
            ok("POST resume → 200 + WS « resumed »", res.status === 200);
            const genIdle = generatedCount(s30.id);
            scheduler.runSchedulerTick();
            ok("tick à horizon déjà plein : AUCUN « generated » superflu (diffusion au réel only)", generatedCount(s30.id) === genIdle);

            // ── horizon roulant : le saut de temps rematérialise avec la portée COURANTE ──
            fake.set("2026-09-07T12:00:00.000Z");
            scheduler.runSchedulerTick();
            const evGen2 = await eventSeen((e) => e.action === "generated" && e.series_id === s30.id && e !== evGen1);
            ok(
                "WS « generated » reçu pour l'extension d'horizon (diffusion au réel only)",
                generatedCount(s30.id) === genIdle + 1 && (evGen2.occurrences as number) > 0,
            );
            const occs30b = series30.listOccurrences(s30.id);
            ok("horizon roulant prolongé par le tick (nouveaux lundis)", occs30b.length > 13);
            const lastOcc = occs30b[occs30b.length - 1];
            ok(
                "nouvelles occurrences = portée courante de la série (gA+gB hérités, écart lova hérité)",
                JSON.stringify(grpRows(lastOcc.id)) === JSON.stringify([{ group_id: gA.id, inherited: 1 }, { group_id: gB.id, inherited: 1 }]) &&
                    JSON.stringify(deltaRows(lastOcc.id)) === JSON.stringify([{ student_id: lova.id, included: 1, inherited: 1 }]),
            );

            // ── annulation depuis l'occurrence cliquée : le passé survit ──
            const expectedFutureP5 = series30
                .listOccurrences(s30.id)
                .filter((r) => r.status === "scheduled" && (r.occurrence_date ?? "") >= "2026-10-05").length;
            res = await teacher.call("POST", `/api/series/${s30.id}/cancel`, { from: "2026-10-05" });
            const rCan = res.body.data;
            const evCancel = await eventSeen((e) => e.action === "cancelled" && e.series_id === s30.id);
            ok(
                "cancel {from} → scheduled ≥ from annulées + WS « cancelled » avec le compte",
                res.status === 200 &&
                    rCan.series.status === "cancelled" &&
                    rCan.cancelled.length === expectedFutureP5 &&
                    evCancel.occurrences === expectedFutureP5,
            );
            ok(
                "occurrence completed (06-08) intacte avec son roster, occurrence avant `from` toujours programmée",
                sessRepo30.findById(occJune8.id)!.status === "completed" &&
                    roster30.countBySession(occJune8.id) === 2 &&
                    sessRepo30.findById(occJune15.id)!.status === "scheduled",
            );

            // Rangement : rien ne pourra s'auto-démarrer ensuite.
            for (const o of series30.listOccurrences(s30.id)) {
                if (o.status === "scheduled") await teacher.call("POST", `/api/sessions/${o.id}/cancel`);
            }
        } finally {
            restoreClock();
            ws30.close();
        }
    }
}
