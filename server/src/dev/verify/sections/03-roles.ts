// Roles — api:verify section 3
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { ok } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { admin, teacher } = ctx;
    let res: ApiResponse;

    console.log("── 3. Roles ──");
    res = await teacher.call("GET", "/api/users");
    ok("GET /api/users avec teacher → 403 FORBIDDEN", res.status === 403 && res.body.error.code === "FORBIDDEN");
    res = await admin.call("GET", "/api/users");
    ok("GET /api/users avec admin → 200 (2 comptes)", res.status === 200 && res.body.meta.total === 2);
    res = await admin.call("POST", "/api/users", { username: "prof2", password: "prof2-pass-123", role: "teacher" });
    ok("POST /api/users (admin) → 201", res.status === 201);
    res = await admin.call("POST", "/api/users", { username: "root", password: "encore-123456", role: "teacher" });
    ok("username en double → 409 USERNAME_TAKEN", res.status === 409 && res.body.error.code === "USERNAME_TAKEN");
    res = await admin.call("POST", "/api/users", { username: "x!", password: "12345678", role: "teacher" });
    ok("username invalide → 400", res.status === 400);
    res = await admin.call("POST", "/api/users", { username: "shorty", password: "court", role: "teacher" });
    ok("mot de passe trop court → 400", res.status === 400);
}
