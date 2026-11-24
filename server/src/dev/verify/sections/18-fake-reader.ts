// Abstraction RFID : injection du lecteur factice (RfidReader) — api:verify section 18
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { ok, waitFor } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { teacher } = ctx;
    let res: ApiResponse;

    console.log("── 18. Abstraction RFID : injection du lecteur factice (RfidReader) ──");
    {
        const rfid = await import("../../../rfid/reader");
        const { FakeRfidReader } = await import("../../../rfid/fakeReader");
        const readerSvc = await import("../../../services/readerService");
        const { ReaderTimeoutError } = await import("../../../core/errors");

        ok(
            "lecteur actif par défaut = stub hors ligne (RFID_DISABLED=1, aucune dépendance USB)",
            rfid.getReader().isOnline() === false,
        );

        const fake = new FakeRfidReader();
        const restoreReader = rfid.setReader(fake);

        // ── Simulated offline reader (injected) ──
        res = await teacher.call("GET", "/api/reader/status");
        ok("lecteur injecté hors ligne → /reader/status online:false", res.status === 200 && res.body.data.online === false);
        res = await teacher.call("POST", "/api/reader/beep");
        ok("beep (fake hors ligne) → 503 READER_OFFLINE", res.status === 503 && res.body.error.code === "READER_OFFLINE");
        res = await teacher.call("POST", "/api/reader/next-card");
        ok("next-card (fake hors ligne) → 503 READER_OFFLINE", res.status === 503 && res.body.error.code === "READER_OFFLINE");

        // ── Offline → online transition ──
        fake.setOnline(true);
        res = await teacher.call("GET", "/api/reader/status");
        ok("transition hors ligne → en ligne visible sur /reader/status", res.status === 200 && res.body.data.online === true);
        res = await teacher.call("POST", "/api/reader/beep");
        ok(
            "beep (fake en ligne) → 200 et propagé au lecteur (compteur = 1)",
            res.status === 200 && res.body.data.beep === "ok" && fake.beepCount === 1,
        );

        // ── One-shot HTTP read: UID injected deterministically ──
        const nextCardHttp = teacher.call("POST", "/api/reader/next-card");
        await waitFor("lecture unique armée côté lecteur", () => fake.pendingReads === 1);
        fake.presentCard("9200001", "1C71C1");
        res = await nextCardHttp;
        ok(
            "next-card (HTTP) renvoie l'UID injecté",
            res.status === 200 && res.body.data.uid === "9200001" && res.body.data.hexId === "1C71C1",
        );

        // ── Scan loop driven by the fake reader (real pipeline) ──
        res = await teacher.call("POST", "/api/groups", { name: "G-FAKE" });
        const gFake = res.body.data;
        res = await teacher.call("POST", "/api/students", { firstName: "Fanny", lastName: "Fake", groupId: gFake.id });
        const fanny = res.body.data;
        await teacher.call("POST", `/api/students/${fanny.id}/card`, { uid: "9200002" });
        res = await teacher.call("POST", "/api/sessions", { label: "Session fake reader", groupId: gFake.id });
        const sFake = res.body.data;
        await teacher.call("POST", `/api/sessions/${sFake.id}/start`);

        await waitFor("boucle de scan armée sur le lecteur", () => fake.pendingReads === 1);
        fake.presentCard("9200002");
        await waitFor("présence enregistrée par la boucle", async () => {
            const r = await teacher.call("GET", `/api/sessions/${sFake.id}/attendance`);
            return (r.body.data as any[]).some((row) => row.student_id === fanny.id);
        });
        ok("scan reçu via la boucle + fake → présence enregistrée", true);

        fake.presentCard("9299999"); // unknown card
        fake.presentCard("9200002"); // duplicate of the accepted scan
        await waitFor("doublon journalisé", async () => {
            const r = await teacher.call("GET", `/api/sessions/${sFake.id}/scans`);
            return (r.body.data as any[]).length === 3;
        });
        res = await teacher.call("GET", `/api/sessions/${sFake.id}/scans`);
        const fakeScans = res.body.data as any[];
        res = await teacher.call("GET", `/api/sessions/${sFake.id}/attendance`);
        ok(
            "boucle + fake : 3 scans journalisés (accepted, unknown, duplicate), 1 seule présence",
            fakeScans.map((row) => row.result).join(",") === "accepted,unknown,duplicate" &&
                (res.body.data as any[]).length === 1,
        );

        res = await teacher.call("POST", "/api/reader/next-card");
        ok(
            "next-card pendant que la boucle tient le lecteur → 409 READER_BUSY",
            res.status === 409 && res.body.error.code === "READER_BUSY",
        );

        // ── Hot disconnect/reconnect while the scan loop runs ──
        fake.setOnline(false);
        res = await teacher.call("GET", "/api/reader/status");
        ok(
            "déconnexion à chaud (session en cours) → online:false, scanRunning:true",
            res.status === 200 && res.body.data.online === false && res.body.data.scanRunning === true,
        );
        res = await teacher.call("POST", "/api/reader/beep");
        ok("beep pendant la déconnexion → 503 READER_OFFLINE", res.status === 503 && res.body.error.code === "READER_OFFLINE");

        res = await teacher.call("POST", "/api/students", { firstName: "Franck", lastName: "Reconnect", groupId: gFake.id });
        const frank = res.body.data;
        await teacher.call("POST", `/api/students/${frank.id}/card`, { uid: "9200003" });
        fake.setOnline(true);
        await waitFor("reconnexion : boucle de nouveau armée", () => fake.pendingReads === 1);
        fake.presentCard("9200003");
        await waitFor("scan traité après reconnexion", async () => {
            const r = await teacher.call("GET", `/api/sessions/${sFake.id}/attendance`);
            return (r.body.data as any[]).some((row) => row.student_id === frank.id);
        });
        ok("reconnexion à chaud : la boucle attendait, reprend et traite le scan", true);

        res = await teacher.call("POST", `/api/sessions/${sFake.id}/stop`);
        ok("stop de la session (lecteur fake) → completed", res.status === 200 && res.body.data.status === "completed");
        if (fake.pendingReads > 0) fake.presentCard("9200000"); // vide la lecture abandonnée par la boucle

        // ── Timeout (504) and its busy guard, at the service level ──
        let timedOut = false;
        try {
            await readerSvc.nextCard(150); // aucune carte présentée
        } catch (err) {
            timedOut = err instanceof ReaderTimeoutError;
        }
        ok("next-card sans carte présentée → ReaderTimeoutError (504 READER_TIMEOUT)", timedOut);

        res = await teacher.call("POST", "/api/reader/next-card");
        ok(
            "sonde expirée encore armée côté lecteur → POST next-card 409 READER_BUSY",
            res.status === 409 && res.body.error.code === "READER_BUSY",
        );
        fake.presentCard("9200004"); // satisfait (et consomme) la sonde abandonnée
        await waitFor("sonde abandonnée consommée", () => fake.pendingReads === 0);
        const nextAfterDrain = teacher.call("POST", "/api/reader/next-card");
        await waitFor("nouvelle lecture armée", () => fake.pendingReads === 1);
        fake.presentCard("9200005");
        res = await nextAfterDrain;
        ok("sonde abandonnée consommée → next-card de nouveau opérationnel", res.status === 200 && res.body.data.uid === "9200005");

        restoreReader();
        ok("lecteur par défaut restauré après l'injection (stub hors ligne)", rfid.getReader().isOnline() === false);
    }
}
