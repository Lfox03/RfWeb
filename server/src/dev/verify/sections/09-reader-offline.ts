// Reader (simulated offline) — api:verify section 9
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { ok } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { g1, teacher } = ctx;
    let res: ApiResponse;

    console.log("── 9. Reader (simulated offline) ──");
    res = await teacher.call("GET", "/api/reader/status");
    ok("GET /api/reader/status → online:false (pas de crash)", res.status === 200 && res.body.data.online === false && res.body.data.scanRunning === false);
    res = await teacher.call("POST", "/api/reader/beep");
    ok("beep lecteur hors ligne → 503 READER_OFFLINE", res.status === 503 && res.body.error.code === "READER_OFFLINE");
    res = await teacher.call("POST", "/api/reader/next-card");
    ok("next-card reader offline → 503 READER_OFFLINE", res.status === 503 && res.body.error.code === "READER_OFFLINE");
    res = await teacher.call("POST", "/api/sessions", { label: "Sans lecteur", groupId: g1.id });
    const sNoReader = res.body.data;
    res = await teacher.call("POST", `/api/sessions/${sNoReader.id}/start`);
    ok("démarrage de session sans lecteur → OK (boucle attend)", res.status === 200 && res.body.data.status === "running");
    res = await teacher.call("POST", "/api/reader/next-card");
    ok("next-card while scan loop runs → 409 READER_BUSY", res.status === 409 && res.body.error.code === "READER_BUSY");
    await teacher.call("POST", `/api/sessions/${sNoReader.id}/stop`);
}
