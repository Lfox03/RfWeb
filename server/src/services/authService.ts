// Authentication service — login/logout, accounts, server sessions.
// Deliberately minimal: no JWT nor self-sufficient token. State lives
// server-side in the auth_sessions SQLite table (migration 006): one row per
// active session, keyed by the SHA-256 hash of the opaque token — the raw
// token only ever travels through the HTTP-only cookie and NEVER reaches the
// database, which is why sessions now survive a server restart. Everything
// else is unchanged: opaque « sid » cookie, HTTP-only settings,
// SESSION_TTL_HOURS, logout, password-reset revocation (acting session
// survives), immediate role changes (the user row is reloaded per request).
// The pure token mechanics (generation, hashing) live in auth/sessionStore.

import { hashPassword, verifyPassword } from "../auth/password";
import { generateToken, hashToken, notifyDestroyed } from "../auth/sessionStore";
import { SESSION_TTL_HOURS } from "../config/env";
import { AuthenticationError, ConflictError, NotFoundError, SelfRoleChangeError } from "../core/errors";
import { logger } from "../core/logger";
import { authSessionRepository, userRepository } from "../db";
import { isoNow } from "../db/types";
import type { AuthSessionRow, IsoDateTime, UserRow, UserRole } from "../db/types";

// Authenticated user — the only shape that ever leaves this service
// (never password_hash).
export interface AuthUser {
    id: number;
    username: string;
    role: UserRole;
}

// Account view for user management (GET /api/users and friends) — adds the
// non-sensitive lifecycle metadata an admin needs; never password_hash.
export interface UserAccount extends AuthUser {
    created_at: IsoDateTime;
    updated_at: IsoDateTime;
}

function toAuthUser(user: UserRow): AuthUser {
    return { id: user.id, username: user.username, role: user.role };
}

function toUserAccount(user: UserRow): UserAccount {
    return {
        id: user.id,
        username: user.username,
        role: user.role,
        created_at: user.created_at,
        updated_at: user.updated_at,
    };
}

export const INVALID_CREDENTIALS_MESSAGE = "Identifiants invalides.";

const authLog = logger.child({ component: "auth" });

// ─── Persistent session store (auth_sessions) ────────────────────────────────

// Creates a session row for a user and returns its RAW token — the only
// place the raw token ever exists (the database stores hashToken(token)).
function createSession(userId: number): string {
    const token = generateToken();
    const now = isoNow();
    const expiresAt = new Date(Date.parse(now) + SESSION_TTL_HOURS * 3_600_000).toISOString();
    authSessionRepository.create({
        tokenHash: hashToken(token),
        userId,
        createdAt: now,
        expiresAt,
        lastSeenAt: now,
    });
    return token;
}

// Activity stamp throttling: an authenticated request refreshes last_seen_at
// at most once per minute per session (better-sqlite3 is synchronous — an
// UPDATE on every request would be pure WAL churn).
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

// Resolves a raw token → stored session row (null when unknown). Expired
// rows are rejected AND cleaned up right away (lazy purge, no timer needed
// on the hot path).
function resolveSession(token: string): AuthSessionRow | null {
    const tokenHash = hashToken(token);
    const row = authSessionRepository.findByTokenHash(tokenHash);
    if (!row) return null;
    const now = isoNow();
    if (Date.parse(row.expires_at) <= Date.parse(now)) {
        // Lazy TTL purge: no destroy notification here — the WebSocket layer
        // closes expired connections with its own reason (« Session expirée »)
        // via the periodic revalidation sweep.
        authSessionRepository.deleteByTokenHash(tokenHash);
        return null;
    }
    if (Date.parse(row.last_seen_at) + LAST_SEEN_WRITE_INTERVAL_MS <= Date.parse(now)) {
        authSessionRepository.touchLastSeen(tokenHash, now);
    }
    return row;
}

function destroySession(token: string): void {
    const tokenHash = hashToken(token);
    if (authSessionRepository.deleteByTokenHash(tokenHash)) notifyDestroyed(tokenHash);
}

// Destroys every stored session of a user (used when an administrator resets
// that user's password). The acting session itself can be kept alive by
// passing it as exceptToken, so an admin resetting their own password is not
// logged out mid-operation.
function destroyUserSessions(userId: number, exceptToken?: string): number {
    const destroyedHashes = authSessionRepository.deleteByUserExcept(
        userId,
        exceptToken ? hashToken(exceptToken) : undefined,
    );
    for (const tokenHash of destroyedHashes) notifyDestroyed(tokenHash);
    return destroyedHashes.length;
}

