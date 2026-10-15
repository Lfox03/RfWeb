// Reading a cookie out of the request "Cookie" header.
// Shared by the HTTP middleware (api/middleware/auth.ts) and the WebSocket
// handshake (websocket/server.ts): both must authenticate on exactly the same
// "sid" cookie, with no second mechanism.

export function readCookie(header: string | undefined, name: string): string | undefined {
    if (!header) return undefined;
    for (const part of header.split(";")) {
        const eq = part.indexOf("=");
        if (eq === -1) continue;
        if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return undefined;
}
