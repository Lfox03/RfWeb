// TypeScript WebSocket server — broadcasting layer for domain events
// (protocol documented in hub.ts). Replaces web/socket.js for the new
// application; no legacy imported here.
//
// Two transports over the SAME hub (same clients, same events):
//   1. standalone server on WS_PORT (historical startup, kept for tests);
//   2. mount on the existing HTTP server at path /ws (attachWebSocketServer):
//      in production the React client is served by that same HTTP server, so
//      it can connect via ws(s)://<same origin>/ws without knowing any port
//      (the Vite dev proxy maps /ws to this HTTP port as well).
//
// AUTHENTICATION (both transports, both created by createTransportServer):
// the handshake must carry the same HTTP-only « sid » cookie as the REST API,
// resolved by authService.resolveToken — no second mechanism, no JWT. An
// absent/invalid/expired session aborts the upgrade with HTTP 401 (ws writes
// the rejection itself in verifyClient): no WebSocket is ever created, and
// the browser sends the cookie automatically on a same-origin handshake, so
// the protocol and the frontend stay untouched. A session destroyed while
// its connection is open (logout, password reset) or expiring (TTL) closes
// that connection with code 1008 — same semantics as the next HTTP 401.

import type * as http from "node:http";

import { WebSocketServer, type VerifyClientCallbackSync, type WebSocket } from "ws";

import { readCookie } from "../auth/cookie";
import { hashToken, onSessionDestroyed } from "../auth/sessionStore";
import { COOKIE_NAME, WS_PORT } from "../config/env";
import { errorFields, logger } from "../core/logger";
import { resolveToken } from "../services/authService";
import type { AuthUser } from "../services/authService";
import {
    WS_CLOSE_INVALID_SESSION,
    addClient,
    broadcastEvent,
    clientCount,
    closeClientsFor,
    removeClient,
} from "./hub";

// Never log the sid cookie nor session tokens — identity only (username/role)
// and counts.
const wsLog = logger.child({ component: "ws" });

export interface WsStatusSnapshot {
    readerOnline: boolean;
    session: unknown | null;
}

export interface WebSocketHandle {
    close(): Promise<void>;
    /** Actually bound port (may differ from the requested port if 0). */
    port: number;
}

interface WsAuth {
    user: AuthUser;
    token: string;
}

// verifyClient → "connection" handoff: ws passes THE SAME request object to
// both callbacks, and the request disappears as soon as the connection is
// registered — a WeakMap keyed by the request leaks nothing and avoids
// polluting IncomingMessage with a global augmentation.
const handshakes = new WeakMap<http.IncomingMessage, WsAuth>();

// The single authentication point of BOTH transports (ws applies verifyClient
// to its own upgrade handling AND to handleUpgrade). Must stay SYNCHRONOUS
// with exactly one parameter (ws detects the async flavor via fn.length === 2).
const verifyWebSocketClient: VerifyClientCallbackSync = (info) => {
    const resolved = resolveToken(readCookie(info.req.headers.cookie, COOKIE_NAME));
    if (!resolved) return false;
    handshakes.set(info.req, resolved);
    return true;
};

// Shared per-connection wiring: initial status snapshot, get_status command,
// lifecycle logging. Used by both transports so the protocol never drifts.
function registerClient(ws: WebSocket, req: http.IncomingMessage, getSnapshot: () => WsStatusSnapshot): void {
    const auth = handshakes.get(req);
    handshakes.delete(req);
    if (!auth) {
        // Cannot happen: verifyWebSocketClient gates every upgrade. Never
        // accept an anonymous connection.
        ws.close(WS_CLOSE_INVALID_SESSION, "Session invalide");
        return;
    }
    addClient(ws, auth.token);
    wsLog.info("ws.client_connected", {
        username: auth.user.username,
        role: auth.user.role,
        clients: clientCount(),
    });

    // Immediate snapshot: the client never needs to re-poll over HTTP.
    try {
        ws.send(JSON.stringify({ event: "status", content: getSnapshot() }));
    } catch {
        /* connection already dead */
    }

    ws.on("message", (raw) => {
        let data: unknown;
        try {
            data = JSON.parse(raw.toString());
        } catch {
            ws.send(JSON.stringify({ event: "error", content: { message: "JSON invalide." } }));
            return;
        }
        const cmd = (data as { cmd?: unknown }).cmd;
        if (cmd === "get_status") {
            ws.send(JSON.stringify({ event: "status", content: getSnapshot() }));
        } else {
            ws.send(
                JSON.stringify({
                    event: "error",
                    content: { message: `Commande inconnue : ${String(cmd)}` },
                }),
            );
        }
    });

    ws.on("close", () => {
        removeClient(ws);
        wsLog.info("ws.client_disconnected", { clients: clientCount() });
    });

    ws.on("error", (err) => wsLog.warn("ws.client_error", errorFields(err)));
}

