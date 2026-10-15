// Local wall-clock ↔ UTC instant conversion for a named IANA timezone —
// the deterministic core of recurring-series generation (services/seriesService).
//
// Why not a plain Date(y, m, d, h, min) : a recurring course is defined by its
// LOCAL wall-clock time ("every Monday 08:30 in America/New_York"). The UTC
// instant must therefore be recomputed per occurrence so the course keeps the
// SAME local time across daylight-saving transitions — never shifted by an
// hour because a fixed offset was reused.
//
// DST discontinuities are resolved explicitly (deterministic, never a silent
// shift of the intended wall-clock time) :
//   - "nonexistent" : the local time falls inside the spring-forward gap
//     (e.g. 02:30 the day DST starts) — no instant maps to it. Callers must
//     react (a generated occurrence is SKIPPED and reported, never moved).
//   - "ambiguous" : the local time falls inside the fall-back overlap — it
//     happens twice. The FIRST occurrence (earlier UTC instant, pre-transition
//     offset) is returned, matching the fold=0 convention.
//
// Pure functions only (Intl.DateTimeFormat with full ICU — Node ≥ 20.12 ships
// it) : no clock, no database, no framework — directly testable.
//
// Strict calendar validation lives here too : SQLite's date() NORMALIZES
// out-of-range days (date('2026-02-30') → '2026-03-02'), so the migration 008
// CHECKs cannot be trusted to reject impossible dates — callers must validate
// through parseLocalDate()/parseLocalTime() before persisting.

export type ZonedTimeResolution =
    | { kind: "exact" | "ambiguous"; instantMs: number }
    | { kind: "nonexistent"; instantMs: null };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// 'YYYY-MM-DD' accepted ONLY if it is a real calendar date (leap years
// included) — NOT the lenient normalization of SQLite's date().
export function parseLocalDate(value: string): { y: number; m: number; d: number } | null {
    const match = DATE_RE.exec(value);
    if (!match) return null;
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    if (m < 1 || m > 12) return null;
    if (d < 1 || d > daysInMonth(y, m)) return null;
    return { y, m, d };
}

export function isValidLocalDate(value: string): boolean {
    return parseLocalDate(value) !== null;
}

// 'HH:MM' 24-hour wall clock (same grammar as the migration 008 CHECKs).
export function parseLocalTime(value: string): { h: number; m: number } | null {
    const match = TIME_RE.exec(value);
    if (!match) return null;
    return { h: Number(match[1]), m: Number(match[2]) };
}

export function isValidIanaTimezone(tz: string): boolean {
    if (tz.length < 1 || tz.length > 64) return false;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

function daysInMonth(y: number, m: number): number {
    // Day 0 of the NEXT month = last day of this month (Date.UTC normalizes).
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Date.UTC maps years 0-99 into the 1900s — setUTCFullYear does not, so the
// strict 4-digit ISO years below 100 stay truthful.
function utcMs(y: number, m: number, d: number, h = 0, min = 0): number {
    const instant = new Date(Date.UTC(y, m - 1, d, h, min));
    instant.setUTCFullYear(y);
    return instant.getTime();
}

// ─── Calendar arithmetic on 'YYYY-MM-DD' strings ──────────────────────────────

export function addLocalDays(date: string, days: number): string {
    const { y, m, d } = parseLocalDate(date)!;
    return new Date(utcMs(y, m, d) + days * 86_400_000).toISOString().slice(0, 10);
}

// JS getDay convention : 0 = Sunday … 6 = Saturday. A calendar date has the
// same weekday whatever the timezone — computed from UTC parts.
export function weekdayOfLocalDate(date: string): number {
    const { y, m, d } = parseLocalDate(date)!;
    return new Date(utcMs(y, m, d)).getUTCDay();
}

// ─── Zone offsets via Intl (memoized formatters) ──────────────────────────────

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(tz: string): Intl.DateTimeFormat {
    let fmt = formatterCache.get(tz);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
        });
        formatterCache.set(tz, fmt);
    }
    return fmt;
}

