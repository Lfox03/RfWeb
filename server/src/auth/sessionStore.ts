// Token mechanics for the server-side login sessions.
//
// The sessions themselves are PERSISTENT (auth_sessions SQLite table,
// migration 006) and orchestrated by services/authService through
// authSessionRepository. What stays here is the pure storage-free half shared
// by the HTTP and WebSocket layers:
//   - opaque token generation: 256 random bits. The raw token only ever
//     travels through the HTTP-only cookie and NEVER reaches the database;
//   - SHA-256 hashing: the storage lookup key. The token is high-entropy
//     random data (not a password), so a plain cryptographic digest is the
//     right index — preimages cannot be guessed and a stolen or backed-up
//     database leaks nothing usable;
//   - destruction notifications: the WebSocket layer closes the live
//     connections whose session was just invalidated (logout or password
//     reset) — exactly like the next HTTP request would answer 401.
//     Listeners receive the token HASH (the only identity the database
//     knows); a connection holding the raw token hashes it to compare.

import { createHash, randomBytes } from "node:crypto";

export function generateToken(): string {
    return randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

type DestroyListener = (tokenHash: string) => void;
const destroyListeners = new Set<DestroyListener>();

export function onSessionDestroyed(listener: DestroyListener): () => void {
    destroyListeners.add(listener);
    return () => {
        destroyListeners.delete(listener);
    };
}

export function notifyDestroyed(tokenHash: string): void {
    for (const listener of destroyListeners) listener(tokenHash);
}
