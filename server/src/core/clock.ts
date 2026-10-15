// Injectable clock: the single seam through which the application reads
// the current time for business logic (session transitions, scheduling
// windows, automatic session completion).
//
// Same dependency-injection pattern as the RFID reader (rfid/reader.ts):
// consumers resolve the ACTIVE clock through getClock() on every
// operation, and tests swap the implementation with setClock()
// (FakeClock — see core/fakeClock.ts). The production default is the
// system clock, so boot behavior and unrelated code are untouched.
//
// Every timestamp written by the application flows through this clock
// (isoNow() in db/types.ts resolves the active clock on each call) —
// including the auth_sessions expiry/last-seen stamps, so session expiration
// can be time-traveled too.
// Deliberate exceptions keeping their own real-time test hooks: the login
// rate limiter (loginRateLimit.ts) and the logger timestamps.

export interface Clock {
    now(): Date;
}

// Production clock: the system clock (unchanged behavior everywhere the
// active clock has not been explicitly replaced).
export const systemClock: Clock = {
    now: () => new Date(),
};

let activeClock: Clock = systemClock;

export function getClock(): Clock {
    return activeClock;
}

// Replaces the active clock (test seam). Returns a function restoring the
// previously active one.
export function setClock(clock: Clock): () => void {
    const previous = activeClock;
    activeClock = clock;
    return () => {
        activeClock = previous;
    };
}
