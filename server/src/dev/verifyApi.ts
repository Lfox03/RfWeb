// Reproducible verification of the Phase 3 backend (API + services + WebSocket).
// Launched by `npm run api:verify` — ALWAYS works on a temporary SQLite
// database (never ./attendance.db) and a simulated reader (RFID_DISABLED).
//
// Structure: environment (env vars, temp dirs) → helpers (ok/waitFor/Client) →
// runner.ts (boot, sequential run of the 32 sections, teardown) → one file per
// section under sections/. Cross-section state flows explicitly through the
// VerifyContext (shared clients, services, and the g1/ada/alan entities).
//
// Coverage: authentication (login/cookie/roles/logout), account management
// (creation/roles/passwords, anti self-lockout protections, invalidation of
// the sessions of an account whose password is reset), kiosk account
// (read-only), validation, groups, students, cards
// (register/assign/replace/revoke, duplicate UID), sessions (full cycle +
// refused transitions + mandatory groups + no session at startup), attendance
// (accepted/duplicate/unknown/expired, manual marking, intact history),
// offline reader without crash, error format, WS (protocol + authentication:
// sid cookie required at the handshake, missing/invalid/expired cookies
// rejected 401, live connections closed on invalidation/expiration),
// scheduler (automatic start/stop on the scheduled_at → + duration window,
// plus deterministic operation under the injected FakeClock — section 21:
// time-traveled windows, inclusive/exclusive boundaries, automatic
// completion, no catch-up, oldest first, all without any real-time delay),
// login rate limiting (progressive lockout per IP and per username, 429
// RATE_LIMITED + Retry-After, expiry/reset, isolation between clients via
// X-Forwarded-For with explicit proxy trust), the RFID abstraction
// (RfidReader dependency injection: FakeRfidReader drives real scans through
// the scan loop, offline/online transitions, busy/timeout/offline errors —
// no physical hardware needed, RFID_DISABLED stays the boot default),
// database backups (admin-only: consistent .db snapshot via the SQLite online
// backup API, WAL included, safe filenames, attachment download, integrity
// verified by opening the file independently, live DB untouched, traversal
// refused) and full database restore (admin-only: invalid/corrupt/future-schema
// files refused before any replacement, running session blocks the restore,
// safety backup of the pre-restore state, live connection swapped and
// repositories transparently rebound, no temp leftovers), structured
// logging (section 22: JSON lines { timestamp, level, event, context } via
// the injected log sink, passwords/tokens/cookies/authorization redacted,
// RFID uids masked, stack traces only for internal errors, end-to-end checks
// through the real login and scan pipelines) and persistent authentication
// sessions (section 23: sessions stored as SHA-256 token hashes in
// auth_sessions — raw cookie token never in the file — surviving a simulated
// restart, concurrent sessions, logout, expiration with lazy + sweep cleanup,
// invalidation on password change, acting session preserved, role changes on
// the same live session) and the admin-only server log tail (section 24:
// GET /api/logs serves the redacted in-memory buffer — admins only, with
// level/limit/since filters and chronological order) and the recurring-series
// service (section 25: daily|weekly occurrence generation over a rolling
// horizon anchored on the injected FakeClock, strict calendar/time/timezone
// validation SQLite would happily normalize away, DST nonexistent times
// skipped and never shifted, ambiguous times resolved to their first
// occurrence, inclusive date bounds and weekday selection, idempotence, group
// and participant-delta copying, paused/cancelled no-generation rules, edits
// from a selected occurrence onward — in-place rewrites preserving ids and
// per-occurrence membership, cancellation of obsolete future occurrences,
// creation of newly required ones — and all-or-nothing transactional rollback)
// and the Phase 3 wiring around it : the recurring-series HTTP API (section 26
// — auth/roles/kiosk read-only, shape and calendar validation, creation/list/
// detail, edit-from-occurrence, pause/resume, cancellation clearing the
// planned future while preserving running/completed/cancelled occurrences and
// attendance history — plus GET /api/sessions/calendar with its LOCAL-date
// semantics and PATCH /api/sessions/:id on scheduled sessions only), the
// roster frozen atomically at start with reporting/scan/manual-marking
// following it — inclusion and exclusion deltas honored, legacy live-roster
// fallback, all-or-nothing rollback, CSV export and kiosk regressions
// (section 27) and the scheduler generation wiring — boot pass and tick
// generation creating SCHEDULED occurrences only, auto start/stop and no
// catch-up untouched, a broken series failing alone while the tick keeps
// starting sessions, logged via the structured logger (section 28), the
// Phase 4 weekly-calendar contracts consumed by the planner (section 29)
// and the Phase 5 hardening (section 30 : membership provenance — generation
// writes INHERITED copies of the series scope, a « this and following » edit
// resynchronizes them while explicit per-occurrence overrides survive,
// individual deltas become editable through PATCH /api/series/:id, an
// occurrence's UTC instant can no longer be moved by PATCH
// /api/sessions/:id — 409 SESSION_OCCURRENCE_MOVE — generation idempotence
// under a rolling horizon, the frozen roster following the propagated scope,
// and every series change broadcast live over the WebSocket as
// series:changed) and the local kiosk console (section 31 : the kiosk opens
// on the SERVER SCREEN without logging in — an anonymous GET from the
// loopback address acts as the read-only kiosk account, writes stay 401,
// admin-only endpoints stay 403, remote callers are refused exactly as
// before, a present-but-invalid cookie is never demoted, and the anonymous
// loopback WebSocket is accepted but never closable through the session
// invalidation/expiration sweeps) and the individual participant selection on
// ONE-OFF sessions (section 32 : POST /api/sessions accepts the very same
// « participants » inclusion/exclusion deltas a series carries — shape-checked,
// persisted explicit (inherited = 0) and round-tripped by GET /api/sessions/:id,
// never a substitute for the mandatory group ; PATCH /api/sessions/:id replaces
// the whole delta set, an unknown student refusing the edit without touching
// label or deltas — and both the creation- and edit-time deltas drive the
// roster frozen at start : inclusions outside the groups join, exclusions
// despite a group leave, and clearing the selection restores the plain group
// roster).

import "./verify/environment"; // MUST be evaluated before any application import
import { getCheckCount } from "./verify/helpers";
import { runSuite } from "./verify/runner";

runSuite()
    .then(() => {
        console.log(`\n[API:VERIFY] ${getCheckCount()} checks passed ✅`);
        process.exit(0);
    })
    .catch((err) => {
        console.error("\n[API:VERIFY] FAILED:", err);
        process.exit(1);
    });