// Single creation point of the WebSocketServer for BOTH transports: identical
// options — in particular verifyClient (sid cookie authentication) — and the
// same "connection" wiring, so neither transport can drift apart from the
// other (binding: { port } for the standalone server, { noServer: true } for
// the /ws mount whose upgrade handler calls handleUpgrade itself).
function createTransportServer(
    binding: { port?: number; noServer?: boolean },
    getSnapshot: () => WsStatusSnapshot,
): WebSocketServer {
    const wss = new WebSocketServer({ ...binding, verifyClient: verifyWebSocketClient });
    wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => registerClient(ws, req, getSnapshot));
    return wss;
}

// A session destroyed mid-connection (HTTP logout or password reset) must
// close the live WebSocket right away, exactly like the next HTTP request
// would answer 401. Registered once at module load (both transports, once).
// The store notifies with the token HASH (raw tokens are never persisted);
// a connection holds the raw token from its handshake, so the comparison
// hashes it — deterministic SHA-256, cheap for the handful of open sockets.
onSessionDestroyed((tokenHash) => {
    const closed = closeClientsFor(
        (clientToken) => hashToken(clientToken) === tokenHash,
        WS_CLOSE_INVALID_SESSION,
        "Session invalide",
    );
    if (closed > 0) wsLog.info("ws.connections_closed", { closed, reason: "session_invalidated" });
});

// TTL expiration: HTTP re-resolves the cookie on every request, but an open
// WebSocket never asks again — hence this periodic revalidation. unref'd: it
// never keeps the process alive on its own.
const REVALIDATION_INTERVAL_MS = 60_000;

// Exported for api:verify (deterministic expiration check without waiting).
export function revalidateConnectedClients(): void {
    if (clientCount() === 0) return;
    const closed = closeClientsFor(
        (token) => resolveToken(token) === null,
        WS_CLOSE_INVALID_SESSION,
        "Session expirée",
    );
    if (closed > 0) wsLog.info("ws.connections_closed", { closed, reason: "session_expired" });
}

setInterval(revalidateConnectedClients, REVALIDATION_INTERVAL_MS).unref();

// Standalone WebSocket server on its own port (WS_PORT default).
export function startWebSocketServer(
    getSnapshot: () => WsStatusSnapshot,
    port: number = WS_PORT,
): Promise<WebSocketHandle> {
    const wss = createTransportServer({ port }, getSnapshot);

    return new Promise((resolve, reject) => {
        wss.on("listening", () => {
            const address = wss.address();
            const boundPort = typeof address === "object" && address ? address.port : port;
            wsLog.info("ws.listening", { port: boundPort });
            resolve({
                close: () =>
                    new Promise<void>((done) => {
                        for (const client of wss.clients) client.close();
                        wss.close(() => done());
                    }),
                port: boundPort,
            });
        });

        wss.on("error", (err) => {
            wsLog.error("ws.server_error", errorFields(err));
            reject(err);
        });
    });
}

// Mount the same hub on an existing HTTP server at path /ws (no dedicated
// port). Requests upgrading on other paths are left untouched.
export function attachWebSocketServer(
    server: http.Server,
    getSnapshot: () => WsStatusSnapshot,
    path = "/ws",
): void {
    const wss = createTransportServer({ noServer: true }, getSnapshot);

    server.on("upgrade", (req, socket, head) => {
        let pathname = "";
        try {
            pathname = new URL(req.url ?? "", "http://localhost").pathname;
        } catch {
            socket.destroy();
            return;
        }
        if (pathname !== path) return; // Not our transport: leave it alone.
        // handleUpgrade runs verifyClient (sid cookie) before completing: an
        // unauthenticated upgrade gets HTTP 401 and never reaches registerClient.
        wss.handleUpgrade(req, socket, head, (ws, request) => {
            // noServer mode: emitting "connection" here is the documented way
            // (createTransportServer registered the single handler).
            wss.emit("connection", ws, request);
        });
    });
}

export { broadcastEvent };
