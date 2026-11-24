// Participants individuels d'une séance ponctuelle : sélection, édition, roster — api:verify section 32
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { ok } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { sessionService, teacher } = ctx;
    let res: ApiResponse;

    console.log("── 32. Participants individuels d'une séance ponctuelle : sélection, édition, roster ──");
    {
        const db32 = await import("../../../db"); // accès « live » (la réouverture des sections antérieures a rebordé les simpletons)
        const { sessionRosterRepository: roster32, sessionParticipantRepository: parts32 } = db32;

        // Silence : aucune autre session ne doit courir (mono-lecteur + scans).
        for (const s of sessionService.list()) {
            if (s.status === "running") await teacher.call("POST", `/api/sessions/${s.id}/stop`);
            if (s.status === "scheduled") await teacher.call("POST", `/api/sessions/${s.id}/cancel`);
        }

        res = await teacher.call("POST", "/api/groups", { name: "G-IND" });
        const g32 = res.body.data;
        res = await teacher.call("POST", "/api/students", { firstName: "Ana", lastName: "In", groupId: g32.id });
        const ana = res.body.data;
        res = await teacher.call("POST", "/api/students", { firstName: "Ben", lastName: "In", groupId: g32.id });
        const ben = res.body.data;
        res = await teacher.call("POST", "/api/students", { firstName: "Cy", lastName: "Out" }); // hors groupe
        const cy = res.body.data;

        // ── CRÉATION avec sélection individuelle (mêmes écarts qu'une série) ──
        res = await teacher.call("POST", "/api/sessions", {
            label: "Ponctuelle écarts",
            groupIds: [g32.id],
            participants: [
                { studentId: ben.id, included: false }, // exclu malgré son groupe
                { studentId: cy.id, included: true }, // inclus hors des groupes
            ],
        });
        const sA = res.body.data;
        ok(
            "POST /api/sessions avec « participants » → 201, group_ids portés",
            res.status === 201 && Array.isArray(sA.group_ids) && sA.group_ids.length === 1,
        );
        res = await teacher.call("GET", `/api/sessions/${sA.id}`);
        const detA = res.body.data.participants as any[];
        ok(
            "GET /api/sessions/:id → écarts relus, explicites (inherited = 0), les deux présents",
            res.status === 200 &&
                detA.length === 2 &&
                detA.every((p) => p.inherited === 0) &&
                detA.some((p) => p.student_id === ben.id && p.included === 0) &&
                detA.some((p) => p.student_id === cy.id && p.included === 1),
        );

        // ── ÉDITION après création : REMPLACEMENT intégral de la liste ──
        res = await teacher.call("PATCH", `/api/sessions/${sA.id}`, {
            participants: [{ studentId: cy.id, included: false }],
        });
        ok("PATCH /api/sessions/:id { participants } seul → 200", res.status === 200);
        res = await teacher.call("GET", `/api/sessions/${sA.id}`);
        const detA2 = res.body.data.participants as any[];
        ok(
            "édition : les deux écarts précédents sont REMPLACÉS (une ligne, Cy exclue, explicite)",
            detA2.length === 1 &&
                detA2[0].student_id === cy.id &&
                detA2[0].included === 0 &&
                detA2[0].inherited === 0,
        );

        res = await teacher.call("PATCH", `/api/sessions/${sA.id}`, { participants: [] });
        res = await teacher.call("GET", `/api/sessions/${sA.id}`);
        ok("PATCH participants : [] → sélection individuelle vidée", (res.body.data.participants as any[]).length === 0);

        // Étudiant inconnu → 400 SANS rien appliquer (ni le label ni les écarts).
        await teacher.call("PATCH", `/api/sessions/${sA.id}`, { participants: [{ studentId: cy.id, included: true }] });
        res = await teacher.call("PATCH", `/api/sessions/${sA.id}`, {
            label: "Renommée",
            participants: [{ studentId: 987654, included: true }],
        });
        ok("PATCH avec étudiant inconnu → 400 (VALIDATION_ERROR)", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
        res = await teacher.call("GET", `/api/sessions/${sA.id}`);
        const detA3 = res.body.data;
        ok(
            "édition refusée = sans effet : label et écarts restent ceux d'avant",
            detA3.label === "Ponctuelle écarts" &&
                (detA3.participants as any[]).length === 1 &&
                (detA3.participants as any[])[0].student_id === cy.id &&
                (detA3.participants as any[])[0].included === 1,
        );

        // Forme et garde-fous : included non booléen / champ inconnu → 400 ; les
        // participants ne remplacent JAMAIS le groupe obligatoire.
        res = await teacher.call("POST", "/api/sessions", { label: "X", groupIds: [g32.id], participants: [{ studentId: ana.id, included: "oui" }] });
        ok("participant « included » non booléen → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
        res = await teacher.call("POST", "/api/sessions", { label: "X", groupIds: [g32.id], participants: [{ studentId: ana.id, included: true, why: "?" }] });
        ok("participant à champ inconnu → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
        res = await teacher.call("POST", "/api/sessions", { label: "X", participants: [{ studentId: ana.id, included: true }] });
        ok("participants sans groupe → 400 (le groupe reste obligatoire)", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");

        // ── Les écarts de CRÉATION gouvernent bien la liste d'appel figée ──
        res = await teacher.call("POST", "/api/sessions", {
            label: "Roster création",
            groupIds: [g32.id],
            participants: [
                { studentId: ben.id, included: false },
                { studentId: cy.id, included: true },
            ],
        });
        const sR = res.body.data;
        await teacher.call("POST", `/api/sessions/${sR.id}/start`);
        const frozenR = roster32.listBySession(sR.id).map((r) => r.full_name).sort();
        await teacher.call("POST", `/api/sessions/${sR.id}/stop`);
        ok(
            "roster figé à la création = groupes ∪ inclusions − exclusions (Ana + Cy ; Ben exclu)",
            JSON.stringify(frozenR) === JSON.stringify(["Ana In", "Cy Out"]),
        );

        // ── L'ÉDITION avant démarrage gouverne aussi la liste figée ──
        res = await teacher.call("POST", "/api/sessions", { label: "Roster édition", groupIds: [g32.id] });
        const sE = res.body.data;
        res = await teacher.call("PATCH", `/api/sessions/${sE.id}`, {
            participants: [
                { studentId: ben.id, included: false },
                { studentId: cy.id, included: true },
            ],
        });
        ok("PATCH des écarts avant démarrage (autonome scheduled) → 200", res.status === 200);
        await teacher.call("POST", `/api/sessions/${sE.id}/start`);
        const frozenE = roster32.listBySession(sE.id).map((r) => r.full_name).sort();
        await teacher.call("POST", `/api/sessions/${sE.id}/stop`);
        ok(
            "roster figé après édition = sélection modifiée (Ana + Cy), pas la liste de base",
            JSON.stringify(frozenE) === JSON.stringify(["Ana In", "Cy Out"]),
        );

        // Contrôle : sans aucun écart, le roster reste le groupe pur.
        res = await teacher.call("POST", "/api/sessions", { label: "Roster groupe pur", groupIds: [g32.id] });
        const sG = res.body.data;
        await teacher.call("POST", `/api/sessions/${sG.id}/start`);
        const frozenG = roster32.listBySession(sG.id).map((r) => r.full_name).sort();
        await teacher.call("POST", `/api/sessions/${sG.id}/stop`);
        ok(
            "contrôle sans écart : roster = groupe (Ana + Ben)",
            JSON.stringify(frozenG) === JSON.stringify(["Ana In", "Ben In"]),
        );

        // Écarts d'une séance autonome = toujours explicites en base (inherited = 0).
        ok(
            "écarts d'une séance autonome écrits explicites (inherited = 0)",
            parts32.listBySession(sR.id).every((p) => p.inherited === 0),
        );

        // Nettoyage : ne laisser aucune session programmée derrière nous.
        for (const s of sessionService.list()) {
            if (s.status === "running") await teacher.call("POST", `/api/sessions/${s.id}/stop`);
            if (s.status === "scheduled") await teacher.call("POST", `/api/sessions/${s.id}/cancel`);
        }
    }
}
