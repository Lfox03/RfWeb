// Health and idle at startup — api:verify section 1
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { Client, ok, REMOTE_HEADERS } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { anon, base, sessionService } = ctx;

    console.log("── 1. Health and idle at startup ──");
    let         res = await anon.call("GET", "/api/health");
    ok("GET /api/health → 200 {status:ok}", res.status === 200 && res.body.status === "ok");
    res = await new Client(base, REMOTE_HEADERS).call("GET", "/api/sessions/active");
    ok("route protégée sans session (distant) → 401 NOT_AUTHENTICATED", res.status === 401 && res.body.error.code === "NOT_AUTHENTICATED");
    // (La boucle locale, elle, bénéficie du compte borne implicite : section 31.)

    // Active session = null verified via an authenticated call further down;
    // here check the absence at service level (no session at boot).
    ok("aucune session active au démarrage (service)", sessionService.getActive() === null);
}
