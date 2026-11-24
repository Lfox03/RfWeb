// WebSocket (protocol + authentication) — api:verify section 11
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { Client, ok, REMOTE_HEADERS } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { admin, attendanceService, base, httpPort, sessionService, teacher, userRepository, wsPort } = ctx;
    let res: ApiResponse;

    console.log("── 11. WebSocket (protocol + authentication) ──");
    if (typeof wsPort === "number") {
        const { WebSocket } = await import("ws");
        type WsClient = import("ws").WebSocket;
        const { WS_CLOSE_INVALID_SESSION } = await import("../../../websocket/hub");
        const standaloneUrl = `ws://127.0.0.1:${wsPort}/`; // path ignored there
        const mountedUrl = `ws://127.0.0.1:${httpPort}/ws`;

        // Successful connection: resolves with the first message (the
        // « status » snapshot); rejects if the handshake is refused.
        const wsConnected = (url: string, cookie?: string): Promise<{ ws: WsClient; first: any }> =>
            new Promise((resolve, reject) => {
                const ws = new WebSocket(url, cookie ? { headers: { cookie } } : undefined);
                ws.once("message", (m: Buffer) => resolve({ ws, first: JSON.parse(m.toString()) }));
                ws.once("error", (err: Error) => reject(err));
                setTimeout(() => reject(new Error(`timeout snapshot WS (${url})`)), 3000);
            });

        // Refused connection: ws must answer HTTP 401 before the upgrade
        // (the client surfaces it as an « Unexpected server response »).
        // The no-cookie cases pass REMOTE_HEADERS: from the LOOPBACK the
        // absent cookie is exactly the local kiosk (accepted — section 31).
        const wsRejected401 = async (url: string, cookie?: string, extraHeaders?: Record<string, string>): Promise<boolean> => {
            const headers: Record<string, string> = { ...extraHeaders };
            if (cookie) headers.cookie = cookie;
            const ws = new WebSocket(url, Object.keys(headers).length ? { headers } : undefined);
            try {
                await new Promise<void>((resolve, reject) => {
                    ws.once("open", () => reject(new Error("connexion WS acceptée alors qu'elle devait être refusée")));
                    ws.once("error", (err: Error) => {
                        if (err.message.includes("401")) resolve();
                        else reject(new Error(`rejet inattendu : ${err.message}`));
                    });
                    setTimeout(() => reject(new Error(`timeout rejet WS (${url})`)), 3000);
                });
                return true;
            } finally {
                ws.terminate();
            }
        };

        const wsCloseCode = (ws: WsClient): Promise<number> =>
            new Promise((resolve, reject) => {
                ws.once("close", (code: number) => resolve(code));
                setTimeout(() => reject(new Error("timeout fermeture WS")), 3000);
            });

        // The protocol is unchanged — it just requires an authenticated
        // handshake (same « sid » cookie as the HTTP API).
        const { ws, first: firstMessage } = await wsConnected(standaloneUrl, teacher.cookie);
        ok("snapshot « status » reçu à la connexion", firstMessage.event === "status" && firstMessage.content.readerOnline === false);

        // new session + scan → attendance:scanned event
        const { sessionRepository } = await import("../../../db");
        const wsSession = sessionRepository.create({ label: "Session WS", scheduledAt: new Date().toISOString() });
        sessionService.start(wsSession.id);
        const scanEvent = await new Promise<any>((resolve, reject) => {
            ws.on("message", (m: Buffer) => {
                const msg = JSON.parse(m.toString());
                if (msg.event === "attendance:scanned") resolve(msg);
            });
            setTimeout(() => reject(new Error("timeout attendance:scanned")), 3000);
            attendanceService.handleScan("1234567");
        });
        ok("événement attendance:scanned diffusé (unknown)", scanEvent.event === "attendance:scanned" && scanEvent.content.result === "unknown");

        // Phase 6 (kiosk): an admin attendance reset must be broadcast so
        // live clients resync their counters from the server.
        const resetEventPromise = new Promise<any>((resolve, reject) => {
            const onMsg = (m: Buffer): void => {
                const msg = JSON.parse(m.toString());
                if (msg.event === "attendance:reset") {
                    ws.off("message", onMsg);
                    resolve(msg);
                }
            };
            ws.on("message", onMsg);
            setTimeout(() => reject(new Error("timeout attendance:reset")), 3000);
        });
        const resetRes = await teacher.call("POST", `/api/sessions/${wsSession.id}/attendance/reset`);
        const resetEvent = await resetEventPromise;
        ok(
            "attendance:reset broadcast on reset (kiosk sync)",
            resetRes.status === 204 && resetEvent.event === "attendance:reset" && resetEvent.content.sessionId === wsSession.id,
        );

        sessionService.stop(wsSession.id);
        ws.close();

        // Hub also reachable same-origin on the HTTP port (React client path).
        const { ws: wsViaHttp, first: httpSnapshot } = await wsConnected(mountedUrl, teacher.cookie);
        ok("WS mounted on HTTP port at /ws → status snapshot", httpSnapshot.event === "status");
        wsViaHttp.close();

        // ── WS authentication (sid cookie checked during the handshake) ──
        const authService = await import("../../../services/authService");
        const { revalidateConnectedClients } = await import("../../../websocket/server");

        // Dedicated account for the WS lifecycle checks (the suite's own
        // sessions stay untouched).
        res = await admin.call("POST", "/api/users", { username: "wsuser", password: "wsuser-pass-123", role: "teacher" });
        ok("compte dédié WS créé → 201", res.status === 201);
        const wsu = new Client(base);
        res = await wsu.call("POST", "/api/auth/login", { username: "wsuser", password: "wsuser-pass-123" });
        ok("login dédié WS (wsuser) → 200", res.status === 200);

        ok("WS sans cookie refusé (distant, standalone, HTTP 401)", await wsRejected401(standaloneUrl, undefined, REMOTE_HEADERS));
        ok("WS sans cookie refusé (distant, /ws, HTTP 401)", await wsRejected401(mountedUrl, undefined, REMOTE_HEADERS));
        ok("WS cookie invalide refusé (/ws, HTTP 401 — jamais repoli en borne)", await wsRejected401(mountedUrl, "sid=00000000invalide"));

        // Cookie that was valid but whose session has expired: rejected on
        // both transports (TTL simulated via authService.expireSession).
        const expLogin = await fetch(`${base}/api/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username: "wsuser", password: "wsuser-pass-123" }),
        });
        const expToken = /sid=([^;]+)/.exec(expLogin.headers.get("set-cookie") ?? "")?.[1] ?? "";
        ok("expiration simulée de la session (TTL)", authService.expireSession(expToken));
        ok("WS cookie expiré refusé (standalone, HTTP 401)", await wsRejected401(standaloneUrl, `sid=${expToken}`));
        ok("WS cookie expiré refusé (/ws, HTTP 401)", await wsRejected401(mountedUrl, `sid=${expToken}`));

        // Logout while connected → the live connection is closed (1008).
        await wsu.call("POST", "/api/auth/login", { username: "wsuser", password: "wsuser-pass-123" });
        {
            const { ws: liveLogout } = await wsConnected(standaloneUrl, wsu.cookie);
            const closing = wsCloseCode(liveLogout);
            await wsu.call("POST", "/api/auth/logout");
            ok("logout → connexion WS fermée immédiatement (1008)", (await closing) === WS_CLOSE_INVALID_SESSION);
        }

        // Admin resets the user's password (destroys their sessions) → same.
        await wsu.call("POST", "/api/auth/login", { username: "wsuser", password: "wsuser-pass-123" });
        {
            const { ws: liveReset } = await wsConnected(mountedUrl, wsu.cookie);
            const closing = wsCloseCode(liveReset);
            const wsuRow = userRepository.findByUsername("wsuser")!;
            res = await admin.call("PATCH", `/api/users/${wsuRow.id}`, { password: "wsuser-nouveau-123" });
            ok(
                "réinitialisation du mot de passe → connexion WS fermée (1008)",
                res.status === 200 && (await closing) === WS_CLOSE_INVALID_SESSION,
            );
        }

        // Session expiring while connected → the revalidation sweep closes
        // it (same as what the server's 60 s timer does).
        await wsu.call("POST", "/api/auth/login", { username: "wsuser", password: "wsuser-nouveau-123" });
        {
            const liveToken = (wsu.cookie ?? "").slice("sid=".length);
            const { ws: liveExp } = await wsConnected(mountedUrl, wsu.cookie);
            ok("expiration TTL simulée sur la session connectée", authService.expireSession(liveToken));
            const closing = wsCloseCode(liveExp);
            revalidateConnectedClients();
            ok("session expirée → connexion WS fermée par la revalidation (1008)", (await closing) === WS_CLOSE_INVALID_SESSION);
        }
    } else {
        console.log("  (WS port unresolved — WS verification skipped)");
    }
}
