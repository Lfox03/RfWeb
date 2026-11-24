// Journalisation structurée : lignes JSON + masquage des données sensibles — api:verify section 22
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { ok, waitFor } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { anon, sessionService, teacher } = ctx;
    let res: ApiResponse;

    console.log("── 22. Journalisation structurée : lignes JSON + masquage des données sensibles ──");
    {
        const { logger, setLogSink, maskUid } = await import("../../../core/logger");
        const { setClock } = await import("../../../core/clock");
        const { FakeClock } = await import("../../../core/fakeClock");
        const { errorHandler } = await import("../../../api/middleware/error");
        const { AppError } = await import("../../../core/errors");

        // Silence d'abord : aucun tick ni boucle de scan ne doit venir
        // polluer la capture pendant cette section.
        for (const s of sessionService.list()) {
            if (s.status === "running") await teacher.call("POST", `/api/sessions/${s.id}/stop`);
            if (s.status === "scheduled") await teacher.call("POST", `/api/sessions/${s.id}/cancel`);
        }

        interface CapturedLine {
            line: string;
            level: string;
            record: any;
        }
        const captured: CapturedLine[] = [];
        const restoreSink = setLogSink((line, level, record) => {
            captured.push({ line, level, record });
        });
        try {
            const probe = logger.child({ component: "verify" });
            const findLine = (event: string): CapturedLine | undefined => captured.find((c) => c.record.event === event);

            // 1) Format : une ligne JSON par événement { timestamp ISO UTC,
            //    level, event, contexte } (+ bindings du child). Le timestamp
            //    reste à l'heure RÉELLE même sous FakeClock (exception
            //    délibérée des logs, cf. core/logger.ts).
            const fake = new FakeClock("2026-05-05T10:00:00.000Z");
            const restoreClock = setClock(fake);
            try {
                probe.info("verify.event", { session_id: 42, ok: true });
            } finally {
                restoreClock();
            }
            const fmt = findLine("verify.event")!;
            ok(
                "ligne directe : JSON parseable { timestamp, level, event, contexte } (+ bindings child)",
                fmt.record.level === "info" &&
                    fmt.record.event === "verify.event" &&
                    fmt.record.component === "verify" &&
                    fmt.record.session_id === 42 &&
                    fmt.record.ok === true,
            );
            ok(
                "timestamp ISO UTC à l'heure réelle malgré FakeClock injectée (exception logs)",
                fmt.record.timestamp === new Date(fmt.record.timestamp).toISOString() &&
                    Math.abs(Date.now() - Date.parse(fmt.record.timestamp)) < 120_000 &&
                    JSON.parse(fmt.line).timestamp === fmt.record.timestamp,
            );

            // 2) Masquage : mot de passe, hash, token, cookie, authorization,
            //    sid — y compris imbriqués — et UID RFID tronqué aux 4 derniers.
            captured.length = 0;
            probe.info("verify.secret", {
                username: "root",
                password: "S3cret-JAMAIS-DANS-LES-LOGS",
                password_hash: "scrypt$N$r$p$c2FsdA==$aGFzaA==",
                token: "TOKEN-SESSION-XYZ",
                cookie: "sid=TOKEN-SESSION-XYZ",
                headers: { authorization: "Bearer ABC123SECRET", accept: "application/json" },
                nested: { sid: "SID-42", newPassword: "nope-jamais" },
                uid: "9000001",
                scans: [{ uid: "9000002", note: "visible" }],
            });
            const sec = findLine("verify.secret")!;
            ok(
                "aucune valeur sensible ne subsiste dans la ligne sérialisée",
                !sec.line.includes("S3cret-JAMAIS-DANS-LES-LOGS") &&
                    !sec.line.includes("scrypt$") &&
                    !sec.line.includes("TOKEN-SESSION-XYZ") &&
                    !sec.line.includes("ABC123SECRET") &&
                    !sec.line.includes("SID-42") &&
                    !sec.line.includes("nope-jamais") &&
                    !sec.line.includes("9000001") &&
                    !sec.line.includes("9000002"),
            );
            ok(
                "champs sensibles remplacés par [redacted] (récursif, hors majuscules/« _ »)",
                sec.record.password === "[redacted]" &&
                    sec.record.password_hash === "[redacted]" &&
                    sec.record.token === "[redacted]" &&
                    sec.record.cookie === "[redacted]" &&
                    sec.record.headers.authorization === "[redacted]" &&
                    sec.record.nested.sid === "[redacted]" &&
                    sec.record.nested.newPassword === "[redacted]",
            );
            ok(
                "les champs non sensibles traversent intacts",
                sec.record.username === "root" &&
                    sec.record.headers.accept === "application/json" &&
                    sec.record.scans[0].note === "visible",
            );
            ok(
                "UID RFID masqués aux 4 derniers chiffres (uid, decid, hexid, y compris dans un tableau)",
                sec.record.uid === "***0001" && sec.record.scans[0].uid === "***0002" && maskUid("9000001") === "***0001",
            );

            // 3) Filtrage par niveau : debug silencieux par défaut.
            probe.debug("verify.hidden", {});
            ok(
                "LOG_LEVEL par défaut (info) : les lignes debug sont écartées",
                captured.every((c) => c.record.event !== "verify.hidden"),
            );
            process.env.LOG_LEVEL = "debug";
            try {
                probe.debug("verify.visible", {});
            } finally {
                delete process.env.LOG_LEVEL;
            }
            ok("LOG_LEVEL=debug : la ligne debug est émise", findLine("verify.visible")?.level === "debug");

            // 4) Le middleware d'erreur ne journalise la stack QUE pour les 500,
            //    et la réponse client reste générique (aucun détail interne).
            const makeRes = (): any => {
                const res: any = {
                    status(s: number) {
                        res.statusCode = s;
                        return res;
                    },
                    set() {
                        return res;
                    },
                    json(body: unknown) {
                        res.body = body;
                        return res;
                    },
                };
                return res;
            };

            captured.length = 0;
            const internalRes = makeRes();
            errorHandler(new Error("PANNE-INTERNE-BOOM"), { method: "GET", originalUrl: "/api/boom" } as any, internalRes, () => {});
            const internalLine = captured.find((c) => c.record.event === "http.request_error");
            ok(
                "500 : journalisée level error AVEC stack (serveur uniquement)",
                internalLine?.level === "error" &&
                    internalLine.record.code === "INTERNAL" &&
                    typeof internalLine.record.error?.stack === "string" &&
                    internalLine.record.error.stack.includes("PANNE-INTERNE-BOOM"),
            );
            ok(
                "500 : réponse client générique — message interne et stack ne sortent jamais",
                internalRes.statusCode === 500 &&
                    internalRes.body.error.code === "INTERNAL" &&
                    !JSON.stringify(internalRes.body).includes("PANNE-INTERNE-BOOM"),
            );

            captured.length = 0;
            const clientErrRes = makeRes();
            errorHandler(
                new AppError(404, "NOT_FOUND", "Session introuvable."),
                { method: "GET", originalUrl: "/api/sessions/999999" } as any,
                clientErrRes,
                () => {},
            );
            const clientErrLine = captured.find((c) => c.record.event === "http.request_error");
            ok(
                "4xx : journalisée sans stack ni objet Error (method/path/status/code suffisent)",
                clientErrLine?.level === "info" &&
                    clientErrLine.record.status === 404 &&
                    clientErrLine.record.code === "NOT_FOUND" &&
                    clientErrLine.record.error === undefined &&
                    clientErrLine.record.stack === undefined,
            );

            // 5) Bout en bout par HTTP : l'échec de login journalise le nom
            //    d'utilisateur, JAMAIS le mot de passe soumis.
            captured.length = 0;
            res = await anon.call("POST", "/api/auth/login", { username: "root", password: "jamais-dans-les-logs" });
            const loginFail = captured.find((c) => c.record.event === "auth.login_failed");
            ok(
                "login refusé : username journalisé, mot de passe absent de la ligne",
                res.status === 401 && loginFail?.record.username === "root" && !loginFail.line.includes("jamais-dans-les-logs"),
            );

            // 6) Bout en bout par le vrai pipeline de scan (lecteur factice) :
            //    la ligne scan.accepted masque l'UID et ne nomme pas l'élève.
            const rfidMod = await import("../../../rfid/reader");
            const { FakeRfidReader } = await import("../../../rfid/fakeReader");
            const scanner = new FakeRfidReader();
            const restoreReader = rfidMod.setReader(scanner);
            try {
                res = await teacher.call("POST", "/api/groups", { name: "G-LOG" });
                const gLog = res.body.data;
                res = await teacher.call("POST", "/api/students", { firstName: "Lou", lastName: "Journal", groupId: gLog.id });
                const lou = res.body.data;
                await teacher.call("POST", `/api/students/${lou.id}/card`, { uid: "7700001" });
                res = await teacher.call("POST", "/api/sessions", { label: "Session logs", groupId: gLog.id });
                const sLog = res.body.data;
                await teacher.call("POST", `/api/sessions/${sLog.id}/start`);
                scanner.setOnline(true);
                await waitFor("boucle de scan armée (section 22)", () => scanner.pendingReads === 1);
                captured.length = 0;
                scanner.presentCard("7700001");
                await waitFor("ligne scan.accepted capturo", () => captured.some((c) => c.record.event === "scan.accepted"));
                const scanLine = captured.find((c) => c.record.event === "scan.accepted")!;
                ok(
                    "scan réel : uid masqué (***0001), uid complet et nom de l'élève absents de la ligne",
                    scanLine.record.uid === "***0001" &&
                        scanLine.record.session_id === sLog.id &&
                        scanLine.record.student_id === lou.id &&
                        !scanLine.line.includes("7700001") &&
                        !scanLine.line.includes("Lou") &&
                        !scanLine.line.includes("Journal"),
                );
                await teacher.call("POST", `/api/sessions/${sLog.id}/stop`);
                if (scanner.pendingReads > 0) scanner.presentCard("7700000"); // vide la lecture abandonnée
            } finally {
                restoreReader();
            }
        } finally {
            restoreSink();
        }
    }
}