// Sweeps every expired row (indexed DELETE). Expired rows are rejected on
// lookup anyway — this keeps the table bounded without a timer: called at
// boot and on every login.
export function purgeExpiredSessions(): number {
    return authSessionRepository.purgeExpired(isoNow());
}

// Exposed for api:verify only — simulates the TTL expiration of a session
// without waiting the real SESSION_TTL_HOURS (backdates its expiry, exactly
// like the clock crossing it).
export function expireSession(token: string): boolean {
    const expiredAt = new Date(Date.parse(isoNow()) - 1).toISOString();
    return authSessionRepository.setExpiresAt(hashToken(token), expiredAt);
}

// Number of stored sessions that are still live (api:verify + diagnostics).
export function sessionCount(): number {
    return authSessionRepository.countActive(isoNow());
}

// ─── Service ──────────────────────────────────────────────────────────────────

export async function login(
    username: string,
    password: string,
): Promise<{ user: AuthUser; token: string }> {
    // Opportunistic cleanup: cheap, indexed, and keeps the table bounded
    // even on a server that never restarts.
    purgeExpiredSessions();
    const user = userRepository.findByUsername(username);
    const valid = user ? await verifyPassword(password, user.password_hash) : false;
    if (!user || !valid) {
        // Same message whether the account exists or not (anti-enumeration);
        // the password NEVER reaches the logs (and the logger would redact it).
        authLog.warn("auth.login_failed", { username });
        throw new AuthenticationError(INVALID_CREDENTIALS_MESSAGE, "INVALID_CREDENTIALS");
    }
    const token = createSession(user.id);
    authLog.info("auth.login_success", { username: user.username, role: user.role });
    return { user: toAuthUser(user), token };
}

export function logout(token: string | undefined): void {
    if (token) destroySession(token);
}

// Resolves a session token → user (null if unknown or expired). The user row
// is RELOADED on every call, so role changes apply to live sessions
// immediately (this is what every authenticated HTTP request and the WS
// revalidation sweep go through).
export function resolveToken(token: string | undefined): { user: AuthUser; token: string } | null {
    if (!token) return null;
    const session = resolveSession(token);
    if (!session) return null;
    const user = userRepository.findById(session.user_id);
    if (!user) {
        // Orphaned session (e.g. a restored database without that account):
        // rejected like the 401 it is, and cleaned up.
        authSessionRepository.deleteByTokenHash(hashToken(token));
        return null;
    }
    return { user: toAuthUser(user), token };
}

export function listUsers(): UserAccount[] {
    return userRepository.findAll().map(toUserAccount);
}

export async function createUser(input: {
    username: string;
    password: string;
    role: UserRole;
}): Promise<UserAccount> {
    if (userRepository.findByUsername(input.username)) {
        throw new ConflictError("USERNAME_TAKEN", `Le nom d'utilisateur « ${input.username} » est déjà pris.`);
    }
    const created = userRepository.create({
        username: input.username,
        passwordHash: await hashPassword(input.password),
        role: input.role,
    });
    return toUserAccount(created);
}

// Change another user's role. The acting admin's own role is intentionally
// not editable (server-side self-lockout protection): the only change an
// admin could apply to themselves is a demotion, which would silently strip
// their own access.
export function updateRole(actor: AuthUser, userId: number, role: UserRole): UserAccount {
    if (userId === actor.id && role !== actor.role) {
        throw new SelfRoleChangeError();
    }
    const updated = userRepository.updateRole(userId, role);
    if (!updated) throw new NotFoundError("Utilisateur");
    return toUserAccount(updated);
}

// Password reset (admin). The target user's other stored sessions are
// destroyed — an administrator resets a password precisely when the previous
// one can no longer be trusted. The acting session (exceptToken) survives so
// an admin resetting their own password is not logged out mid-operation.
export async function setPassword(userId: number, password: string, actorToken?: string): Promise<void> {
    const user = userRepository.findById(userId);
    if (!user) throw new NotFoundError("Utilisateur");
    userRepository.setPasswordHash(userId, await hashPassword(password));
    const destroyed = destroyUserSessions(userId, actorToken);
    if (destroyed > 0) {
        authLog.info("auth.password_reset", { user_id: userId, sessions_destroyed: destroyed });
    }
}

// Hash exposed for the development seed only.
export { hashPassword };
