// Password and session end — api:verify section 12
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { ok } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { admin, teacher, userRepository } = ctx;
    let res: ApiResponse;
    const { verifyPassword } = await import("../../../auth/password");

    console.log("── 12. Password and session end ──");
    const prof1 = userRepository.findByUsername("prof1")!;
    res = await admin.call("PATCH", `/api/users/${prof1.id}`, { password: "nouveau-pass-123" });
    ok("PATCH password (admin) → 200", res.status === 200);
    const userRow = userRepository.findByUsername("prof1");
    ok("nouveau hash stocké et vérifiable", await verifyPassword("nouveau-pass-123", userRow!.password_hash));
    ok("ancien mot de passe refusé", !(await verifyPassword("prof1-pass-123", userRow!.password_hash)));

    res = await teacher.call("POST", "/api/auth/logout");
    ok("POST /api/auth/logout → 204", res.status === 204);
    res = await teacher.call("GET", "/api/auth/me");
    ok("cookie invalidé après logout → 401", res.status === 401);
    res = await teacher.call("POST", "/api/auth/login", { username: "prof1", password: "prof1-pass-123" });
    ok("ancien mot de passe refusé au login aussi", res.status === 401);
}
