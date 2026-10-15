// Controllable fake clock for tests (api:verify) — implements the Clock
// interface (core/clock.ts) without ever touching the system clock.
//
// Injected with setClock(fake), restored with the returned function, just
// like FakeRfidReader for the reader. now() returns a defensive copy:
// callers can mutate the returned Date without corrupting the fake.

import type { Clock } from "./clock";

function toInstant(value: Date | string): Date {
    const instant = typeof value === "string" ? new Date(value) : new Date(value.getTime());
    if (Number.isNaN(instant.getTime())) {
        throw new RangeError(`Instant invalide pour l'horloge factice : ${JSON.stringify(value)}`);
    }
    return instant;
}

export class FakeClock implements Clock {
    private current: Date;

    constructor(start: Date | string = "2026-01-01T00:00:00.000Z") {
        this.current = toInstant(start);
    }

    now(): Date {
        return new Date(this.current.getTime());
    }

    /** Jumps to an absolute instant (ISO string or Date). */
    set(instant: Date | string): void {
        this.current = toInstant(instant);
    }

    /** Moves the clock forward by a number of (non-negative) milliseconds. */
    advance(ms: number): void {
        if (!Number.isFinite(ms) || ms < 0) {
            throw new RangeError(`Durée invalide pour l'horloge factice : ${ms}`);
        }
        this.current = new Date(this.current.getTime() + ms);
    }
}
