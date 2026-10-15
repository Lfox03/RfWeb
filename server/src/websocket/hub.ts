// WebSocket domain event broadcaster — protocol for the React client.
//
// ═══ PROTOCOL ════════════════════════════════════════════════════════════════
// Transport: JSON over WebSocket, port WS_PORT (default 8080). Path ignored
// (the Vite proxy maps /ws → root of the port in dev).
//
// Authentication: the handshake must carry the same HTTP-only « sid » cookie
// as the REST API; an invalid/expired/absent session gets HTTP 401 and no
// WebSocket is ever created (see websocket/server.ts). A session destroyed
// while connected (logout, password reset) closes the connection with code
// 1008. The protocol below is unchanged: authentication happens before it.
//
// Messages SERVER → CLIENT — always { "event": string, "content": object } :
//
//   "status"              { readerOnline: boolean, session: SessionWithGroups|null }
//       Snapshot sent on every client connection (immediate state, no
//       HTTP re-poll) and in reply to {cmd:"get_status"}. SessionWithGroups =
//       SessionRow + group_ids (number of the group scope; the session
//       can cover SEVERAL groups, session_groups table).
//   "reader:status"       { online: boolean }
//       Emitted on every RFID reader state change.
//   "session:started"     { session: SessionWithGroups }
//   "session:stopped"     { session: SessionWithGroups, reason: string }
//   "session:updated"     { session: SessionWithGroups }  (e.g. cancellation)
//   "attendance:scanned"  { sessionId, studentId|null, studentName|null,
//                           uid, result: ScanResult, scannedAt }
//       1 message per scan (accepted | duplicate | unknown | expired |
//       out_of_group = student outside the session's groups).
//       result = manual: presence entered manually by a teacher
//       (uid = empty string, no card).
//   "attendance:reset"    { sessionId: number }
//       Attendance STATE cleared by an admin reset (scan history kept).
//       Added for Phase 6 kiosk mode so live counters resync from the server.
//   "series:changed"      { action: "created" | "edited" | "paused"
//                           | "resumed" | "cancelled" | "generated",
//                           series_id: number, occurrences?: number }
//       A recurring-series template changed (create/edit/pause/resume/cancel)
//       OR the rolling generation materialized NEW scheduled occurrences for
//       it ("generated" — only broadcast when at least one row was created,
//       so an idle tick never pings anyone). No payload detail : calendar
//       clients resync their grid from GET /api/sessions/calendar.
//   "error"               { message: string }
//
// Messages CLIENT → SERVER — { "cmd": string } :
//
//   "get_status"          replies "status" (see above).
//
// The WS contains NO business logic: services produce the
// events, the hub broadcasts them.
// ══════════════════════════════════════════════════════════════════════════════

import type { WebSocket } from "ws";

export type WsEvent =
    | "status"
    | "reader:status"
    | "session:started"
    | "session:stopped"
    | "session:updated"
    | "attendance:scanned"
    | "attendance:reset"
    | "series:changed"
    | "error";

// Close code used when the session behind a connection is no longer valid
// (logout, password reset, TTL expiration) — 1008 « Policy Violation ».
export const WS_CLOSE_INVALID_SESSION = 1008;

// Authenticated clients: socket → session token (resolved during the WS
// handshake by websocket/server.ts, same sid cookie as the HTTP API).
const clients = new Map<WebSocket, string>();

export function addClient(ws: WebSocket, token: string): void {
    clients.set(ws, token);
}

export function removeClient(ws: WebSocket): void {
    clients.delete(ws);
}

export function clientCount(): number {
    return clients.size;
}

// Closes every connection whose token satisfies the predicate. Returns the
// number of connections closed. Used when a session is destroyed (logout,
// password reset) and by the periodic expiration sweep (websocket/server.ts).
export function closeClientsFor(
    predicate: (token: string) => boolean,
    code: number = WS_CLOSE_INVALID_SESSION,
    reason: string = "Session invalide",
): number {
    let closed = 0;
    for (const [client, token] of clients) {
        if (!predicate(token)) continue;
        closed += 1;
        try {
            client.close(code, reason);
        } catch {
            // Already disconnecting: removed on close.
        }
    }
    return closed;
}

// Broadcasts a domain event to all connected clients. Never throws:
// broadcasting must never break the business flow that emits it.
export function broadcastEvent(event: WsEvent, content: unknown): void {
    if (clients.size === 0) return;
    const payload = JSON.stringify({ event, content });
    for (const client of clients.keys()) {
        try {
            client.send(payload);
        } catch {
            // Client in the process of disconnecting: ignored, removed on close.
        }
    }
}
