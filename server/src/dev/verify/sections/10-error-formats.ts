// Error formats and end of life — api:verify section 10
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { ok } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { base, teacher } = ctx;
    let res: ApiResponse;

    console.log("── 10. Error formats and end of life ──");
    res = await teacher.call("GET", "/api/inexistant");
    ok("route API inconnue → 404 NOT_FOUND structuré", res.status === 404 && res.body.error.code === "NOT_FOUND");
    res = await teacher.call("POST", "/api/groups", "pas-json" as never);
    ok("corps non-objet → 400", res.status === 400);
    const badJson = await fetch(`${base}/api/groups`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    const badJsonBody: any = await badJson.json();
    ok("JSON illégal → 400 INVALID_JSON sans stack", badJson.status === 400 && badJsonBody.error.code === "INVALID_JSON" && !JSON.stringify(badJsonBody).includes("at "));
    const noStack = await fetch(`${base}/api/students/999999`, { headers: { cookie: teacher.cookie! } });
    const noStackBody: any = await noStack.json();
    ok("404 sans détail interne", !JSON.stringify(noStackBody).includes("SQLITE"));
}
