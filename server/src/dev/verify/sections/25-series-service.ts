// Séries récurrentes : génération et éditions sous FakeClock — api:verify section 25
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { ok } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { ada, alan, g1, sessionService } = ctx;

    console.log("── 25. Séries récurrentes : génération et éditions sous FakeClock ──");
    {
        const { AppError } = await import("../../../core/errors");
        const { setClock } = await import("../../../core/clock");
        const { FakeClock } = await import("../../../core/fakeClock");
        const {
            db,
            groupRepository,
            sessionParticipantRepository,
            sessionRepository,
            sessionSeriesRepository,
            userRepository,
        } = await import("../../../db");
        const seriesService = await import("../../../services/seriesService");
        const { localDateTimeInZone, zonedTimeToUtc } = await import("../../../services/localTime");

        const rejects = (fn: () => unknown, status = 400, code = "VALIDATION_ERROR"): boolean => {
            try {
                fn();
                return false;
            } catch (err) {
                return err instanceof AppError && err.status === status && err.code === code;
            }
        };

        const fake = new FakeClock("2026-06-01T12:00:00.000Z"); // lundi 1er juin 2026
        const restoreClock = setClock(fake);
        try {
            const root = userRepository.findByUsername("root")!;
            const gRec = groupRepository.create("G-REC");
            const makeSeries = (
                input: Omit<Parameters<typeof seriesService.createSeries>[0], "createdBy">,
            ) => seriesService.createSeries({ timezone: "UTC", durationMinutes: 60, createdBy: root.id, ...input });

            // 1) Validation stricte — SQLite NORMALIZE les dates impossibles
            //    (date('2026-02-30') → '2026-03-02') : le service doit refuser.
            ok(
                "validation : 2026-02-30 et 2026-02-29 refusés (2026 non bissexile, SQLite normaliserait)",
                rejects(() => makeSeries({ label: "x", recurrence: "daily", localTime: "08:00", startsOn: "2026-02-30", groupIds: [g1.id] })) &&
                    rejects(() => makeSeries({ label: "x", recurrence: "daily", localTime: "08:00", startsOn: "2026-02-29", groupIds: [g1.id] })) &&
                    !rejects(() => makeSeries({ label: "OK bissexile", recurrence: "daily", localTime: "08:00", startsOn: "2028-02-29", endsOn: "2028-02-29", groupIds: [g1.id] })),
            );
            ok(
                "validation : formats date/heure/fuseau refusés (2026-6-1, 24:00, 8:30, Not/AZone)",
                rejects(() => makeSeries({ label: "x", recurrence: "daily", localTime: "08:00", startsOn: "2026-6-01", groupIds: [g1.id] })) &&
                    rejects(() => makeSeries({ label: "x", recurrence: "daily", localTime: "24:00", startsOn: "2026-06-01", groupIds: [g1.id] })) &&
                    rejects(() => makeSeries({ label: "x", recurrence: "daily", localTime: "8:30", startsOn: "2026-06-01", groupIds: [g1.id] })) &&
                    rejects(() => makeSeries({ label: "x", recurrence: "daily", localTime: "08:00", timezone: "Not/AZone", startsOn: "2026-06-01", groupIds: [g1.id] })),
            );
            ok(
                "validation : weekday exigé si weekly, interdit si daily ; ends_on ≥ starts_on ; groupe obligatoire",
                rejects(() => makeSeries({ label: "x", recurrence: "weekly", localTime: "08:00", startsOn: "2026-06-01", groupIds: [g1.id] })) &&
                    rejects(() => makeSeries({ label: "x", recurrence: "daily", weekday: 3, localTime: "08:00", startsOn: "2026-06-01", groupIds: [g1.id] })) &&
                    rejects(() => makeSeries({ label: "x", recurrence: "daily", localTime: "08:00", startsOn: "2026-06-08", endsOn: "2026-06-01", groupIds: [g1.id] })) &&
                    rejects(() => makeSeries({ label: "x", recurrence: "daily", localTime: "08:00", startsOn: "2026-06-01", groupIds: [] })) &&
                    rejects(() => makeSeries({ label: "x", recurrence: "daily", localTime: "08:00", startsOn: "2026-06-01", groupIds: [987654] })),
            );

            // 2) Quotidien UTC : bornes inclusives, instants, miroirs locaux.
            const daily = makeSeries({
                label: "REC quotidienne",
                recurrence: "daily",
                localTime: "08:30",
                startsOn: "2026-06-01",
                endsOn: "2026-06-07",
                groupIds: [g1.id],
            });
            const genDaily = seriesService.generateOccurrences(daily.id);
            const dailyRows = seriesService.listOccurrences(daily.id);
            ok(
                "daily : 7 occurrences aux bornes inclusives, UTC + local_time + timezone + created_by portés",
                genDaily.created.length === 7 &&
                    genDaily.skipped.length === 0 &&
                    dailyRows.length === 7 &&
                    dailyRows.every(
                        (r, i) =>
                            r.scheduled_at === `2026-06-0${i + 1}T08:30:00.000Z` &&
                            r.occurrence_date === `2026-06-0${i + 1}` &&
                            r.local_time === "08:30" &&
                            r.timezone === "UTC" &&
                            r.status === "scheduled" &&
                            r.series_id === daily.id,
                    ) &&
                    dailyRows[0].created_by === root.id &&
                    sessionRepository.getGroupIds(dailyRows[0].id).includes(g1.id),
            );

            // 3) Idempotence + préservation des lignes existantes.
            const genAgain = seriesService.generateOccurrences(daily.id);
            sessionService.cancel(dailyRows[1].id); // annulée à la main
            sessionRepository.updateSchedule(dailyRows[3].id, { label: "MANUEL" }); // retouchée à la main
            const genThird = seriesService.generateOccurrences(daily.id);
            const rowCancelled = sessionRepository.findById(dailyRows[1].id)!;
            const rowEdited = sessionRepository.findById(dailyRows[3].id)!;
            ok(
                "génération idempotente : seconde passe 0 créée ; annulation et retouche manuelles jamais réécrites",
                genAgain.created.length === 0 &&
                    genAgain.existing === 7 &&
                    genThird.created.length === 0 &&
                    rowCancelled.status === "cancelled" &&
                    rowEdited.label === "MANUEL" &&
                    rowEdited.scheduled_at === "2026-06-04T08:30:00.000Z",
            );

            // 4) Hebdomadaire : sélecteur de jour, starts_on borné, horizon roulant.
            const weekly = makeSeries({
                label: "REC lundi",
                recurrence: "weekly",
                weekday: 1,
                localTime: "09:00",
                startsOn: "2026-06-03", // mercredi → première occurrence lundi 06-08
                groupIds: [g1.id],
            });
            seriesService.generateOccurrences(weekly.id);
            const wRows = seriesService.listOccurrences(weekly.id);
            ok(
                "weekly lundi : rien avant starts_on (06-01 sauté), puis les lundis seuls jusqu'à today+12 semaines inclus",
                wRows.length === 12 &&
                    wRows[0].occurrence_date === "2026-06-08" &&
                    wRows.at(-1)!.occurrence_date === "2026-08-24" &&
                    wRows.every((r) => new Date(r.scheduled_at).getUTCDay() === 1),
            );
            const shortSeries = makeSeries({
                label: "REC horizon court",
                recurrence: "daily",
                localTime: "10:00",
                startsOn: "2026-06-01",
                groupIds: [g1.id],
            });
            ok(
                "horizon paramétrable : 1 semaine = today…today+7 inclus (8 jours) ; horizon invalide → 400",
                seriesService.generateOccurrences(shortSeries.id, { horizonWeeks: 1 }).created.length === 8 &&
                    rejects(() => seriesService.generateOccurrences(shortSeries.id, { horizonWeeks: 0 })),
            );

            // 5) ends_on borne inclusive sans coller au patron.
            const wEnd = makeSeries({
                label: "REC fin dimanche",
                recurrence: "weekly",
                weekday: 1,
                localTime: "08:00",
                startsOn: "2026-06-01",
                endsOn: "2026-07-05", // dimanche → dernier lundi 06-29
                groupIds: [g1.id],
            });
            seriesService.generateOccurrences(wEnd.id);
            const eRows = seriesService.listOccurrences(wEnd.id);
            ok(
                "ends_on inclusif un dimanche : dernier lundi 2026-06-29 (aucun arrondi de borne)",
                eRows.length === 5 && eRows.at(-1)!.occurrence_date === "2026-06-29",
            );

            // 6) Copie des groupes et des deltas individuels.
            const withP = makeSeries({
                label: "REC participants",
                recurrence: "weekly",
                weekday: 3,
                localTime: "13:00",
                startsOn: "2026-06-01",
                endsOn: "2026-06-10",
                groupIds: [g1.id, gRec.id],
                participants: [
                    { studentId: ada.id, included: true },
                    { studentId: alan.id, included: false },
                ],
            });
            const genP = seriesService.generateOccurrences(withP.id);
            const pRow = sessionRepository.findById(genP.created[0])!;
            const pGroups = sessionRepository.getGroupIds(pRow.id).slice().sort((a, b) => a - b);
            const pDeltas = sessionParticipantRepository.listBySession(pRow.id);
            ok(
                "chaque occurrence copie les groupes par défaut et les deltas (inclusion/exclusion) de la série",
                JSON.stringify(pGroups) === JSON.stringify([g1.id, gRec.id].sort((a, b) => a - b)) &&
                    pDeltas.length === 2 &&
                    pDeltas.find((d) => d.student_id === ada.id)?.included === 1 &&
                    pDeltas.find((d) => d.student_id === alan.id)?.included === 0,
            );

            // 7) Statuts : paused/cancelled ne génèrent jamais ; cancelled terminal.
            const paused = makeSeries({
                label: "REC pause",
                recurrence: "daily",
                localTime: "07:00",
                startsOn: "2026-06-01",
                groupIds: [g1.id],
            });
            seriesService.setSeriesStatus(paused.id, "paused");
            const genPaused = seriesService.generateOccurrences(paused.id);
            seriesService.setSeriesStatus(paused.id, "cancelled");
            const genCancelled = seriesService.generateOccurrences(paused.id);
            ok(
                "paused puis cancelled : aucune génération ; statut refusé sur une série annulée (409 SERIES_CANCELLED)",
                genPaused.created.length === 0 &&
                    genCancelled.created.length === 0 &&
                    sessionSeriesRepository.findById(paused.id)!.status === "cancelled" &&
                    rejects(() => seriesService.setSeriesStatus(paused.id, "active"), 409, "SERIES_CANCELLED") &&
                    rejects(() => seriesService.editSeriesFrom(paused.id, "2026-06-01", { localTime: "10:00" }), 409, "SERIES_CANCELLED"),
            );

            // 8) DST — avant : l'heure locale inexistante n'est JAMAIS décalée.
            fake.set("2026-03-05T12:00:00.000Z");
            const dst = makeSeries({
                label: "REC DST",
                recurrence: "daily",
                localTime: "02:30",
                timezone: "America/New_York",
                durationMinutes: 45,
                startsOn: "2026-03-05",
                endsOn: "2026-03-10",
                groupIds: [g1.id],
            });
            const genDst = seriesService.generateOccurrences(dst.id);
            const dstRows = seriesService.listOccurrences(dst.id);
            ok(
                "spring forward 2026-03-08 02:30 NY : date sautée et reportée (raison nonexistent_local_time), jamais décalée",
                genDst.skipped.length === 1 &&
                    genDst.skipped[0].occurrence_date === "2026-03-08" &&
                    genDst.skipped[0].reason === "nonexistent_local_time" &&
                    dstRows.every((r) => r.occurrence_date !== "2026-03-08"),
            );
            ok(
                "heure locale voulue conservée de part et d'autre de la transition (EST 07:30Z → EDT 06:30Z)",
                dstRows.every((r) => localDateTimeInZone(Date.parse(r.scheduled_at), "America/New_York").time === "02:30") &&
                    dstRows.find((r) => r.occurrence_date === "2026-03-07")!.scheduled_at === "2026-03-07T07:30:00.000Z" &&
                    dstRows.find((r) => r.occurrence_date === "2026-03-09")!.scheduled_at === "2026-03-09T06:30:00.000Z",
            );

            // 8 bis) DST — arrière : heure ambiguë = première occurrence (EDT).
            fake.set("2026-10-30T12:00:00.000Z");
            const amb = makeSeries({
                label: "REC arrière",
                recurrence: "daily",
                localTime: "01:30",
                timezone: "America/New_York",
                durationMinutes: 30,
                startsOn: "2026-10-30",
                endsOn: "2026-11-02",
                groupIds: [g1.id],
            });
            seriesService.generateOccurrences(amb.id);
            const ambHelper = zonedTimeToUtc("2026-11-01", "01:30", "America/New_York");
            ok(
                "fall back 2026-11-01 01:30 NY : heure reconnue ambiguë, instants déterministe = 1re occurrence (05:30Z EDT)",
                ambHelper.kind === "ambiguous" &&
                    seriesService.listOccurrences(amb.id).find((r) => r.occurrence_date === "2026-11-01")?.scheduled_at ===
                        "2026-11-01T05:30:00.000Z",
            );

            // 9) Édition depuis une occurrence choisie (changement d'heure).
            fake.set("2026-06-01T12:00:00.000Z");
            const edit = makeSeries({
                label: "REC édition",
                recurrence: "weekly",
                weekday: 1,
                localTime: "09:00",
                startsOn: "2026-06-01",
                groupIds: [g1.id],
                participants: [{ studentId: ada.id, included: true }],
            });
            seriesService.generateOccurrences(edit.id); // 13 lundis (06-01 → 08-24)
            const rowsOf = () => seriesService.listOccurrences(edit.id);
            const at = (date: string) => rowsOf().find((r) => r.occurrence_date === date)!;
            sessionParticipantRepository.upsert(at("2026-07-13").id, alan.id, false); // override par occurrence
            sessionService.cancel(at("2026-07-20").id); // annulée → préservée
            sessionRepository.start(at("2026-07-27").id); // running (écriture physique, pas de lecteur/WS) → préservée
            const idsBefore = new Map(rowsOf().map((r) => [r.occurrence_date, r.id]));
            const rTime = seriesService.editSeriesFrom(edit.id, "2026-07-06", { localTime: "10:00" });
            const july13 = at("2026-07-13");
            ok(
                "édition heure 09:00→10:00 dès 07-06 : 6 futures scheduled réécrites à la MÊME identité, IDs conservés",
                rTime.updated.length === 6 &&
                    rTime.created.length === 0 &&
                    rTime.cancelled.length === 0 &&
                    rTime.updated.every((id) => [...idsBefore.values()].includes(id)) &&
                    idsBefore.get("2026-07-13") === july13.id &&
                    july13.scheduled_at === "2026-07-13T10:00:00.000Z" &&
                    at("2026-08-24").scheduled_at === "2026-08-24T10:00:00.000Z",
            );
            ok(
                "passé < date choisie intact, running/completed/cancelled préservés intacts (statut ET instant)",
                at("2026-06-01").scheduled_at === "2026-06-01T09:00:00.000Z" &&
                    at("2026-06-29").scheduled_at === "2026-06-29T09:00:00.000Z" &&
                    at("2026-07-20").status === "cancelled" &&
                    at("2026-07-20").scheduled_at === "2026-07-20T09:00:00.000Z" &&
                    at("2026-07-27").status === "running" &&
                    rTime.preserved.length === 2,
            );
            ok(
                "override par occurrence conservé (alan exclu sur 07-13) et modèle de série mis à jour",
                sessionParticipantRepository.listBySession(july13.id).some((d) => d.student_id === alan.id && d.included === 0) &&
                    sessionSeriesRepository.findById(edit.id)!.local_time === "10:00",
            );

            // 10) Lundi → mardi dès 07-13 : annulation du désuet, création du neuf.
            const rDay = seriesService.editSeriesFrom(edit.id, "2026-07-13", { weekday: 2 });
            ok(
                "lundi→mardi dès 07-13 : 5 lundis scheduled annulés (lignes conservées, historique intact), 6 mardis créés",
                rDay.cancelled.length === 5 &&
                    rDay.created.length === 6 &&
                    rDay.updated.length === 0 &&
                    at("2026-07-13").status === "cancelled" &&
                    sessionRepository.findById(at("2026-07-13").id) !== undefined &&
                    at("2026-06-29").status === "scheduled" &&
                    rDay.preserved.length === 2,
            );
            const tuesday = at("2026-07-14");
            ok(
                "mardis créés avec groupes + deltas courants de la série, heure locale éditable conservée",
                tuesday.scheduled_at === "2026-07-14T10:00:00.000Z" &&
                    sessionRepository.getGroupIds(tuesday.id).includes(g1.id) &&
                    sessionParticipantRepository.listBySession(tuesday.id).some((d) => d.student_id === ada.id && d.included === 1) &&
                    at("2026-08-18").occurrence_date === "2026-08-18" &&
                    rowsOf().every((r) => r.occurrence_date !== "2026-08-25"),
            );

            // 11) Raccourcissement ends_on : le plan futur désuet est annulé.
            const rEnd = seriesService.editSeriesFrom(edit.id, "2026-07-14", { endsOn: "2026-07-31" });
            ok(
                "ends_on raccourci à 07-31 : mardis 08-04/11/18 annulés, 07-14/21/28 conservés, série mise à jour",
                rEnd.cancelled.length === 3 &&
                    rEnd.updated.length === 3 &&
                    at("2026-08-04").status === "cancelled" &&
                    at("2026-07-28").status === "scheduled" &&
                    sessionSeriesRepository.findById(edit.id)!.ends_on === "2026-07-31",
            );
            ok(
                "éditions refusées : série inconnue 404, ancre non-occurrence 404, date invalide 400",
                rejects(() => seriesService.editSeriesFrom(987654, "2026-06-01", { localTime: "10:00" }), 404, "NOT_FOUND") &&
                    rejects(() => seriesService.editSeriesFrom(edit.id, "2026-06-02", { localTime: "10:00" }), 404, "NOT_FOUND") &&
                    rejects(() => seriesService.editSeriesFrom(edit.id, "2026-02-30", { localTime: "10:00" }), 400, "VALIDATION_ERROR"),
            );

            // 12) Sérialité transactionnelle : échec en plein milieu → tout est annulé.
            db.exec(
                `CREATE TEMP TRIGGER verify_series_rollback BEFORE INSERT ON app_sessions
                 BEGIN SELECT RAISE(ABORT, 'verify_series_rollback'); END;`,
            );
            let rolledBack = false;
            try {
                seriesService.editSeriesFrom(edit.id, "2026-07-21", { recurrence: "daily", weekday: null });
            } catch {
                rolledBack = true;
            } finally {
                db.exec("DROP TRIGGER verify_series_rollback");
            }
            const seriesAfterRollback = sessionSeriesRepository.findById(edit.id)!;
            ok(
                "édition interrompue par une erreur SQLite : rien d'écrit (modèle, annulations et créations rollbackés)",
                rolledBack &&
                    seriesAfterRollback.recurrence === "weekly" &&
                    seriesAfterRollback.weekday === 2 &&
                    seriesAfterRollback.ends_on === "2026-07-31" &&
                    at("2026-07-28").status === "scheduled" &&
                    rowsOf().every((r) => r.occurrence_date !== "2026-07-22"),
            );

            // 13) Série paused : l'édition reprogramme le futur scheduled sans rien créer.
            const pausedEdit = makeSeries({
                label: "REC pause-édition",
                recurrence: "weekly",
                weekday: 1,
                localTime: "09:00",
                startsOn: "2026-06-01",
                groupIds: [g1.id],
            });
            seriesService.generateOccurrences(pausedEdit.id);
            seriesService.setSeriesStatus(pausedEdit.id, "paused");
            const rPaused = seriesService.editSeriesFrom(pausedEdit.id, "2026-07-06", { localTime: "11:00" });
            const rPaused2 = seriesService.editSeriesFrom(pausedEdit.id, "2026-07-13", { weekday: 2 });
            ok(
                "série paused : futures scheduled mises à jour mais AUCUNE nouvelle occurrence matérialisée",
                rPaused.updated.length === 8 &&
                    rPaused.created.length === 0 &&
                    rPaused2.created.length === 0 &&
                    rPaused2.cancelled.length === 7,
            );

            // Remise en état physique de la running simulée (plus de tick après cette
            // section : aucun risque d'auto-démarrage, mais on laisse la base cohérente).
            db.prepare("UPDATE app_sessions SET status = 'scheduled', started_at = NULL WHERE id = ?").run(
                at("2026-07-27").id,
            );
        } finally {
            restoreClock();
        }
    }
}
