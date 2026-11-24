// Authentication — api:verify section 2
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { ok } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { admin, anon, base, teacher } = ctx;
    let res: ApiResponse;

    console.log("── 2. Authentication ──");
    res = await anon.call("POST", "/api/auth/login", { username: "root", password: "mauvais" });
    ok("login mauvais mot de passe → 401 INVALID_CREDENTIALS", res.status === 401 && res.body.error.code === "INVALID_CREDENTIALS");
    res = await anon.call("POST", "/api/auth/login", { username: "root" });
    ok("login sans mot de passe → 400 VALIDATION_ERROR", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");

    res = await teacher.call("POST", "/api/auth/login", { username: "prof1", password: "prof1-pass-123" });
    ok("login teacher → 200, sans hash de mot de passe", res.status === 200 && res.body.data.user.password_hash === undefined);
    const setCookieHeader = await (async () => {
        const r = await fetch(`${base}/api/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username: "root", password: "root-pass-123" }),
        });
        return r.headers.get("set-cookie") ?? "";
    })();
    ok(
        "cookie HTTP-only posé (HttpOnly, SameSite=Lax)",
        /sid=.+HttpOnly/.test(setCookieHeader) && /SameSite=Lax/.test(setCookieHeader),
    );
    admin.cookie = setCookieHeader.split(";")[0];

    res = await admin.call("GET", "/api/auth/me");
    ok("GET /api/auth/me → utilisateur admin", res.status === 200 && res.body.data.user.username === "root");
}
