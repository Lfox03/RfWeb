// Cards — api:verify section 6
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { ok } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { ada, alan, teacher } = ctx;
    let res: ApiResponse;

    console.log("── 6. Cards ──");
    res = await teacher.call("POST", "/api/cards", { uid: "5000001" });
    ok("POST /api/cards (enregistrement) → 201", res.status === 201 && res.body.data.uid === "5000001" && res.body.data.student === null);
    res = await teacher.call("POST", "/api/cards", { uid: "5000001" });
    ok("UID dupliqué → 409 UID_ALREADY_REGISTERED", res.status === 409 && res.body.error.code === "UID_ALREADY_REGISTERED");
    res = await teacher.call("POST", "/api/cards", { uid: "ABC" });
    ok("UID non décimal → 400", res.status === 400);
    res = await teacher.call("POST", `/api/students/${ada.id}/card`, { uid: "5000001" });
    ok("attribution carte → 200 (étudiant joint)", res.status === 200 && res.body.data.student?.id === ada.id);
    res = await teacher.call("GET", "/api/cards/5000001");
    ok("GET /api/cards/:uid → porteur trouvé", res.status === 200 && res.body.data.student?.id === ada.id);
    res = await teacher.call("POST", `/api/students/${alan.id}/card`, { uid: "5000001" });
    ok("carte déjà attribuée (autre étudiant) → 409 CARD_ALREADY_ASSIGNED", res.status === 409 && res.body.error.code === "CARD_ALREADY_ASSIGNED");
    res = await teacher.call("POST", `/api/students/${ada.id}/card`, { uid: "5000002" });
    ok("remplacement de carte → 200", res.status === 200 && res.body.data.uid === "5000002");
    res = await teacher.call("GET", `/api/students/${ada.id}/cards`);
    const adaCards = res.body.data as any[];
    ok(
        "historique cartes : ancienne retirée, historique conservé",
        adaCards.length === 2 && adaCards.find((c) => c.uid === "5000001")?.revoked_at !== null,
    );
    res = await teacher.call("GET", "/api/students/by-card/5000002");
    ok("by-card retrouve l'étudiant", res.status === 200 && res.body.data.id === ada.id);
    res = await teacher.call("POST", "/api/cards/5000002/revoke");
    ok("POST /api/cards/:uid/revoke → retirée", res.status === 200 && res.body.data.revoked_at !== null);
    res = await teacher.call("POST", "/api/cards/5000002/revoke");
    ok("retrait double → 409 CARD_ALREADY_REVOKED", res.status === 409 && res.body.error.code === "CARD_ALREADY_REVOKED");
    // reassignment for the rest of the suite (nominal scan)
    await teacher.call("POST", `/api/students/${ada.id}/card`, { uid: "5000002" });
}
