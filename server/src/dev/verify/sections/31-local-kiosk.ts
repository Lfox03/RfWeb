// Borne locale : accès kiosk anonyme depuis la boucle locale (écran du serveur) — api:verify section 31
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { Client, ok, REMOTE_HEADERS, waitFor } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { admin, attendanceService, base, g1, httpPort, sessionService, teacher } = ctx;
    let res: ApiResponse;

    console.log("── 31. Borne locale : accès kiosk anonyme depuis la boucle locale (écran du serveur) ──");
    {
        const { WebSocket: Ws31 } = await import("ws");
        type Ws31Client = import("ws").WebSocket;
        const { revalidateConnectedClients } = await import("../../../websocket/server");
        const { isLoopbackAddress } = await import("../../../core/loopback");
        const db31 = await import("../../../db"); // accès « live » : la réouverture simulée de la section 23 a rebordé les simpletons

        // Silence : rien d'autre ne doit courir (mono-lecteur + scans).
        for (const s of sessionService.list()) {
            if (s.status === "running") await teacher.call("POST", `/api/sessions/${s.id}/stop`);
            if (s.status === "scheduled") await teacher.call("POST", `/api/sessions/${s.id}/cancel`);
        }

        // ── Sémantique stricte de la boucle locale (le 127/8 complet ne
        //    compte pas comme local — seul 127.0.0.1/::1) ──
        ok(
            "isLoopbackAddress : 127.0.0.1 et ::1 oui (forme ::ffff: incluse), tout le reste non",
            isLoopbackAddress("127.0.0.1") &&
                isLoopbackAddress("::ffff:127.0.0.1") &&
                isLoopbackAddress("::1") &&
                !isLoopbackAddress("127.0.0.2") &&
                !isLoopbackAddress("::ffff:127.0.0.2") &&
                !isLoopbackAddress("10.0.0.1") &&
                !isLoopbackAddress(""),
        );

        const borneLocal = new Client(base); // aucun cookie : anonyme depuis 127.0.0.1
        const borneDistant = new Client(base, REMOTE_HEADERS);

        // ── Lecture HTTP : mêmes droits que le compte kiosk ──
        res = await borneLocal.call("GET", "/api/auth/me");
        ok(
            "GET /api/auth/me sans cookie (boucle locale) → 200 pseudo-compte kiosk (amorçage client /kiosk)",
            res.status === 200 && res.body.data.user.role === "kiosk" && res.body.data.user.username === "borne",
        );
        res = await borneLocal.call("GET", "/api/sessions/active");
        ok("GET /api/sessions/active sans cookie (boucle locale) → 200", res.status === 200);
        res = await borneLocal.call("GET", "/api/students");
        ok("GET /api/students sans cookie → 200 (roster lisible par la borne)", res.status === 200 && Array.isArray(res.body.data));
        res = await borneLocal.call("GET", "/api/groups");
        ok("GET /api/groups sans cookie → 200", res.status === 200 && Array.isArray(res.body.data));
        res = await borneLocal.call("GET", "/api/series");
        ok("GET /api/series sans cookie → 200", res.status === 200);
        res = await borneLocal.call("GET", "/api/reports/sessions");
        ok("GET /api/reports/sessions sans cookie → 200", res.status === 200 && Array.isArray(res.body.data));

        // ── Le réservé admin reste refusé : 403 (permissions kiosk, pas
        //    clé magique) ──
        res = await borneLocal.call("GET", "/api/users");
        ok("GET /api/users sans cookie (boucle locale) → 403 FORBIDDEN (pas 401 : pseudo-compte kiosk)", res.status === 403 && res.body.error.code === "FORBIDDEN");
        res = await borneLocal.call("GET", "/api/logs");
        ok("GET /api/logs sans cookie (boucle locale) → 403", res.status === 403 && res.body.error.code === "FORBIDDEN");
        res = await borneLocal.call("GET", "/api/backups");
        ok("GET /api/backups sans cookie (boucle locale) → 403", res.status === 403 && res.body.error.code === "FORBIDDEN");

        // ── Écriture : jamais — l'anonyme n'emprunte aucune identité ──
        res = await borneLocal.call("POST", "/api/sessions", { label: "Écrite", groupId: g1.id });
        ok("POST /api/sessions sans cookie (boucle locale) → 401 NOT_AUTHENTICATED", res.status === 401 && res.body.error.code === "NOT_AUTHENTICATED");
        res = await borneLocal.call("PATCH", `/api/groups/${g1.id}`, { name: "Piraté" });
        ok("PATCH /api/groups/:id sans cookie → 401", res.status === 401 && res.body.error.code === "NOT_AUTHENTICATED");
        res = await borneLocal.call("POST", "/api/reader/beep");
        ok("POST /api/reader/beep sans cookie → 401", res.status === 401);
        res = await borneLocal.call("DELETE", "/api/students/1");
        ok("DELETE /api/students/1 sans cookie → 401", res.status === 401);

        // ── L'exception ne vaut PAS pour un appel distant ──
        res = await borneDistant.call("GET", "/api/sessions/active");
        ok("GET /api/sessions/active sans cookie (distant) → 401", res.status === 401 && res.body.error.code === "NOT_AUTHENTICATED");
        res = await borneDistant.call("GET", "/api/auth/me");
        ok("GET /api/auth/me sans cookie (distant) → 401", res.status === 401);
        res = await borneDistant.call("GET", "/api/students");
        ok("GET /api/students sans cookie (distant) → 401", res.status === 401);
        // TRUST_PROXY=1 (décidé pour la suite) : l'adresse retenue est bien
        // celle de X-Forwarded-For — un proxy local sur boucle locale peut
        // donc légitimement propager un client local.
        res = await new Client(base, { "x-forwarded-for": "127.0.0.1" }).call("GET", "/api/sessions/active");
        ok("GET /api/sessions/active avec X-Forwarded-For 127.0.0.1 (TRUST_PROXY=1) → 200 (contrat proxy)", res.status === 200);

        // ── Cookie présent mais mort : JAMAIS repoli en borne ──
        const peume = new Client(base);
        peume.cookie = "sid=00000000peume";
        res = await peume.call("GET", "/api/sessions/active");
        ok("cookie invalide (boucle locale) → 401 (pas dégradé en borne)", res.status === 401 && res.body.error.code === "NOT_AUTHENTICATED");
        const deconnecte = new Client(base);
        deconnecte.cookie = "sid=";
        res = await deconnecte.call("GET", "/api/auth/me");
        ok("cookie vidé par logout (« sid= ») → 401 (attribut présent = jamais borne)", res.status === 401);

        // ── Une vraie session connectée n'est jamais rétrogradée ──
        res = await teacher.call("POST", "/api/groups", { name: "G-P6-OK" });
        ok("teacher authentifié via boucle locale : écritures toujours possibles (pas de rétrogradation)", res.status === 201);

        // ── WebSocket : handshake anonyme accepté depuis la boucle locale ──
        // Messages tamponnés DÈS la création : le snapshot « status » peut
        // précéder tout handler enregistré après l'event « open ».
        const inbox31: any[] = [];
        const ws31: Ws31Client = new Ws31(`ws://127.0.0.1:${httpPort}/ws`);
        ws31.on("message", (m: Buffer) => inbox31.push(JSON.parse(m.toString())));
        ws31.on("error", () => { /* le rejet du handshake est traité par la promesse « open » */ });
        try {
            await new Promise<void>((resolve, reject) => {
                ws31.once("open", () => resolve());
                ws31.once("error", (err: Error) => reject(err));
                setTimeout(() => reject(new Error("timeout handshake WS anonyme")), 3000);
            });
            await waitFor("snapshot « status » sur le WS anonyme", () => inbox31.some((m) => m.event === "status"));
            ok("WS sans cookie (boucle locale) → handshake accepté, snapshot « status » reçu", true);

            ws31.send(JSON.stringify({ cmd: "get_status" }));
            await waitFor("réponse « get_status » sur le WS anonyme", () => inbox31.filter((m) => m.event === "status").length >= 2);
            ok("commande « get_status » servie au WS anonyme", true);

            // Les événements du domaine parviennent bien à la borne
            // anonyme (c'est par là qu'elle projette l'affluence) :
            // session dédiée + scan, arrêt immédiat.
            res = await teacher.call("POST", "/api/sessions", { label: "Scan borne locale", groupId: g1.id });
            const s31 = res.body.data;
            sessionService.start(s31.id);
            void attendanceService.handleScan("1234567");
            await waitFor("attendance:scanned sur le WS anonyme", () =>
                inbox31.some((m) => m.event === "attendance:scanned" && m.content.sessionId === s31.id),
            );
            const ev31 = inbox31.find((m) => m.event === "attendance:scanned" && m.content.sessionId === s31.id);
            ok("attendance:scanned diffusé au client WS anonyme (kiosk local)", ev31.content.result === "unknown");
            sessionService.stop(s31.id);

            // ── Le client kiosk local n'a AUCUNE session derrière lui :
            //    ni la balayade d'expiration, ni la destruction d'une autre
            //    session ne doivent le fermer ──
            const closed31 = new Promise<"closed">((resolve) => ws31.once("close", () => resolve("closed")));
            revalidateConnectedClients();
            res = await admin.call("POST", "/api/users", { username: "p6tmp", password: "p6tmp-pass-123", role: "teacher" });
            const p6 = new Client(base);
            await p6.call("POST", "/api/auth/login", { username: "p6tmp", password: "p6tmp-pass-123" });
            const p6Row = db31.userRepository.findByUsername("p6tmp")!;
            // Détruit la session de p6tmp → notifie le hub (ferme SES
            // connexions) — l'anonyme, lui, n'a pas de token.
            await admin.call("PATCH", `/api/users/${p6Row.id}`, { password: "p6tmp-nouveau-123" });
            const stillOpen = await Promise.race([
                closed31,
                new Promise<"open">((resolve) => setTimeout(() => resolve("open"), 500)),
            ]);
            ok(
                "balayage d'expiration + destruction d'une AUTRE session ne ferment pas le WS anonyme (aucun token)",
                stillOpen === "open",
            );
        } finally {
            ws31.terminate();
        }
    }
}
