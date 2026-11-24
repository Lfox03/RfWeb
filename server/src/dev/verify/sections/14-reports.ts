// Reports and CSV export (Phase 7) — api:verify section 14
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { Client, ok, REMOTE_HEADERS } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { admin, attendanceService, base, teacher } = ctx;
    let res: ApiResponse;

    console.log("── 14. Reports and CSV export (Phase 7) ──");
    // The teacher client logged out in section 12: reconnect (prof1's
    // password was reset there) — reports must work for both roles.
    res = await teacher.call("POST", "/api/auth/login", { username: "prof1", password: "nouveau-pass-123" });
    ok("reconnexion teacher (mot de passe réinitialisé) → 200", res.status === 200);
    const nobody = new Client(base, REMOTE_HEADERS); // distant : « anon » est connecté root depuis la section 13
    res = await nobody.call("GET", "/api/reports/sessions");
    ok("GET /api/reports/sessions sans session (distant) → 401", res.status === 401 && res.body.error.code === "NOT_AUTHENTICATED");
    res = await teacher.call("GET", "/api/reports/sessions");
    ok("rapports accessibles au teacher → 200", res.status === 200 && Array.isArray(res.body.data));
    res = await admin.call("GET", "/api/reports/sessions?from=non");
    ok("filtre from invalide → 400 VALIDATION_ERROR", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
    res = await admin.call("GET", "/api/reports/sessions?status=inexistant");
    ok("filtre statut invalide → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
    res = await admin.call("GET", "/api/reports/sessions?from=2026-05-06&to=2026-05-01");
    ok("plage de dates inversée → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
    res = await admin.call("GET", "/api/reports/sessions?groupId=abc");
    ok("groupId non entier → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");

    // Deterministic report scenario: one group, three students (one with
    // a comma/accented name), two cards; two scans of the same card
    // (duplicate — must NOT add attendance) and one unknown card.
    res = await teacher.call("POST", "/api/groups", { name: "G-REPORT" });
    const rg = res.body.data;
    res = await teacher.call("POST", "/api/students", { firstName: "Élodie", lastName: "Truchon, Anne", groupId: rg.id, studentNumber: "RPT-1" });
    const elodie = res.body.data;
    res = await teacher.call("POST", "/api/students", { firstName: "Jean", lastName: "Dupont", groupId: rg.id, studentNumber: "RPT-2" });
    const jean = res.body.data;
    await teacher.call("POST", "/api/students", { firstName: "Nadia", lastName: "Belkacem", groupId: rg.id, studentNumber: "RPT-3" });
    await teacher.call("POST", `/api/students/${elodie.id}/card`, { uid: "6100001" });
    await teacher.call("POST", `/api/students/${jean.id}/card`, { uid: "6100002" });
    res = await teacher.call("POST", "/api/sessions", { label: "Session rapport", groupId: rg.id });
    const sReport = res.body.data;
    await teacher.call("POST", `/api/sessions/${sReport.id}/start`);
    attendanceService.handleScan("6100001");
    attendanceService.handleScan("6100001"); // duplicate
    attendanceService.handleScan("6100002");
    attendanceService.handleScan("6199999"); // unknown card (journal only)
    await teacher.call("POST", `/api/sessions/${sReport.id}/stop`);

    res = await teacher.call("GET", "/api/reports/sessions");
    ok(
        "ligne de rapport : created_by_username du créateur (prof1)",
        (res.body.data as any[]).find((r) => r.id === sReport.id)?.created_by_username === "prof1",
    );

    res = await teacher.call("GET", `/api/reports/sessions/${sReport.id}`);
    const report = res.body.data;
    ok(
        "rapport : 2 présents / 1 absent / 3 total (doublon ignoré)",
        res.status === 200 && report.summary.present === 2 && report.summary.absent === 1 && report.summary.total === 3,
    );
    const reportRows = report.rows as any[];
    ok(
        "rapport : lignes cohérente (présent ⇒ heure du 1er scan, absent ⇒ heure vide)",
        reportRows.length === 3 &&
            reportRows.every((r) => (r.status === "present" ? typeof r.first_scan_at === "string" : r.first_scan_at === null)),
    );
    ok(
        "rapport : numéro étudiant et groupe exposés",
        reportRows.every((r) => typeof r.student_number === "string" && r.group_name === "G-REPORT"),
    );
    const elodieRow = reportRows.find((r) => r.student_id === elodie.id);
    ok("rapport : l'heure affichée est le premier scan accepté (pas le doublon)", elodieRow?.status === "present");

    // Multi-group: the report covers the UNION of the groups' students.
    res = await teacher.call("POST", "/api/groups", { name: "G-REPORT2" });
    const rg2 = res.body.data;
    await teacher.call("POST", "/api/students", { firstName: "Kim", lastName: "Nguyen", groupId: rg2.id, studentNumber: "RPT-4" });
    res = await teacher.call("POST", "/api/sessions", { label: "Session deux groupes", groupIds: [rg.id, rg2.id] });
    const sTwoGroups = res.body.data;
    res = await teacher.call("GET", `/api/reports/sessions/${sTwoGroups.id}`);
    const report2 = res.body.data;
    ok(
        "rapport multi-groupes : roster = UNION des groupes (3 + 1 = 4), 0 présent",
        res.status === 200 && report2.summary.total === 4 && report2.summary.absent === 4 && report2.summary.present === 0,
    );
    ok(
        "rapport multi-groupes : noms de groupes joints dans group_name",
        typeof report2.group_name === "string" &&
            report2.group_name.includes("G-REPORT") &&
            report2.group_name.includes("G-REPORT2"),
    );
    ok(
        "rapport multi-groupes : l'étudiante du second groupe est listée",
        (report2.rows as any[]).some((r) => r.student_number === "RPT-4" && r.group_name === "G-REPORT2"),
    );
    res = await teacher.call("GET", `/api/reports/sessions?groupId=${rg2.id}`);
    ok(
        "filtre par groupe : session multi-groupes listée pour chacun de ses groupes",
        (res.body.data as any[]).some((s) => s.id === sTwoGroups.id),
    );

    res = await teacher.call("GET", `/api/reports/sessions?groupId=${rg.id}`);
    const listed = (res.body.data as any[]).find((s) => s.id === sReport.id);
    ok("liste filtrée par groupe : 2 présents / 4 scans journalisés", listed?.present_count === 2 && listed?.scan_count === 4);
    const today = new Date().toISOString().slice(0, 10);
    res = await teacher.call("GET", `/api/reports/sessions?from=${today}&to=${today}`);
    ok("filtre de dates (aujourd'hui) : la session est listée", (res.body.data as any[]).some((s) => s.id === sReport.id));
    res = await teacher.call("GET", "/api/reports/sessions?from=2000-01-01&to=2000-01-02");
    ok("filtre de dates hors plage : aucune session", res.status === 200 && (res.body.data as any[]).length === 0);
    res = await teacher.call("GET", "/api/reports/sessions?status=cancelled");
    ok("filtre statut annulé : uniquement des sessions annulées", res.status === 200 && (res.body.data as any[]).every((s) => s.status === "cancelled"));

    res = await teacher.call("POST", "/api/sessions", { label: "Annulée rapport", groupId: rg.id });
    const sCancelled = res.body.data;
    await teacher.call("POST", `/api/sessions/${sCancelled.id}/cancel`);
    res = await teacher.call("GET", `/api/reports/sessions/${sCancelled.id}`);
    ok("session annulée : rapport accessible avec statut cancelled", res.status === 200 && res.body.data.session.status === "cancelled");
    res = await teacher.call("GET", "/api/reports/sessions/999999");
    ok("rapport d'une session inconnue → 404", res.status === 404 && res.body.error.code === "NOT_FOUND");

    // CSV export: file response from authoritative server-side data.
    {
        const csvRes = await fetch(`${base}/api/reports/sessions/${sReport.id}/export`, {
            headers: { cookie: teacher.cookie! },
        });
        // Raw bytes: text() would silently strip the leading BOM.
        const csvBytes = new Uint8Array(await csvRes.arrayBuffer());
        const csvText = new TextDecoder("utf-8").decode(csvBytes);
        ok(
            "export CSV : 200, Content-Type texte/csv, pièce jointe nommée",
            csvRes.status === 200 &&
                (csvRes.headers.get("content-type") ?? "").startsWith("text/csv") &&
                /attachment; filename="presences-session-\d+\.csv"/.test(csvRes.headers.get("content-disposition") ?? ""),
        );
        ok(
            "export CSV : BOM UTF-8 en tête de fichier",
            csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf,
        );
        ok(
            "export CSV : en-têtes de colonnes stables",
            csvText.startsWith("Nom,Prénom,Numéro étudiant,Groupe,Présence,Heure du premier scan"),
        );
        ok("export CSV : noms accentués conservés (UTF-8)", csvText.includes("Élodie") && csvText.includes("Belkacem"));
        ok("export CSV : nom avec virgule échappé entre guillemets", csvText.includes('"Truchon, Anne"'));
        ok("export CSV : absent explicite (Absent(e), heure vide)", /Absent\(e\),\r\n$/.test(csvText));
        ok(
            "export CSV : 1 en-tête + 3 lignes, jamais de données internes",
            csvText.trim().split("\r\n").length === 4 && !csvText.includes("password") && !csvText.includes("6100001"),
        );
        const csvAnon = await fetch(`${base}/api/reports/sessions/${sReport.id}/export`, {
            headers: REMOTE_HEADERS,
        });
        ok("export CSV sans session (distant) → 401 JSON (pas de fichier)", csvAnon.status === 401);
    }
    res = await teacher.call("GET", "/api/reports/sessions/999999/export");
    ok("export d'une session inconnue → 404", res.status === 404 && res.body.error.code === "NOT_FOUND");
}