// Local wall-clock parts rendered by the zone at a given instant.
function wallClockParts(tz: string, instantMs: number): { date: string; time: string; msOfDay: number } {
    const parts = Object.fromEntries(
        zoneFormatter(tz)
            .formatToParts(new Date(instantMs))
            .filter((p) => p.type !== "literal")
            .map((p) => [p.type, p.value]),
    ) as Record<string, string>;
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const hour = Number(parts.hour) % 24; // '24' never appears with h23, defensive anyway
    const time = `${String(hour).padStart(2, "0")}:${parts.minute}`;
    const msOfDay = (hour * 60 + Number(parts.minute)) * 60_000 + Number(parts.second) * 1_000;
    return { date, time, msOfDay };
}

// Offset (UTC − local, minutes) observed by the zone AT an instant.
function zoneOffsetMinutes(tz: string, instantMs: number): number {
    const { date, msOfDay } = wallClockParts(tz, instantMs);
    const [y, m, d] = date.split("-").map(Number);
    const wallAsUtc = utcMs(y, m, d) + msOfDay;
    return Math.round((wallAsUtc - instantMs) / 60_000);
}

// ─── The conversion ───────────────────────────────────────────────────────────

// Converts a LOCAL date + wall-clock TIME in an IANA zone to the UTC instant.
// Resolution :
//   1. offset seeds from the classic double pass (treat the wall-clock reading
//      as if it were UTC, shift by the offset observed there, re-evaluate) —
//      agreement means "no discontinuity between the reading and its own
//      instant", disagreement already marks a DST neighbourhood ;
//   2. the neighbourhood of the candidate is then PROBED (±2 h, 15-minute
//      grid — every real offset change is a multiple of ≥ 15 minutes) so a
//      fold the double pass converges past cannot hide a second instant ;
//   3. every distinct offset observed becomes a candidate instant; only the
//      candidates the zone actually renders for this wall-clock reading
//      survive : zero survivors → nonexistent, one → exact, two or more →
//      ambiguous (FIRST occurrence kept).
export function zonedTimeToUtc(date: string, time: string, tz: string): ZonedTimeResolution {
    const d = parseLocalDate(date);
    const t = parseLocalTime(time);
    if (!d || !t) {
        throw new RangeError(`Date/heure locale invalides : ${date} ${time}`);
    }
    const wallMs = utcMs(d.y, d.m, d.d, t.h, t.m);

    const offsetA = zoneOffsetMinutes(tz, wallMs);
    const candidateA = wallMs - offsetA * 60_000;
    const offsetB = zoneOffsetMinutes(tz, candidateA);

    const seeds = offsetB === offsetA ? [offsetA] : [offsetA, offsetB];
    const offsets = new Set<number>(seeds);
    const center = candidateA;
    for (let k = -8; k <= 8; k += 1) {
        offsets.add(zoneOffsetMinutes(tz, center + k * 15 * 60_000));
    }

    const instants = new Set<number>();
    for (const offset of offsets) {
        const candidate = wallMs - offset * 60_000;
        if (rendersWallClock(tz, candidate, date, time)) instants.add(candidate);
    }

    if (instants.size === 0) return { kind: "nonexistent", instantMs: null };
    const sorted = [...instants].sort((a, b) => a - b);
    return {
        kind: sorted.length >= 2 ? "ambiguous" : "exact",
        instantMs: sorted[0],
    };
}

function rendersWallClock(tz: string, instantMs: number, date: string, time: string): boolean {
    const wall = wallClockParts(tz, instantMs);
    return wall.date === date && wall.time === time;
}

// Local calendar date rendered by the zone at an instant (horizon anchoring :
// "today" for a series is TODAY in its own timezone).
export function localDateInZone(instantMs: number, tz: string): string {
    return wallClockParts(tz, instantMs).date;
}

// Local wall-clock date + time rendered by the zone at an instant
// (assertion helper : proves an instant preserved the intended local time).
export function localDateTimeInZone(instantMs: number, tz: string): { date: string; time: string } {
    const { date, time } = wallClockParts(tz, instantMs);
    return { date, time };
}
