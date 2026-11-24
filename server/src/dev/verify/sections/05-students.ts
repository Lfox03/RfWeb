// Students — api:verify section 5
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { ok } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { g1, teacher } = ctx;
    let res: ApiResponse;

    console.log("── 5. Students ──");
    res = await teacher.call("POST", "/api/students", { firstName: "Ada", lastName: "Lovelace", groupId: g1.id, email: "ada@ex.io" });
    ok("POST /api/students → 201", res.status === 201 && res.body.data.first_name === "Ada");
    const ada = res.body.data;
    res = await teacher.call("POST", "/api/students", { lastName: "SansPrénom" });
    ok("student sans firstName → 400", res.status === 400);
    res = await teacher.call("POST", "/api/students", { firstName: "X", groupId: 987654 });
    ok("groupe inexistant → 400 VALIDATION_ERROR", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
    res = await teacher.call("POST", "/api/students", { firstName: "Alan", studentNumber: "S-001" });
    const alan = res.body.data;
    res = await teacher.call("POST", "/api/students", { firstName: "Autre", studentNumber: "S-001" });
    ok("student_number dupliqué → 409 STUDENT_NUMBER_TAKEN", res.status === 409 && res.body.error.code === "STUDENT_NUMBER_TAKEN");
    res = await teacher.call("PATCH", `/api/students/${ada.id}`, { lastName: null });
    ok("PATCH null efface last_name", res.status === 200 && res.body.data.last_name === null);
    res = await teacher.call("GET", `/api/students/${ada.id}`);
    ok("GET /api/students/:id → 200", res.status === 200 && res.body.data.id === ada.id);
    res = await teacher.call("DELETE", "/api/students/999999");
    ok("DELETE étudiant inconnu → 404", res.status === 404);
    res = await teacher.call("GET", "/api/students/by-card/12345");
    ok("by-card sans carte → 404", res.status === 404);
    res = await teacher.call("GET", "/api/students/abc");
    ok("id non numérique → 400", res.status === 400);
    ctx.ada = ada; // shared with sections 6, 8, 25–26
    ctx.alan = alan; // shared with sections 6, 8, 16, 25–26
}
