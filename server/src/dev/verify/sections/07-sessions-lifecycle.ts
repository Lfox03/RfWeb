// Sessions: lifecycle — api:verify section 7
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { ok } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { g1, teacher, userRepository } = ctx;
    let res: ApiResponse;

    console.log("── 7. Sessions: lifecycle ──");
    res = await teacher.call("POST", "/api/sessions", { label: "Cours 1", groupId: g1.id });
    ok("POST /api/sessions → 201 scheduled", res.status === 201 && res.body.data.status === "scheduled");
    ok(
        "session créée avec groupId (compat) expose group_ids = [groupId]",
        Array.isArray(res.body.data.group_ids) &&
            res.body.data.group_ids.length === 1 &&
            res.body.data.group_ids[0] === g1.id,
    );
    const s1 = res.body.data;
    ok(
        "session HTTP porte son créateur (created_by + created_by_username)",
        s1.created_by === userRepository.findByUsername("prof1")!.id &&
            s1.created_by_username === "prof1",
    );
    res = await teacher.call("POST", `/api/sessions/${s1.id}/stop`);
    ok("stop d'une session scheduled → 409 SESSION_NOT_RUNNING", res.status === 409 && res.body.error.code === "SESSION_NOT_RUNNING");
    res = await teacher.call("POST", `/api/sessions/${s1.id}/start`);
    ok("start scheduled → running", res.status === 200 && res.body.data.status === "running" && res.body.data.started_at !== null);
    res = await teacher.call("GET", "/api/sessions/active");
    ok("GET /api/sessions/active → la session courante", res.status === 200 && res.body.data.id === s1.id);
    res = await teacher.call("POST", `/api/sessions/${s1.id}/start`);
    ok("start déjà active → 409 SESSION_ALREADY_RUNNING", res.status === 409 && res.body.error.code === "SESSION_ALREADY_RUNNING");
    res = await teacher.call("POST", "/api/sessions", { label: "Cours 2", groupId: g1.id });
    const s2 = res.body.data;
    res = await teacher.call("POST", `/api/sessions/${s2.id}/start`);
    ok("seconde session start refusée (mono-lecteur) → 409 SESSION_ANOTHER_RUNNING", res.status === 409 && res.body.error.code === "SESSION_ANOTHER_RUNNING");
    res = await teacher.call("POST", `/api/sessions/${s1.id}/cancel`);
    ok("annulation pendant running → cancelled", res.status === 200 && res.body.data.status === "cancelled");
    res = await teacher.call("POST", `/api/sessions/${s1.id}/start`);
    ok("re-démarrage cancelled → 409 SESSION_INVALID_TRANSITION", res.status === 409 && res.body.error.code === "SESSION_INVALID_TRANSITION");
    res = await teacher.call("POST", `/api/sessions/${s1.id}/cancel`);
    ok("annulation d'une cancelled → 409", res.status === 409);

    // Multi-group sessions (class shared between several classes):
    // "groupIds" (array) is the current form.
    res = await teacher.call("POST", "/api/groups", { name: "G-multi" });
    const gMulti = res.body.data;
    res = await teacher.call("POST", "/api/sessions", { label: "Cours commun", groupIds: [g1.id, gMulti.id] });
    const sMulti = res.body.data;
    ok(
        "POST groupIds [a,b] → 201 et group_ids reprend les deux groupes",
        res.status === 201 &&
            Array.isArray(sMulti.group_ids) &&
            sMulti.group_ids.length === 2 &&
            sMulti.group_ids.includes(g1.id) &&
            sMulti.group_ids.includes(gMulti.id),
    );
    res = await teacher.call("GET", `/api/sessions/${sMulti.id}`);
    ok("GET /api/sessions/:id → group_ids persistés", res.status === 200 && res.body.data.group_ids.length === 2);
    res = await teacher.call("GET", "/api/sessions");
    ok(
        "liste des sessions : chaque ligne porte group_ids",
        res.status === 200 && (res.body.data as any[]).every((s) => Array.isArray(s.group_ids)),
    );
    res = await teacher.call("POST", "/api/sessions", { label: "Groupe inconnu", groupIds: [987654] });
    ok("groupIds avec groupe inexistant → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
    res = await teacher.call("POST", "/api/sessions", { label: "Duo", groupId: g1.id, groupIds: [g1.id] });
    ok("groupId + groupIds ensemble → 400 (choisir une forme)", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
    res = await teacher.call("POST", "/api/sessions", { label: "Pas un tableau", groupIds: String(g1.id) });
    ok("groupIds non tableau → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
    res = await teacher.call("POST", "/api/sessions", { label: "Non entier", groupIds: [1.5] });
    ok("groupIds non entier → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
    res = await teacher.call("POST", "/api/sessions", { label: "Négatif", groupIds: [0] });
    ok("groupIds < 1 → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
    res = await teacher.call("POST", "/api/sessions", { label: "Sans groupe" });
    ok("session sans groupe → 400 (au moins un groupe requis)", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
    res = await teacher.call("POST", "/api/sessions", { label: "Groupes vide", groupIds: [] });
    ok("groupIds vide → 400 (au moins un groupe requis)", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
}
