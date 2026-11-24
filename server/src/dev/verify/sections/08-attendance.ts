// Attendance and scans — api:verify section 8
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { ok } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { ada, alan, attendanceService, g1, teacher } = ctx;
    let res: ApiResponse;

    console.log("── 8. Attendance and scans ──");
    res = await teacher.call("POST", "/api/sessions", { label: "Appel RFID", groupId: g1.id });
    const sr = res.body.data;
    await teacher.call("POST", `/api/sessions/${sr.id}/start`);

    // Scans via the service (the reader is simulated; the RFID loop calls
    // exactly this same function).
    const unknown = attendanceService.handleScan("7777777");
    ok("scan carte inconnue → result unknown", unknown.result === "unknown");
    const first = attendanceService.handleScan("5000002");
    ok("scan valide → accepted", first.result === "accepted" && first.studentId === ada.id);
    const second = attendanceService.handleScan("5000002");
    ok("second scan → duplicate", second.result === "duplicate");
    res = await teacher.call("GET", `/api/sessions/${sr.id}/attendance`);
    ok("état de présence : 1 seule ligne (pas de doublon d'état)", res.status === 200 && res.body.data.length === 1);
    res = await teacher.call("GET", `/api/sessions/${sr.id}/scans`);
    const scanRows = res.body.data as any[];
    ok(
        "historique scan : 3 événements (unknown, accepted, duplicate) conservés",
        scanRows.length === 3 && scanRows.map((r) => r.result).join(",") === "unknown,accepted,duplicate",
    );
    // revoked card → expired
    await teacher.call("POST", "/api/cards/5000002/revoke");
    const expired = attendanceService.handleScan("5000002");
    ok("scan carte retirée → expired", expired.result === "expired");
    res = await teacher.call("GET", `/api/sessions/${sr.id}/attendance`);
    ok("scan expired n'a pas créé d'état de présence", (res.body.data as any[]).length === 1);

    // Student outside the session's group scope (Phase 10):
    // scan journaled as "out_of_group", presence NOT counted.
    res = await teacher.call("POST", "/api/groups", { name: "G-hors-session" });
    const gHors = res.body.data;
    res = await teacher.call("POST", "/api/students", { firstName: "Hors", lastName: "Groupe", groupId: gHors.id });
    const bob = res.body.data;
    await teacher.call("POST", `/api/students/${bob.id}/card`, { uid: "5000003" });
    const outOfGroup = attendanceService.handleScan("5000003");
    ok(
        "scan étudiant hors des groupes de la session → out_of_group",
        outOfGroup.result === "out_of_group" && outOfGroup.studentId === bob.id,
    );
    res = await teacher.call("GET", `/api/sessions/${sr.id}/attendance`);
    ok("scan out_of_group n'a pas créé d'état de présence", (res.body.data as any[]).length === 1);
    res = await teacher.call("GET", `/api/sessions/${sr.id}/scans`);
    const scansWithOut = res.body.data as any[];
    ok(
        "scan out_of_group journalisé dans l'historique",
        scansWithOut.length === 5 && scansWithOut[scansWithOut.length - 1].result === "out_of_group",
    );

    // Manual marking of a presence (teacher correction, running session):
    // state set, "manual" event journaled without a card.
    res = await teacher.call("POST", `/api/sessions/${sr.id}/attendance/manual`, { studentId: alan.id });
    ok(
        "marquage manuel → 200 (résultat manual, sans carte)",
        res.status === 200 && res.body.data.result === "manual" && res.body.data.studentId === alan.id,
    );
    res = await teacher.call("GET", `/api/sessions/${sr.id}/attendance`);
    ok(
        "marquage manuel : état de présence posé",
        (res.body.data as any[]).length === 2 && (res.body.data as any[]).some((r) => r.student_id === alan.id),
    );
    res = await teacher.call("POST", `/api/sessions/${sr.id}/attendance/manual`, { studentId: alan.id });
    ok("marquage manuel d'un déjà-présent → 409 ALREADY_PRESENT", res.status === 409 && res.body.error.code === "ALREADY_PRESENT");
    res = await teacher.call("POST", `/api/sessions/${sr.id}/attendance/manual`, { studentId: 999999 });
    ok("marquage manuel étudiant inconnu → 404", res.status === 404 && res.body.error.code === "NOT_FOUND");
    res = await teacher.call("POST", `/api/sessions/${sr.id}/attendance/manual`, {});
    ok("marquage manuel sans studentId → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
    res = await teacher.call("POST", `/api/sessions/${sr.id}/attendance/manual`, { studentId: alan.id, extra: 1 });
    ok("marquage manuel champ inconnu → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
    res = await teacher.call("GET", `/api/sessions/${sr.id}/scans`);
    const scansWithManual = res.body.data as any[];
    ok(
        "marquage manuel journalisé (résultat manual, uid NULL)",
        scansWithManual.length === 6 &&
            scansWithManual[scansWithManual.length - 1].result === "manual" &&
            scansWithManual[scansWithManual.length - 1].uid === null,
    );

    res = await teacher.call("POST", `/api/sessions/${sr.id}/attendance/reset`);
    ok("reset présence → 204", res.status === 204);
    res = await teacher.call("GET", `/api/sessions/${sr.id}/attendance`);
    const afterReset = res.body.data as any[];
    res = await teacher.call("GET", `/api/sessions/${sr.id}/scans`);
    const scansAfterReset = res.body.data as any[];
    ok("reset : état vidé, historique de scan intact", afterReset.length === 0 && scansAfterReset.length === 6);

    res = await teacher.call("POST", `/api/sessions/${sr.id}/stop`);
    ok("stop running → completed", res.status === 200 && res.body.data.status === "completed" && res.body.data.ended_at !== null);
    res = await teacher.call("POST", `/api/sessions/${sr.id}/stop`);
    ok("stop d'une completed → 409", res.status === 409 && res.body.error.code === "SESSION_NOT_RUNNING");
    res = await teacher.call("POST", `/api/sessions/${sr.id}/attendance/manual`, { studentId: bob.id });
    ok(
        "marquage manuel sur session arrêtée → 409 SESSION_NOT_RUNNING",
        res.status === 409 && res.body.error.code === "SESSION_NOT_RUNNING",
    );
    res = await teacher.call("POST", `/api/sessions/${sr.id}/start`);
    ok("re-démarrage completed → 409 SESSION_INVALID_TRANSITION", res.status === 409);
    res = await teacher.call("POST", "/api/sessions", { label: "Mauvais champ", extra: 1 });
    ok("champ inconnu → 400", res.status === 400);
    res = await teacher.call("POST", "/api/sessions", { label: "Date", scheduledAt: "pas-une-date" });
    ok("scheduledAt invalide → 400", res.status === 400);
}
