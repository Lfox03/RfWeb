// Groups — api:verify section 4
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { ok } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { teacher } = ctx;
    let res: ApiResponse;

    console.log("── 4. Groups ──");
    res = await teacher.call("POST", "/api/groups", { name: "G1" });
    ok("POST /api/groups → 201", res.status === 201 && res.body.data.name === "G1");
    res = await teacher.call("POST", "/api/groups", { name: "G1" });
    ok("groupe dupliqué → 409 GROUP_NAME_TAKEN", res.status === 409 && res.body.error.code === "GROUP_NAME_TAKEN");
    const g1 = res.status === 409 ? (await teacher.call("GET", "/api/groups")).body.data.find((g: any) => g.name === "G1") : res.body.data;
    res = await teacher.call("PATCH", `/api/groups/${g1.id}`, { name: "G1-bis" });
    ok("PATCH groupe → renommé", res.status === 200 && res.body.data.name === "G1-bis");
    res = await teacher.call("POST", "/api/groups", { name: "" });
    ok("groupe sans nom → 400", res.status === 400);
    ctx.g1 = g1; // shared with sections 7–9, 15, 21, 25–26, 31
}
