// « Machine's own console » policy — the kiosk opened on the server screen.
//
// Loopback means exactly 127.0.0.1 (IPv4) or ::1 (IPv6) — nothing else in
// 127/8 counts as local. Used by the anonymous local-kiosk access (see
// api/middleware/auth.ts and websocket/server.ts), so HTTP and the WebSocket
// handshake decide identically.
//
// Same convention as the login rate limiter: X-Forwarded-For is honored ONLY
// when TRUST_PROXY=1 (a reverse proxy is declared); otherwise the socket
// address is the only trusted source, so a forged forwarded header can never
// invent a loopback client.

import type { IncomingHttpHeaders } from "node:http";

import { TRUST_PROXY } from "../config/env";

// Strict loopback (tolerates the dual-stack « ::ffff:127.0.0.1 » form).
export function isLoopbackAddress(raw: string | undefined | null): boolean {
    if (!raw) return false;
    let a = raw.trim().toLowerCase();
    if (a.startsWith("::ffff:")) a = a.slice("::ffff:".length);
    return a === "127.0.0.1" || a === "::1";
}

// Address the request is attributed to — mirrors what Express computes as
// req.ip under « trust proxy 1 » (the LAST X-Forwarded-For hop) when
// TRUST_PROXY=1, the socket address otherwise. Recomputed here (rather than
// using req.ip) because the WebSocket handshake has no Express request.
export function clientAddressFrom(headers: IncomingHttpHeaders, socketRemoteAddress?: string): string | undefined {
    if (TRUST_PROXY) {
        const xff = headers["x-forwarded-for"];
        const value = Array.isArray(xff) ? xff[xff.length - 1] : xff;
        if (value) {
            const hops = value
                .split(",")
                .map((hop) => hop.trim())
                .filter(Boolean);
            if (hops.length > 0) return hops[hops.length - 1];
        }
    }
    return socketRemoteAddress;
}

export function isLocalRequest(headers: IncomingHttpHeaders, socketRemoteAddress?: string): boolean {
    return isLoopbackAddress(clientAddressFrom(headers, socketRemoteAddress));
}
