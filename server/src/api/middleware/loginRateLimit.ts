// Brute-force protection for POST /api/auth/login — hand-rolled in-memory
// limiter (no dependency), deliberately coarse: two independent counters per
// fixed window, one per CLIENT IP and one per normalized username, so neither
// varying usernames (caught by the IP counter) nor a distributed attack on a
// single account (caught by the username counter) bypasses the limit.
//
// Every non-2xx response of the login route (401 bad credentials AND 400
// malformed body) counts as a failure — the check runs BEFORE validation, so
// a locked-out client receives 429 whatever it sends. Once a bucket exceeds
// its failure limit, it locks with a progressive backoff:
// base × 2^(failures − limit), capped. A successful login clears the buckets.
//
// The response never reveals WHICH dimension tripped (nor whether the account
// exists): same code, same message, Retry-After only.

import type { RequestHandler } from "express";

import {
    LOGIN_BACKOFF_BASE_SECONDS,
    LOGIN_BACKOFF_MAX_MINUTES,
    LOGIN_FAIL_LIMIT_PER_IP,
    LOGIN_FAIL_LIMIT_PER_USER,
    LOGIN_RATE_WINDOW_MINUTES,
} from "../../config/env";
import { RateLimitError } from "../../core/errors";

interface Bucket {
    failures: number;
    firstFailureAt: number; // start of the current fixed window
    blockedUntil: number; // 0 = not locked
}

const WINDOW_MS = Math.max(1, LOGIN_RATE_WINDOW_MINUTES) * 60_000;
const BACKOFF_BASE_MS = Math.max(1, LOGIN_BACKOFF_BASE_SECONDS) * 1_000;
const BACKOFF_MAX_MS = Math.max(1, LOGIN_BACKOFF_MAX_MINUTES) * 60_000;

// Safety valve: never let a hostile flood of distinct keys grow unbounded.
const MAX_TRACKED_KEYS = 10_000;

const ipBuckets = new Map<string, Bucket>();
const userBuckets = new Map<string, Bucket>();

// Username buckets ignore case and surrounding spaces: « Root », « root » and
// «  ROOT  » are the same account for the limiter (as for the DB unique index
// lookups this is intentionally conservative).
function usernameCandidate(body: unknown): string | undefined {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
    const raw = (body as Record<string, unknown>).username;
    if (typeof raw !== "string") return undefined;
    const normalized = raw.trim().toLowerCase().slice(0, 64);
    return normalized === "" ? undefined : normalized;
}

function retryAfterMs(bucket: Bucket | undefined, now: number): number {
    if (!bucket || bucket.blockedUntil <= now) return 0;
    return bucket.blockedUntil - now;
}

function prune(map: Map<string, Bucket>, now: number): void {
    if (map.size <= MAX_TRACKED_KEYS) return;
    for (const [key, bucket] of map) {
        if (bucket.blockedUntil <= now && now - bucket.firstFailureAt > WINDOW_MS) map.delete(key);
    }
    // Still saturated (every key fresh and recent): fail OPEN rather than
    // exhaust memory — this limiter is abuse damping, not a quota ledger.
    if (map.size > MAX_TRACKED_KEYS) map.clear();
}

function registerFailure(map: Map<string, Bucket>, key: string, limit: number, now: number): void {
    let bucket = map.get(key);
    if (!bucket || now - bucket.firstFailureAt > WINDOW_MS) {
        bucket = { failures: 0, firstFailureAt: now, blockedUntil: 0 };
        map.set(key, bucket);
    }
    bucket.failures += 1;
    if (bucket.failures >= Math.max(1, limit)) {
        const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (bucket.failures - Math.max(1, limit)), BACKOFF_MAX_MS);
        bucket.blockedUntil = now + backoff;
    }
    prune(map, now);
}

export const loginRateLimit: RequestHandler = (req, res, next) => {
    const now = Date.now();
    const ip = req.ip ?? "ip-inconnue";
    const username = usernameCandidate(req.body);

    const blockedMs = Math.max(retryAfterMs(ipBuckets.get(ip), now), retryAfterMs(userBuckets.get(username ?? ""), now));
    if (blockedMs > 0) {
        next(new RateLimitError(Math.max(1, Math.ceil(blockedMs / 1000))));
        return;
    }

    // Outcome recorded once the response is flushed: success clears, any
    // error status (400 malformed OR 401 invalid credentials) counts.
    res.on("finish", () => {
        const at = Date.now();
        if (res.statusCode >= 400) {
            registerFailure(ipBuckets, ip, LOGIN_FAIL_LIMIT_PER_IP, at);
            if (username) registerFailure(userBuckets, username, LOGIN_FAIL_LIMIT_PER_USER, at);
        } else {
            ipBuckets.delete(ip);
            if (username) userBuckets.delete(username);
        }
    });
    next();
};

// ─── Test hooks (api:verify) ──────────────────────────────────────────────────

// Clears every bucket (isolates the rate-limit section from the rest of the
// suite, which legitimately fails a few logins from 127.0.0.1).
export function resetLoginRateLimits(): void {
    ipBuckets.clear();
    userBuckets.clear();
}

// Simulates the passage of time without sleeping: shifts every stored
// timestamp back by ms (equivalent to « now advanced by ms »).
export function shiftLoginRateLimitClock(ms: number): void {
    for (const map of [ipBuckets, userBuckets]) {
        for (const bucket of map.values()) {
            bucket.firstFailureAt -= ms;
            bucket.blockedUntil -= ms;
        }
    }
}
