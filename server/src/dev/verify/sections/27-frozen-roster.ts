// Roster figé au démarrage : reporting, scans, marquage manuel, rollback — api:verify section 27
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { ok } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { attendanceService, base, borne, sessionService, teacher } = ctx;
    let res: ApiResponse;

    console.log("── 27. Roster figé au démarrage : reporting, scans, marquage manuel, rollback ──");
    {
        const dbMod = await import("../../../db");
        const { sessionParticipantRepository: participants27 } = await import("../../../db");
        const { setClock } = await import("../../../core/clock");
        const { FakeClock } = await import("../../../core/fakeClock");

        for (const s of sessionService.list()) {
            if (s.status === "running") await teacher.call("POST", `/api/sessions/${s.id}/stop`);
            if (s.status === "scheduled") await teacher.call("POST", `/api/sessions/${s.id}/cancel`);
        }

        const fake = new FakeClock("2026-06-01T12:00:00.000Z");
        const restoreClock = setClock(fake);
        try {
            res = await teacher.call("POST", "/api/groups", { name: "G-FREEZE" });
            const gF = res.body.data;
            res = await teacher.call("POST", "/api/groups", { name: "G-AUTRE" });
            const gA = res.body.data;
            res = await teacher.call("POST", "/api/students", { firstName: "Rosa", lastName: " exclusion", groupId: gF.id });
            const rosa = res.body.data;
            res = await teacher.call("POST", "/api/students", { firstName: "Marco", groupId: gF.id });
            const marco = res.body.data;
            res = await teacher.call("POST", "/api/students", { firstName: "Iris" });
            const iris = res.body.data;
            res = await teacher.call("POST", "/api/students", { firstName: "Noé", groupId: gA.id });
            const noe = res.body.data;

            res = await teacher.call("POST", "/api/sessions", { label: "Roster figé", groupId: gF.id });
            const sF = res.body.data;
            participants27.upsert(sF.id, iris.id, true); // inclusion hors groupe
            participants27.upsert(sF.id, rosa.id, false); // exclusion malgré le groupe

            res = await teacher.call("POST", `/api/sessions/${sF.id}/start`);
            ok(
                "start : roster_frozen_at posé dans la transaction de transition",
                res.status === 200 && res.body.data.status === "running" && res.body.data.roster_frozen_at !== null,
            );
            const frozen = dbMod.sessionRosterRepository.listBySession(sF.id).map((r) => r.full_name).sort();
            ok(
                "instantané = groupes ∪ inclusions − exclusions, dédupliqué (Marco + Iris ; Rosa exclue, Noé jamais présent)",
                JSON.stringify(frozen) === JSON.stringify(["Iris", "Marco"]),
            );
            ok(
                "noms dénormalisés dans l'instantané (groupe figé, NULL hors groupe)",
                dbMod.sessionRosterRepository.listBySession(sF.id).every((r) =>
                    r.full_name === "Marco" ? r.group_name === "G-FREEZE" : r.group_name === null,
                ),
            );

            res = await teacher.call("GET", `/api/reports/sessions/${sF.id}`);
            ok(
                "reporting sur roster figé : total 2 (inclusion comptée, exclusion retirée), 0 présent",
                res.status === 200 && res.body.data.summary.total === 2 && res.body.data.summary.absent === 2 && res.body.data.summary.present === 0,
            );

            // Scans : la portée attendue suit le roster (inclusion/exclusion).
            await teacher.call("POST", `/api/students/${iris.id}/card`, { uid: "7810001" });
            await teacher.call("POST", `/api/students/${rosa.id}/card`, { uid: "7810002" });
            await teacher.call("POST", `/api/students/${noe.id}/card`, { uid: "7810003" });
            const scanIris = attendanceService.handleScan("7810001");
            ok("scan étudiant INCLUSE hors groupes → accepted (pas out_of_group)", scanIris.result === "accepted" && scanIris.studentId === iris.id);
            const scanRosa = attendanceService.handleScan("7810002");
            ok("scan étudiant EXCLUE malgré son groupe → out_of_group", scanRosa.result === "out_of_group" && scanRosa.studentId === rosa.id);
            const scanNoe = attendanceService.handleScan("7810003");
            ok("scan étudiant étranger (régression Phase 10) → out_of_group", scanNoe.result === "out_of_group");

            // Marquage manuel : correction explicite, hors portée assumée.
            res = await teacher.call("POST", `/api/sessions/${sF.id}/attendance/manual`, { studentId: rosa.id });
            ok("marquage manuel de l'exclue → 200 (override du roster)", res.status === 200 && res.body.data.result === "manual");
            res = await teacher.call("GET", `/api/sessions/${sF.id}/attendance`);
            ok("régression liste de présence (scanneurs seuls) : Iris + Rosa", (res.body.data as any[]).length === 2);
            res = await teacher.call("GET", `/api/reports/sessions/${sF.id}`);
            const frozenReport = res.body.data;
            ok(
                "reporting : présent 2 (Iris scan, Rosa manuelle) / absent 1 / total 3 (présence hors roster ajoutée)",
                frozenReport.summary.present === 2 && frozenReport.summary.absent === 1 && frozenReport.summary.total === 3,
            );

            // Le roster figé survit aux éditions postérieures du groupe.
            await teacher.call("PATCH", `/api/students/${marco.id}`, { groupId: gA.id });
            await teacher.call("PATCH", `/api/students/${iris.id}`, { groupId: gA.id });
            res = await teacher.call("GET", `/api/reports/sessions/${sF.id}`);
            const afterMoves = res.body.data;
            ok(
                "roster figé autoritaire : Marco/Iris restent planifiés (total 3) même après changement de groupe",
                afterMoves.summary.total === 3 &&
                    (afterMoves.rows as any[]).find((r) => r.student_id === marco.id)?.group_name === "G-FREEZE" &&
                    (afterMoves.rows as any[]).find((r) => r.student_id === iris.id)?.group_name === null,
            );

            // Export CSV sur le roster figé.
            {
                const csvRes = await fetch(`${base}/api/reports/sessions/${sF.id}/export`, { headers: { cookie: teacher.cookie! } });
                const csvText = new TextDecoder("utf-8").decode(await csvRes.arrayBuffer());
                ok(
                    "régression export CSV sur roster figé : en-têtes stables + 3 lignes (inclusion et hors-roster incluses)",
                    csvRes.status === 200 &&
                        csvText.startsWith("Nom,Prénom,Numéro étudiant,Groupe,Présence,Heure du premier scan") &&
                        csvText.trim().split("\r\n").length === 4 &&
                        csvText.includes("Iris") &&
                        csvText.includes("Rosa") &&
                        csvText.split("\r\n").some((line) => line.includes("Marco") && line.includes("Absent(e)")),
                );
            }
            res = await borne.call("GET", `/api/reports/sessions/${sF.id}`);
            ok("régression kiosk : lecture du rapport sur session à roster", res.status === 200 && res.body.data.summary.total === 3);

            res = await teacher.call("POST", `/api/sessions/${sF.id}/stop`);
            ok("stop → completed, roster_frozen_at conservé", res.status === 200 && res.body.data.status === "completed" && res.body.data.roster_frozen_at !== null);

            // ── Fallback legacy : session jamais figée (démarrée par la repo) ──
            res = await teacher.call("POST", "/api/groups", { name: "G-LEGACY27" });
            const gLegacy = res.body.data;
            res = await teacher.call("POST", "/api/students", { firstName: "Léa", groupId: gLegacy.id });
            const lea = res.body.data;
            res = await teacher.call("POST", "/api/students", { firstName: "Lou", groupId: gLegacy.id });
            const lou = res.body.data;
            res = await teacher.call("POST", "/api/sessions", { label: "Legacy roster", groupId: gLegacy.id });
            const sLegacy = res.body.data;
            dbMod.sessionRepository.start(sLegacy.id); // chemin brut repository : pas de service
            dbMod.attendanceRepository.recordScan({ sessionId: sLegacy.id, studentId: lea.id, uid: "124" });
            res = await teacher.call("GET", `/api/sessions/${sLegacy.id}`);
            ok("session démarrée par la repository : roster_frozen_at reste NULL", res.status === 200 && res.body.data.roster_frozen_at === null);
            res = await teacher.call("GET", `/api/reports/sessions/${sLegacy.id}`);
            ok(
                "fallback legacy (aucun roster) : report = UNION live des groupes (2, dont 1 présent)",
                res.body.data.summary.total === 2 && res.body.data.summary.present === 1 && res.body.data.summary.absent === 1,
            );
            await teacher.call("POST", `/api/sessions/${sLegacy.id}/stop`);

            // ── Rollback atomique : capture interrompue = rien d'écrit ──
            res = await teacher.call("POST", "/api/sessions", { label: "Rollback roster", groupId: gLegacy.id });
            const sRoll = res.body.data;
            dbMod.db.exec(
                `CREATE TEMP TRIGGER verify_roster_rollback BEFORE INSERT ON session_roster
                 BEGIN SELECT RAISE(ABORT, 'verify_roster_rollback'); END;`,
            );
            try {
                res = await teacher.call("POST", `/api/sessions/${sRoll.id}/start`);
            } finally {
                dbMod.db.exec("DROP TRIGGER verify_roster_rollback");
            }
            ok(
                "start interrompu par une erreur SQLite → erreur propre sans détail interne (400 CONSTRAINT_VIOLATED)",
                (res.status === 400 && res.body.error.code === "CONSTRAINT_VIOLATED") ||
                    (res.status === 500 && res.body.error.code === "INTERNAL"),
            );
            res = await teacher.call("GET", `/api/sessions/${sRoll.id}`);
            ok(
                "rollback complet : session restée scheduled, roster_frozen_at NULL, aucune ligne de roster",
                res.status === 200 &&
                    res.body.data.status === "scheduled" &&
                    res.body.data.roster_frozen_at === null &&
                    dbMod.sessionRosterRepository.countBySession(sRoll.id) === 0,
            );
            ok("aucune boucle de scan lancée pour la transition annulée", (await sessionService.getActive())?.id !== sRoll.id);
            res = await teacher.call("POST", `/api/sessions/${sRoll.id}/start`);
            ok("start rejoué après la panne (sans trigger) → 200", res.status === 200 && res.body.data.status === "running");
            await teacher.call("POST", `/api/sessions/${sRoll.id}/stop`);

            // ── Régression : transitions de session inchangées ──
            res = await teacher.call("POST", "/api/sessions", { label: "Cycle 27", groupId: gLegacy.id });
            const sA = res.body.data;
            res = await teacher.call("POST", "/api/sessions", { label: "Attente 27", groupId: gLegacy.id });
            const sB = res.body.data;
            res = await teacher.call("POST", `/api/sessions/${sA.id}/start`);
            ok("régression start → running", res.status === 200 && res.body.data.status === "running");
            res = await teacher.call("POST", `/api/sessions/${sA.id}/start`);
            ok("régression double start → 409 SESSION_ALREADY_RUNNING", res.status === 409 && res.body.error.code === "SESSION_ALREADY_RUNNING");
            res = await teacher.call("POST", `/api/sessions/${sB.id}/start`);
            ok("régression seconde session → 409 SESSION_ANOTHER_RUNNING (mono-lecteur)", res.status === 409 && res.body.error.code === "SESSION_ANOTHER_RUNNING");
            res = await teacher.call("POST", `/api/sessions/${sA.id}/stop`);
            ok("régression stop → completed", res.status === 200 && res.body.data.status === "completed");
            res = await teacher.call("POST", `/api/sessions/${sA.id}/stop`);
            ok("régression double stop → 409", res.status === 409 && res.body.error.code === "SESSION_NOT_RUNNING");
            res = await teacher.call("POST", `/api/sessions/${sB.id}/cancel`);
            ok("régression cancel scheduled → cancelled", res.status === 200 && res.body.data.status === "cancelled");
        } finally {
            restoreClock();
        }
    }
}
