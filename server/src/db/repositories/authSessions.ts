// « Auth sessions » repository — persistent server-side login sessions
// (auth_sessions table, migration 006).
//
// Only the SHA-256 hash of the opaque cookie token is ever stored (UNIQUE):
// the raw token never reaches this layer, let alone the database. Expiry
// timestamps are ISO-8601 UTC strings (isoNow() format); expiry COMPARISONS
// happen in the service against the injected clock — this repository only
// stores and filters with the bounds it is given.

import type { DatabaseHandle } from "../database";
import type { AuthSessionRow, IsoDateTime } from "../types";

export interface NewAuthSession {
    tokenHash: string;
    userId: number;
    createdAt: IsoDateTime;
    expiresAt: IsoDateTime;
    lastSeenAt: IsoDateTime;
}

export function createAuthSessionRepository(db: DatabaseHandle) {
    return {
        create(input: NewAuthSession): AuthSessionRow {
            const info = db
                .prepare(
                    `INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
                     VALUES (?, ?, ?, ?, ?)`,
                )
                .run(input.tokenHash, input.userId, input.createdAt, input.expiresAt, input.lastSeenAt);
            return this.findById(Number(info.lastInsertRowid))!;
        },

        findById(id: number): AuthSessionRow | undefined {
            return db.prepare("SELECT * FROM auth_sessions WHERE id = ?").get(id) as AuthSessionRow | undefined;
        },

        // The authentication hot path: one indexed lookup per request.
        findByTokenHash(tokenHash: string): AuthSessionRow | undefined {
            return db.prepare("SELECT * FROM auth_sessions WHERE token_hash = ?").get(tokenHash) as
                | AuthSessionRow
                | undefined;
        },

        touchLastSeen(tokenHash: string, lastSeenAt: IsoDateTime): void {
            db.prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?").run(lastSeenAt, tokenHash);
        },

        setExpiresAt(tokenHash: string, expiresAt: IsoDateTime): boolean {
            return (
                db.prepare("UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?").run(expiresAt, tokenHash)
                    .changes > 0
            );
        },

        deleteByTokenHash(tokenHash: string): boolean {
            return db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tokenHash).changes > 0;
        },

        // Deletes every session of a user except one (the acting session on a
        // password reset). Returns the deleted token HASHES so the caller can
        // notify connection-level listeners — the raw tokens are unknown
        // here, and must stay that way.
        deleteByUserExcept(userId: number, exceptTokenHash?: string): string[] {
            const where = `user_id = ? AND (? IS NULL OR token_hash != ?)`;
            const rows = db
                .prepare(`SELECT token_hash FROM auth_sessions WHERE ${where}`)
                .all(userId, exceptTokenHash ?? null, exceptTokenHash ?? null) as Array<{ token_hash: string }>;
            if (rows.length > 0) {
                db.prepare(`DELETE FROM auth_sessions WHERE ${where}`).run(
                    userId,
                    exceptTokenHash ?? null,
                    exceptTokenHash ?? null,
                );
            }
            return rows.map((row) => row.token_hash);
        },

        listTokenHashesByUser(userId: number): string[] {
            return (
                db.prepare("SELECT token_hash FROM auth_sessions WHERE user_id = ?").all(userId) as Array<{
                    token_hash: string;
                }>
            ).map((row) => row.token_hash);
        },

        countActive(nowIso: IsoDateTime): number {
            return (db.prepare("SELECT COUNT(*) AS c FROM auth_sessions WHERE expires_at > ?").get(nowIso) as {
                c: number;
            }).c;
        },

        // Deletes rows whose expiry is past `nowIso` (indexed — no table
        // scan). Expired rows are rejected on lookup anyway; this keeps the
        // table bounded without a timer.
        purgeExpired(nowIso: IsoDateTime): number {
            return db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(nowIso).changes;
        },

        count(): number {
            return (db.prepare("SELECT COUNT(*) AS c FROM auth_sessions").get() as { c: number }).c;
        },
    };
}

export type AuthSessionRepository = ReturnType<typeof createAuthSessionRepository>;
