// Reproducible verification of the Phase 3 backend (API + services + WebSocket).
// Launched by `npm run api:verify` — ALWAYS works on a temporary SQLite
// database (never ./attendance.db) and a simulated reader (RFID_DISABLED).
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
// series:changed).

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// ─── Test environment BEFORE any application import ───────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rfweb-api-verify-"));
process.env.DB_PATH = path.join(tmpDir, "verify.db");
process.env.RFID_DISABLED = "1"; // simulated offline reader
process.env.HTTP_HOST = "127.0.0.1";
process.env.WS_PORT = "0"; // ephemeral port
// Backups (section 19) stay in the temp tree — never alongside the repo.
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
// Proxy trust ON for the suite: the rate-limit section simulates a second
// client with X-Forwarded-For (per-IP isolation). Defaults of the limiter
// themselves are asserted in section 17 (a .env override fails that check).
process.env.TRUST_PROXY = "1";

let checks = 0;
function ok(label: string, condition: boolean): void {
    assert.ok(condition, label);
    checks += 1;
    console.log(`  ✔ ${label}`);
}

// Polls a condition (the scan loop runs on its own rhythm: 500 ms between
// scans, 1.5 s of waiting while the reader is offline).
async function waitFor(label: string, condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await condition()) return;
        if (Date.now() > deadline) throw new Error(`délai dépassé : ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

interface ApiResponse {
    status: number;
    body: any;
}

class Client {
    cookie: string | undefined = undefined;

    async call(method: string, route: string, body?: unknown): Promise<ApiResponse> {
        const headers: Record<string, string> = {};
        if (body !== undefined) headers["content-type"] = "application/json";
        if (this.cookie) headers.cookie = this.cookie;
        const res = await fetch(`${this.base}${route}`, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const setCookie = res.headers.get("set-cookie");
        if (setCookie) this.cookie = setCookie.split(";")[0];
        let parsed: unknown = null;
        const text = await res.text();
        if (text) {
            try {
                parsed = JSON.parse(text);
            } catch {
                /* empty response */
            }
        }
        return { status: res.status, body: parsed };
    }

    constructor(public readonly base: string) {}
}

async function main(): Promise<void> {
    try {
        const { createApp } = await import("../app");
        const { attachWebSocketServer, startWebSocketServer } = await import("../websocket/server");
        const { userRepository } = await import("../db");
        const { hashPassword } = await import("../auth/password");
        const { verifyPassword } = await import("../auth/password");
        const attendanceService = await import("../services/attendanceService");
        const sessionService = await import("../services/sessionService");
        const { getStatus: readerStatus } = await import("../services/readerService");

        // Test accounts created directly (password known to the suite).
        userRepository.create({ username: "root", passwordHash: await hashPassword("root-pass-123"), role: "admin" });
        userRepository.create({ username: "prof1", passwordHash: await hashPassword("prof1-pass-123"), role: "teacher" });

        const app = createApp();
        const server = http.createServer(app);
        // Same-origin WebSocket transport (production mounting).
        attachWebSocketServer(server, () => ({
            readerOnline: readerStatus().online,
            session: sessionService.getActive(),
        }));
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const httpPort = (server.address() as any).port as number;
        const base = `http://127.0.0.1:${httpPort}`;
        const wsHandle = await startWebSocketServer(
            () => ({ readerOnline: readerStatus().online, session: sessionService.getActive() }),
            0,
        );
        const wsPort = wsHandle.port;

        const anon = new Client(base);
        const admin = new Client(base);
        const teacher = new Client(base);

        console.log("── 1. Health and idle at startup ──");
        let res = await anon.call("GET", "/api/health");
        ok("GET /api/health → 200 {status:ok}", res.status === 200 && res.body.status === "ok");
        res = await anon.call("GET", "/api/sessions/active");
        ok("route protégée sans session → 401 NOT_AUTHENTICATED", res.status === 401 && res.body.error.code === "NOT_AUTHENTICATED");

        // Active session = null verified via an authenticated call further down;
        // here check the absence at service level (no session at boot).
        ok("aucune session active au démarrage (service)", sessionService.getActive() === null);

        console.log("── 2. Authentication ──");
        res = await anon.call("POST", "/api/auth/login", { username: "root", password: "mauvais" });
        ok("login mauvais mot de passe → 401 INVALID_CREDENTIALS", res.status === 401 && res.body.error.code === "INVALID_CREDENTIALS");
        res = await anon.call("POST", "/api/auth/login", { username: "root" });
        ok("login sans mot de passe → 400 VALIDATION_ERROR", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");

        res = await teacher.call("POST", "/api/auth/login", { username: "prof1", password: "prof1-pass-123" });
        ok("login teacher → 200, sans hash de mot de passe", res.status === 200 && res.body.data.user.password_hash === undefined);
        const setCookieHeader = await (async () => {
            const r = await fetch(`${base}/api/auth/login`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ username: "root", password: "root-pass-123" }),
            });
            return r.headers.get("set-cookie") ?? "";
        })();
        ok(
            "cookie HTTP-only posé (HttpOnly, SameSite=Lax)",
            /sid=.+HttpOnly/.test(setCookieHeader) && /SameSite=Lax/.test(setCookieHeader),
        );
        admin.cookie = setCookieHeader.split(";")[0];

        res = await admin.call("GET", "/api/auth/me");
        ok("GET /api/auth/me → utilisateur admin", res.status === 200 && res.body.data.user.username === "root");

        console.log("── 3. Roles ──");
        res = await teacher.call("GET", "/api/users");
        ok("GET /api/users avec teacher → 403 FORBIDDEN", res.status === 403 && res.body.error.code === "FORBIDDEN");
        res = await admin.call("GET", "/api/users");
        ok("GET /api/users avec admin → 200 (2 comptes)", res.status === 200 && res.body.meta.total === 2);
        res = await admin.call("POST", "/api/users", { username: "prof2", password: "prof2-pass-123", role: "teacher" });
        ok("POST /api/users (admin) → 201", res.status === 201);
        res = await admin.call("POST", "/api/users", { username: "root", password: "encore-123456", role: "teacher" });
        ok("username en double → 409 USERNAME_TAKEN", res.status === 409 && res.body.error.code === "USERNAME_TAKEN");
        res = await admin.call("POST", "/api/users", { username: "x!", password: "12345678", role: "teacher" });
        ok("username invalide → 400", res.status === 400);
        res = await admin.call("POST", "/api/users", { username: "shorty", password: "court", role: "teacher" });
        ok("mot de passe trop court → 400", res.status === 400);

        console.log("── 4. Groups ──");
        res = await teacher.call("POST", "/api/groups", { name: "G1" });
        ok("POST /api/groups → 201", res.status === 201 && res.body.data.name === "G1");
        res = await teacher.call("POST", "/api/groups", { name: "G1" });
        ok("groupe dupliqué → 409 GROUP_NAME_TAKEN", res.status === 409 && res.body.error.code === "GROUP_NAME_TAKEN");
        const g1 = res.status === 409 ? (await teacher.call("GET", "/api/groups")).body.data.find((g: any) => g.name === "G1") : res.body.data;
        res = await teacher.call("PATCH", `/api/groups/${g1.id}`, { name: "G1-bis" });
        ok("PATCH groupe → renommé", res.status === 200 && res.body.data.name === "G1-bis");
        res = await teacher.call("POST", "/api/groups", { name: "" });
        ok("groupe sans nom → 400", res.status === 400);

        console.log("── 5. Students ──");
        res = await teacher.call("POST", "/api/students", { firstName: "Ada", lastName: "Lovelace", groupId: g1.id, email: "ada@ex.io" });
        ok("POST /api/students → 201", res.status === 201 && res.body.data.first_name === "Ada");
        const ada = res.body.data;
        res = await teacher.call("POST", "/api/students", { lastName: "SansPrénom" });
        ok("student sans firstName → 400", res.status === 400);
        res = await teacher.call("POST", "/api/students", { firstName: "X", groupId: 987654 });
        ok("groupe inexistant → 400 VALIDATION_ERROR", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
        res = await teacher.call("POST", "/api/students", { firstName: "Alan", studentNumber: "S-001" });
        const alan = res.body.data;
        res = await teacher.call("POST", "/api/students", { firstName: "Autre", studentNumber: "S-001" });
        ok("student_number dupliqué → 409 STUDENT_NUMBER_TAKEN", res.status === 409 && res.body.error.code === "STUDENT_NUMBER_TAKEN");
        res = await teacher.call("PATCH", `/api/students/${ada.id}`, { lastName: null });
        ok("PATCH null efface last_name", res.status === 200 && res.body.data.last_name === null);
        res = await teacher.call("GET", `/api/students/${ada.id}`);
        ok("GET /api/students/:id → 200", res.status === 200 && res.body.data.id === ada.id);
        res = await teacher.call("DELETE", "/api/students/999999");
        ok("DELETE étudiant inconnu → 404", res.status === 404);
        res = await teacher.call("GET", "/api/students/by-card/12345");
        ok("by-card sans carte → 404", res.status === 404);
        res = await teacher.call("GET", "/api/students/abc");
        ok("id non numérique → 400", res.status === 400);

        console.log("── 6. Cards ──");
        res = await teacher.call("POST", "/api/cards", { uid: "5000001" });
        ok("POST /api/cards (enregistrement) → 201", res.status === 201 && res.body.data.uid === "5000001" && res.body.data.student === null);
        res = await teacher.call("POST", "/api/cards", { uid: "5000001" });
        ok("UID dupliqué → 409 UID_ALREADY_REGISTERED", res.status === 409 && res.body.error.code === "UID_ALREADY_REGISTERED");
        res = await teacher.call("POST", "/api/cards", { uid: "ABC" });
        ok("UID non décimal → 400", res.status === 400);
        res = await teacher.call("POST", `/api/students/${ada.id}/card`, { uid: "5000001" });
        ok("attribution carte → 200 (étudiant joint)", res.status === 200 && res.body.data.student?.id === ada.id);
        res = await teacher.call("GET", "/api/cards/5000001");
        ok("GET /api/cards/:uid → porteur trouvé", res.status === 200 && res.body.data.student?.id === ada.id);
        res = await teacher.call("POST", `/api/students/${alan.id}/card`, { uid: "5000001" });
        ok("carte déjà attribuée (autre étudiant) → 409 CARD_ALREADY_ASSIGNED", res.status === 409 && res.body.error.code === "CARD_ALREADY_ASSIGNED");
        res = await teacher.call("POST", `/api/students/${ada.id}/card`, { uid: "5000002" });
        ok("remplacement de carte → 200", res.status === 200 && res.body.data.uid === "5000002");
        res = await teacher.call("GET", `/api/students/${ada.id}/cards`);
        const adaCards = res.body.data as any[];
        ok(
            "historique cartes : ancienne retirée, historique conservé",
            adaCards.length === 2 && adaCards.find((c) => c.uid === "5000001")?.revoked_at !== null,
        );
        res = await teacher.call("GET", "/api/students/by-card/5000002");
        ok("by-card retrouve l'étudiant", res.status === 200 && res.body.data.id === ada.id);
        res = await teacher.call("POST", "/api/cards/5000002/revoke");
        ok("POST /api/cards/:uid/revoke → retirée", res.status === 200 && res.body.data.revoked_at !== null);
        res = await teacher.call("POST", "/api/cards/5000002/revoke");
        ok("retrait double → 409 CARD_ALREADY_REVOKED", res.status === 409 && res.body.error.code === "CARD_ALREADY_REVOKED");
        // reassignment for the rest of the suite (nominal scan)
        await teacher.call("POST", `/api/students/${ada.id}/card`, { uid: "5000002" });

        console.log("── 7. Sessions: lifecycle ──");
        res = await teacher.call("POST", "/api/sessions", { label: "Cours 1", groupId: g1.id });
        ok("POST /api/sessions → 201 scheduled", res.status === 201 && res.body.data.status === "scheduled");
        ok(
            "session créée avec groupId (compat) expose group_ids = [groupId]",
            Array.isArray(res.body.data.group_ids) &&
                res.body.data.group_ids.length === 1 &&
                res.body.data.group_ids[0] === g1.id,
        );
        const s1 = res.body.data;
        ok(
            "session HTTP porte son créateur (created_by + created_by_username)",
            s1.created_by === userRepository.findByUsername("prof1")!.id &&
                s1.created_by_username === "prof1",
        );
        res = await teacher.call("POST", `/api/sessions/${s1.id}/stop`);
        ok("stop d'une session scheduled → 409 SESSION_NOT_RUNNING", res.status === 409 && res.body.error.code === "SESSION_NOT_RUNNING");
        res = await teacher.call("POST", `/api/sessions/${s1.id}/start`);
        ok("start scheduled → running", res.status === 200 && res.body.data.status === "running" && res.body.data.started_at !== null);
        res = await teacher.call("GET", "/api/sessions/active");
        ok("GET /api/sessions/active → la session courante", res.status === 200 && res.body.data.id === s1.id);
        res = await teacher.call("POST", `/api/sessions/${s1.id}/start`);
        ok("start déjà active → 409 SESSION_ALREADY_RUNNING", res.status === 409 && res.body.error.code === "SESSION_ALREADY_RUNNING");
        res = await teacher.call("POST", "/api/sessions", { label: "Cours 2", groupId: g1.id });
        const s2 = res.body.data;
        res = await teacher.call("POST", `/api/sessions/${s2.id}/start`);
        ok("seconde session start refusée (mono-lecteur) → 409 SESSION_ANOTHER_RUNNING", res.status === 409 && res.body.error.code === "SESSION_ANOTHER_RUNNING");
        res = await teacher.call("POST", `/api/sessions/${s1.id}/cancel`);
        ok("annulation pendant running → cancelled", res.status === 200 && res.body.data.status === "cancelled");
        res = await teacher.call("POST", `/api/sessions/${s1.id}/start`);
        ok("re-démarrage cancelled → 409 SESSION_INVALID_TRANSITION", res.status === 409 && res.body.error.code === "SESSION_INVALID_TRANSITION");
        res = await teacher.call("POST", `/api/sessions/${s1.id}/cancel`);
        ok("annulation d'une cancelled → 409", res.status === 409);

        // Multi-group sessions (class shared between several classes):
        // "groupIds" (array) is the current form.
        res = await teacher.call("POST", "/api/groups", { name: "G-multi" });
        const gMulti = res.body.data;
        res = await teacher.call("POST", "/api/sessions", { label: "Cours commun", groupIds: [g1.id, gMulti.id] });
        const sMulti = res.body.data;
        ok(
            "POST groupIds [a,b] → 201 et group_ids reprend les deux groupes",
            res.status === 201 &&
                Array.isArray(sMulti.group_ids) &&
                sMulti.group_ids.length === 2 &&
                sMulti.group_ids.includes(g1.id) &&
                sMulti.group_ids.includes(gMulti.id),
        );
        res = await teacher.call("GET", `/api/sessions/${sMulti.id}`);
        ok("GET /api/sessions/:id → group_ids persistés", res.status === 200 && res.body.data.group_ids.length === 2);
        res = await teacher.call("GET", "/api/sessions");
        ok(
            "liste des sessions : chaque ligne porte group_ids",
            res.status === 200 && (res.body.data as any[]).every((s) => Array.isArray(s.group_ids)),
        );
        res = await teacher.call("POST", "/api/sessions", { label: "Groupe inconnu", groupIds: [987654] });
        ok("groupIds avec groupe inexistant → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
        res = await teacher.call("POST", "/api/sessions", { label: "Duo", groupId: g1.id, groupIds: [g1.id] });
        ok("groupId + groupIds ensemble → 400 (choisir une forme)", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
        res = await teacher.call("POST", "/api/sessions", { label: "Pas un tableau", groupIds: String(g1.id) });
        ok("groupIds non tableau → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
        res = await teacher.call("POST", "/api/sessions", { label: "Non entier", groupIds: [1.5] });
        ok("groupIds non entier → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
        res = await teacher.call("POST", "/api/sessions", { label: "Négatif", groupIds: [0] });
        ok("groupIds < 1 → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
        res = await teacher.call("POST", "/api/sessions", { label: "Sans groupe" });
        ok("session sans groupe → 400 (au moins un groupe requis)", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
        res = await teacher.call("POST", "/api/sessions", { label: "Groupes vide", groupIds: [] });
        ok("groupIds vide → 400 (au moins un groupe requis)", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");

        console.log("── 8. Attendance and scans ──");
        res = await teacher.call("POST", "/api/sessions", { label: "Appel RFID", groupId: g1.id });
        const sr = res.body.data;
        await teacher.call("POST", `/api/sessions/${sr.id}/start`);

        // Scans via the service (the reader is simulated; the RFID loop calls
        // exactly this same function).
        const unknown = attendanceService.handleScan("7777777");
        ok("scan carte inconnue → result unknown", unknown.result === "unknown");
        const first = attendanceService.handleScan("5000002");
        ok("scan valide → accepted", first.result === "accepted" && first.studentId === ada.id);
        const second = attendanceService.handleScan("5000002");
        ok("second scan → duplicate", second.result === "duplicate");
        res = await teacher.call("GET", `/api/sessions/${sr.id}/attendance`);
        ok("état de présence : 1 seule ligne (pas de doublon d'état)", res.status === 200 && res.body.data.length === 1);
        res = await teacher.call("GET", `/api/sessions/${sr.id}/scans`);
        const scanRows = res.body.data as any[];
        ok(
            "historique scan : 3 événements (unknown, accepted, duplicate) conservés",
            scanRows.length === 3 && scanRows.map((r) => r.result).join(",") === "unknown,accepted,duplicate",
        );
        // revoked card → expired
        await teacher.call("POST", "/api/cards/5000002/revoke");
        const expired = attendanceService.handleScan("5000002");
        ok("scan carte retirée → expired", expired.result === "expired");
        res = await teacher.call("GET", `/api/sessions/${sr.id}/attendance`);
        ok("scan expired n'a pas créé d'état de présence", (res.body.data as any[]).length === 1);

        // Student outside the session's group scope (Phase 10):
        // scan journaled as "out_of_group", presence NOT counted.
        res = await teacher.call("POST", "/api/groups", { name: "G-hors-session" });
        const gHors = res.body.data;
        res = await teacher.call("POST", "/api/students", { firstName: "Hors", lastName: "Groupe", groupId: gHors.id });
        const bob = res.body.data;
        await teacher.call("POST", `/api/students/${bob.id}/card`, { uid: "5000003" });
        const outOfGroup = attendanceService.handleScan("5000003");
        ok(
            "scan étudiant hors des groupes de la session → out_of_group",
            outOfGroup.result === "out_of_group" && outOfGroup.studentId === bob.id,
        );
        res = await teacher.call("GET", `/api/sessions/${sr.id}/attendance`);
        ok("scan out_of_group n'a pas créé d'état de présence", (res.body.data as any[]).length === 1);
        res = await teacher.call("GET", `/api/sessions/${sr.id}/scans`);
        const scansWithOut = res.body.data as any[];
        ok(
            "scan out_of_group journalisé dans l'historique",
            scansWithOut.length === 5 && scansWithOut[scansWithOut.length - 1].result === "out_of_group",
        );

        // Manual marking of a presence (teacher correction, running session):
        // state set, "manual" event journaled without a card.
        res = await teacher.call("POST", `/api/sessions/${sr.id}/attendance/manual`, { studentId: alan.id });
        ok(
            "marquage manuel → 200 (résultat manual, sans carte)",
            res.status === 200 && res.body.data.result === "manual" && res.body.data.studentId === alan.id,
        );
        res = await teacher.call("GET", `/api/sessions/${sr.id}/attendance`);
        ok(
            "marquage manuel : état de présence posé",
            (res.body.data as any[]).length === 2 && (res.body.data as any[]).some((r) => r.student_id === alan.id),
        );
        res = await teacher.call("POST", `/api/sessions/${sr.id}/attendance/manual`, { studentId: alan.id });
        ok("marquage manuel d'un déjà-présent → 409 ALREADY_PRESENT", res.status === 409 && res.body.error.code === "ALREADY_PRESENT");
        res = await teacher.call("POST", `/api/sessions/${sr.id}/attendance/manual`, { studentId: 999999 });
        ok("marquage manuel étudiant inconnu → 404", res.status === 404 && res.body.error.code === "NOT_FOUND");
        res = await teacher.call("POST", `/api/sessions/${sr.id}/attendance/manual`, {});
        ok("marquage manuel sans studentId → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
        res = await teacher.call("POST", `/api/sessions/${sr.id}/attendance/manual`, { studentId: alan.id, extra: 1 });
        ok("marquage manuel champ inconnu → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
        res = await teacher.call("GET", `/api/sessions/${sr.id}/scans`);
        const scansWithManual = res.body.data as any[];
        ok(
            "marquage manuel journalisé (résultat manual, uid NULL)",
            scansWithManual.length === 6 &&
                scansWithManual[scansWithManual.length - 1].result === "manual" &&
                scansWithManual[scansWithManual.length - 1].uid === null,
        );

        res = await teacher.call("POST", `/api/sessions/${sr.id}/attendance/reset`);
        ok("reset présence → 204", res.status === 204);
        res = await teacher.call("GET", `/api/sessions/${sr.id}/attendance`);
        const afterReset = res.body.data as any[];
        res = await teacher.call("GET", `/api/sessions/${sr.id}/scans`);
        const scansAfterReset = res.body.data as any[];
        ok("reset : état vidé, historique de scan intact", afterReset.length === 0 && scansAfterReset.length === 6);

        res = await teacher.call("POST", `/api/sessions/${sr.id}/stop`);
        ok("stop running → completed", res.status === 200 && res.body.data.status === "completed" && res.body.data.ended_at !== null);
        res = await teacher.call("POST", `/api/sessions/${sr.id}/stop`);
        ok("stop d'une completed → 409", res.status === 409 && res.body.error.code === "SESSION_NOT_RUNNING");
        res = await teacher.call("POST", `/api/sessions/${sr.id}/attendance/manual`, { studentId: bob.id });
        ok(
            "marquage manuel sur session arrêtée → 409 SESSION_NOT_RUNNING",
            res.status === 409 && res.body.error.code === "SESSION_NOT_RUNNING",
        );
        res = await teacher.call("POST", `/api/sessions/${sr.id}/start`);
        ok("re-démarrage completed → 409 SESSION_INVALID_TRANSITION", res.status === 409);
        res = await teacher.call("POST", "/api/sessions", { label: "Mauvais champ", extra: 1 });
        ok("champ inconnu → 400", res.status === 400);
        res = await teacher.call("POST", "/api/sessions", { label: "Date", scheduledAt: "pas-une-date" });
        ok("scheduledAt invalide → 400", res.status === 400);

        console.log("── 9. Reader (simulated offline) ──");
        res = await teacher.call("GET", "/api/reader/status");
        ok("GET /api/reader/status → online:false (pas de crash)", res.status === 200 && res.body.data.online === false && res.body.data.scanRunning === false);
        res = await teacher.call("POST", "/api/reader/beep");
        ok("beep lecteur hors ligne → 503 READER_OFFLINE", res.status === 503 && res.body.error.code === "READER_OFFLINE");
        res = await teacher.call("POST", "/api/reader/next-card");
        ok("next-card reader offline → 503 READER_OFFLINE", res.status === 503 && res.body.error.code === "READER_OFFLINE");
        res = await teacher.call("POST", "/api/sessions", { label: "Sans lecteur", groupId: g1.id });
        const sNoReader = res.body.data;
        res = await teacher.call("POST", `/api/sessions/${sNoReader.id}/start`);
        ok("démarrage de session sans lecteur → OK (boucle attend)", res.status === 200 && res.body.data.status === "running");
        res = await teacher.call("POST", "/api/reader/next-card");
        ok("next-card while scan loop runs → 409 READER_BUSY", res.status === 409 && res.body.error.code === "READER_BUSY");
        await teacher.call("POST", `/api/sessions/${sNoReader.id}/stop`);

        console.log("── 10. Error formats and end of life ──");
        res = await teacher.call("GET", "/api/inexistant");
        ok("route API inconnue → 404 NOT_FOUND structuré", res.status === 404 && res.body.error.code === "NOT_FOUND");
        res = await teacher.call("POST", "/api/groups", "pas-json" as never);
        ok("corps non-objet → 400", res.status === 400);
        const badJson = await fetch(`${base}/api/groups`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
        const badJsonBody: any = await badJson.json();
        ok("JSON illégal → 400 INVALID_JSON sans stack", badJson.status === 400 && badJsonBody.error.code === "INVALID_JSON" && !JSON.stringify(badJsonBody).includes("at "));
        const noStack = await fetch(`${base}/api/students/999999`, { headers: { cookie: teacher.cookie! } });
        const noStackBody: any = await noStack.json();
        ok("404 sans détail interne", !JSON.stringify(noStackBody).includes("SQLITE"));

        console.log("── 11. WebSocket (protocol + authentication) ──");
        if (typeof wsPort === "number") {
            const { WebSocket } = await import("ws");
            type WsClient = import("ws").WebSocket;
            const { WS_CLOSE_INVALID_SESSION } = await import("../websocket/hub");
            const standaloneUrl = `ws://127.0.0.1:${wsPort}/`; // path ignored there
            const mountedUrl = `ws://127.0.0.1:${httpPort}/ws`;

            // Successful connection: resolves with the first message (the
            // « status » snapshot); rejects if the handshake is refused.
            const wsConnected = (url: string, cookie?: string): Promise<{ ws: WsClient; first: any }> =>
                new Promise((resolve, reject) => {
                    const ws = new WebSocket(url, cookie ? { headers: { cookie } } : undefined);
                    ws.once("message", (m: Buffer) => resolve({ ws, first: JSON.parse(m.toString()) }));
                    ws.once("error", (err: Error) => reject(err));
                    setTimeout(() => reject(new Error(`timeout snapshot WS (${url})`)), 3000);
                });

            // Refused connection: ws must answer HTTP 401 before the upgrade
            // (the client surfaces it as an « Unexpected server response »).
            const wsRejected401 = async (url: string, cookie?: string): Promise<boolean> => {
                const ws = new WebSocket(url, cookie ? { headers: { cookie } } : undefined);
                try {
                    await new Promise<void>((resolve, reject) => {
                        ws.once("open", () => reject(new Error("connexion WS acceptée alors qu'elle devait être refusée")));
                        ws.once("error", (err: Error) => {
                            if (err.message.includes("401")) resolve();
                            else reject(new Error(`rejet inattendu : ${err.message}`));
                        });
                        setTimeout(() => reject(new Error(`timeout rejet WS (${url})`)), 3000);
                    });
                    return true;
                } finally {
                    ws.terminate();
                }
            };

            const wsCloseCode = (ws: WsClient): Promise<number> =>
                new Promise((resolve, reject) => {
                    ws.once("close", (code: number) => resolve(code));
                    setTimeout(() => reject(new Error("timeout fermeture WS")), 3000);
                });

            // The protocol is unchanged — it just requires an authenticated
            // handshake (same « sid » cookie as the HTTP API).
            const { ws, first: firstMessage } = await wsConnected(standaloneUrl, teacher.cookie);
            ok("snapshot « status » reçu à la connexion", firstMessage.event === "status" && firstMessage.content.readerOnline === false);

            // new session + scan → attendance:scanned event
            const { sessionRepository } = await import("../db");
            const wsSession = sessionRepository.create({ label: "Session WS", scheduledAt: new Date().toISOString() });
            sessionService.start(wsSession.id);
            const scanEvent = await new Promise<any>((resolve, reject) => {
                ws.on("message", (m: Buffer) => {
                    const msg = JSON.parse(m.toString());
                    if (msg.event === "attendance:scanned") resolve(msg);
                });
                setTimeout(() => reject(new Error("timeout attendance:scanned")), 3000);
                attendanceService.handleScan("1234567");
            });
            ok("événement attendance:scanned diffusé (unknown)", scanEvent.event === "attendance:scanned" && scanEvent.content.result === "unknown");

            // Phase 6 (kiosk): an admin attendance reset must be broadcast so
            // live clients resync their counters from the server.
            const resetEventPromise = new Promise<any>((resolve, reject) => {
                const onMsg = (m: Buffer): void => {
                    const msg = JSON.parse(m.toString());
                    if (msg.event === "attendance:reset") {
                        ws.off("message", onMsg);
                        resolve(msg);
                    }
                };
                ws.on("message", onMsg);
                setTimeout(() => reject(new Error("timeout attendance:reset")), 3000);
            });
            const resetRes = await teacher.call("POST", `/api/sessions/${wsSession.id}/attendance/reset`);
            const resetEvent = await resetEventPromise;
            ok(
                "attendance:reset broadcast on reset (kiosk sync)",
                resetRes.status === 204 && resetEvent.event === "attendance:reset" && resetEvent.content.sessionId === wsSession.id,
            );

            sessionService.stop(wsSession.id);
            ws.close();

            // Hub also reachable same-origin on the HTTP port (React client path).
            const { ws: wsViaHttp, first: httpSnapshot } = await wsConnected(mountedUrl, teacher.cookie);
            ok("WS mounted on HTTP port at /ws → status snapshot", httpSnapshot.event === "status");
            wsViaHttp.close();

            // ── WS authentication (sid cookie checked during the handshake) ──
            const authService = await import("../services/authService");
            const { revalidateConnectedClients } = await import("../websocket/server");

            // Dedicated account for the WS lifecycle checks (the suite's own
            // sessions stay untouched).
            res = await admin.call("POST", "/api/users", { username: "wsuser", password: "wsuser-pass-123", role: "teacher" });
            ok("compte dédié WS créé → 201", res.status === 201);
            const wsu = new Client(base);
            res = await wsu.call("POST", "/api/auth/login", { username: "wsuser", password: "wsuser-pass-123" });
            ok("login dédié WS (wsuser) → 200", res.status === 200);

            ok("WS sans cookie refusé (standalone, HTTP 401)", await wsRejected401(standaloneUrl));
            ok("WS sans cookie refusé (/ws, HTTP 401)", await wsRejected401(mountedUrl));
            ok("WS cookie invalide refusé (/ws, HTTP 401)", await wsRejected401(mountedUrl, "sid=00000000invalide"));

            // Cookie that was valid but whose session has expired: rejected on
            // both transports (TTL simulated via authService.expireSession).
            const expLogin = await fetch(`${base}/api/auth/login`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ username: "wsuser", password: "wsuser-pass-123" }),
            });
            const expToken = /sid=([^;]+)/.exec(expLogin.headers.get("set-cookie") ?? "")?.[1] ?? "";
            ok("expiration simulée de la session (TTL)", authService.expireSession(expToken));
            ok("WS cookie expiré refusé (standalone, HTTP 401)", await wsRejected401(standaloneUrl, `sid=${expToken}`));
            ok("WS cookie expiré refusé (/ws, HTTP 401)", await wsRejected401(mountedUrl, `sid=${expToken}`));

            // Logout while connected → the live connection is closed (1008).
            await wsu.call("POST", "/api/auth/login", { username: "wsuser", password: "wsuser-pass-123" });
            {
                const { ws: liveLogout } = await wsConnected(standaloneUrl, wsu.cookie);
                const closing = wsCloseCode(liveLogout);
                await wsu.call("POST", "/api/auth/logout");
                ok("logout → connexion WS fermée immédiatement (1008)", (await closing) === WS_CLOSE_INVALID_SESSION);
            }

            // Admin resets the user's password (destroys their sessions) → same.
            await wsu.call("POST", "/api/auth/login", { username: "wsuser", password: "wsuser-pass-123" });
            {
                const { ws: liveReset } = await wsConnected(mountedUrl, wsu.cookie);
                const closing = wsCloseCode(liveReset);
                const wsuRow = userRepository.findByUsername("wsuser")!;
                res = await admin.call("PATCH", `/api/users/${wsuRow.id}`, { password: "wsuser-nouveau-123" });
                ok(
                    "réinitialisation du mot de passe → connexion WS fermée (1008)",
                    res.status === 200 && (await closing) === WS_CLOSE_INVALID_SESSION,
                );
            }

            // Session expiring while connected → the revalidation sweep closes
            // it (same as what the server's 60 s timer does).
            await wsu.call("POST", "/api/auth/login", { username: "wsuser", password: "wsuser-nouveau-123" });
            {
                const liveToken = (wsu.cookie ?? "").slice("sid=".length);
                const { ws: liveExp } = await wsConnected(mountedUrl, wsu.cookie);
                ok("expiration TTL simulée sur la session connectée", authService.expireSession(liveToken));
                const closing = wsCloseCode(liveExp);
                revalidateConnectedClients();
                ok("session expirée → connexion WS fermée par la revalidation (1008)", (await closing) === WS_CLOSE_INVALID_SESSION);
            }
        } else {
            console.log("  (WS port unresolved — WS verification skipped)");
        }

        console.log("── 12. Password and session end ──");
        const prof1 = userRepository.findByUsername("prof1")!;
        res = await admin.call("PATCH", `/api/users/${prof1.id}`, { password: "nouveau-pass-123" });
        ok("PATCH password (admin) → 200", res.status === 200);
        const userRow = userRepository.findByUsername("prof1");
        ok("nouveau hash stocké et vérifiable", await verifyPassword("nouveau-pass-123", userRow!.password_hash));
        ok("ancien mot de passe refusé", !(await verifyPassword("prof1-pass-123", userRow!.password_hash)));

        res = await teacher.call("POST", "/api/auth/logout");
        ok("POST /api/auth/logout → 204", res.status === 204);
        res = await teacher.call("GET", "/api/auth/me");
        ok("cookie invalidé après logout → 401", res.status === 401);
        res = await teacher.call("POST", "/api/auth/login", { username: "prof1", password: "prof1-pass-123" });
        ok("ancien mot de passe refusé au login aussi", res.status === 401);

        console.log("── 13. Account management (Phase 5) ──");
        res = await anon.call("GET", "/api/users");
        ok("GET /api/users sans session → 401", res.status === 401 && res.body.error.code === "NOT_AUTHENTICATED");

        const boss = new Client(base);
        res = await boss.call("POST", "/api/auth/login", { username: "prof2", password: "prof2-pass-123" });
        ok("nouveau login teacher (prof2) → 200", res.status === 200);
        res = await boss.call("GET", "/api/users");
        ok("teacher GET /api/users → 403 FORBIDDEN", res.status === 403 && res.body.error.code === "FORBIDDEN");
        const prof2row = userRepository.findByUsername("prof2")!;
        res = await boss.call("PATCH", `/api/users/${prof2row.id}`, { role: "admin" });
        ok("teacher PATCH rôle → 403", res.status === 403 && res.body.error.code === "FORBIDDEN");
        res = await boss.call("PATCH", `/api/users/${prof2row.id}`, { password: "quelque-chose-123" });
        ok("teacher PATCH mot de passe → 403", res.status === 403);

        res = await admin.call("POST", "/api/users", { username: "boss1", password: "boss1-pass-123", role: "admin" });
        ok("admin crée un admin → 201 (rôle admin)", res.status === 201 && res.body.data.role === "admin");
        const boss1 = userRepository.findByUsername("boss1")!;
        ok(
            "mot de passe stocké en hash scrypt, jamais en clair",
            boss1.password_hash.startsWith("scrypt$") && !boss1.password_hash.includes("boss1-pass-123"),
        );
        res = await admin.call("GET", "/api/users");
        const userRows = res.body.data as any[];
        ok(
            "liste : jamais de password_hash, métadonnées présentes",
            res.status === 200 &&
                userRows.every((u) => u.password_hash === undefined && typeof u.created_at === "string" && typeof u.updated_at === "string"),
        );
        res = await admin.call("POST", "/api/users", { username: "extra", password: "12345678", role: "teacher", extra: 1 });
        ok("champ inconnu dans le corps → 400", res.status === 400);
        res = await admin.call("PATCH", "/api/users/999999", { role: "teacher" });
        ok("PATCH utilisateur inconnu → 404", res.status === 404 && res.body.error.code === "NOT_FOUND");
        res = await admin.call("PATCH", `/api/users/${boss1.id}`, { role: "root" });
        ok("rôle invalide → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
        res = await admin.call("PATCH", `/api/users/${boss1.id}`, { password: "court" });
        ok("mot de passe de réinitialisation trop court → 400", res.status === 400);

        res = await admin.call("PATCH", `/api/users/${boss1.id}`, { role: "teacher" });
        ok("admin change le rôle admin→teacher → 200", res.status === 200 && res.body.data.role === "teacher");
        res = await admin.call("PATCH", `/api/users/${boss1.id}`, { role: "admin" });
        ok("admin re-promeut teacher→admin → 200", res.status === 200 && res.body.data.role === "admin");

        // Anti self-lockout: an admin cannot demote themselves.
        const rootRow = userRepository.findByUsername("root")!;
        res = await admin.call("PATCH", `/api/users/${rootRow.id}`, { role: "teacher" });
        ok("auto-rétrogradation refusée → 409 SELF_ROLE_CHANGE", res.status === 409 && res.body.error.code === "SELF_ROLE_CHANGE");
        res = await admin.call("PATCH", `/api/users/${rootRow.id}`, { role: "admin" });
        ok("PATCH même rôle sur soi (aucun effet) → 200", res.status === 200);

        // Role changes apply immediately to ongoing sessions
        // (the user is reloaded on every request).
        const boss1c = new Client(base);
        res = await boss1c.call("POST", "/api/auth/login", { username: "boss1", password: "boss1-pass-123" });
        ok("nouveau login admin (boss1) → 200", res.status === 200);
        res = await boss1c.call("GET", "/api/users");
        ok("boss1 admin : GET /api/users → 200", res.status === 200);
        await admin.call("PATCH", `/api/users/${boss1.id}`, { role: "teacher" });
        res = await boss1c.call("GET", "/api/users");
        ok("admin rétrogradé : cookie actif perd les droits admin immédiatement", res.status === 403);

        // Reset by an admin = the target's sessions are invalidated.
        res = await admin.call("PATCH", `/api/users/${boss1.id}`, { password: "boss1-nouveau-123" });
        ok("admin réinitialise le mot de passe d'un autre → 200", res.status === 200);
        res = await boss1c.call("GET", "/api/auth/me");
        ok("session en cours de la cible invalidée → 401", res.status === 401);
        res = await boss1c.call("POST", "/api/auth/login", { username: "boss1", password: "boss1-pass-123" });
        ok("ancien mot de passe refusé après réinitialisation", res.status === 401);
        res = await boss1c.call("POST", "/api/auth/login", { username: "boss1", password: "boss1-nouveau-123" });
        ok("nouveau mot de passe accepté après réinitialisation", res.status === 200);

        // An admin resetting their own password keeps their own session.
        res = await admin.call("PATCH", `/api/users/${rootRow.id}`, { password: "root-pass-456" });
        ok("admin réinitialise son propre mot de passe → 200", res.status === 200);
        res = await admin.call("GET", "/api/auth/me");
        ok("session de l'admin préservée après sa propre réinitialisation", res.status === 200);
        res = await admin.call("PATCH", `/api/users/${rootRow.id}`, { password: "root-pass-123" });
        ok("mot de passe racine restauré (état de la suite)", res.status === 200);
        res = await anon.call("POST", "/api/auth/login", { username: "root", password: "root-pass-123" });
        ok("mot de passe racine d'origine de nouveau valide", res.status === 200);

        console.log("── 14. Reports and CSV export (Phase 7) ──");
        // The teacher client logged out in section 12: reconnect (prof1's
        // password was reset there) — reports must work for both roles.
        res = await teacher.call("POST", "/api/auth/login", { username: "prof1", password: "nouveau-pass-123" });
        ok("reconnexion teacher (mot de passe réinitialisé) → 200", res.status === 200);
        const nobody = new Client(base); // "anon" has been logged in as admin since section 13
        res = await nobody.call("GET", "/api/reports/sessions");
        ok("GET /api/reports/sessions sans session → 401", res.status === 401 && res.body.error.code === "NOT_AUTHENTICATED");
        res = await teacher.call("GET", "/api/reports/sessions");
        ok("rapports accessibles au teacher → 200", res.status === 200 && Array.isArray(res.body.data));
        res = await admin.call("GET", "/api/reports/sessions?from=non");
        ok("filtre from invalide → 400 VALIDATION_ERROR", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
        res = await admin.call("GET", "/api/reports/sessions?status=inexistant");
        ok("filtre statut invalide → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
        res = await admin.call("GET", "/api/reports/sessions?from=2026-05-06&to=2026-05-01");
        ok("plage de dates inversée → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
        res = await admin.call("GET", "/api/reports/sessions?groupId=abc");
        ok("groupId non entier → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");

        // Deterministic report scenario: one group, three students (one with
        // a comma/accented name), two cards; two scans of the same card
        // (duplicate — must NOT add attendance) and one unknown card.
        res = await teacher.call("POST", "/api/groups", { name: "G-REPORT" });
        const rg = res.body.data;
        res = await teacher.call("POST", "/api/students", { firstName: "Élodie", lastName: "Truchon, Anne", groupId: rg.id, studentNumber: "RPT-1" });
        const elodie = res.body.data;
        res = await teacher.call("POST", "/api/students", { firstName: "Jean", lastName: "Dupont", groupId: rg.id, studentNumber: "RPT-2" });
        const jean = res.body.data;
        await teacher.call("POST", "/api/students", { firstName: "Nadia", lastName: "Belkacem", groupId: rg.id, studentNumber: "RPT-3" });
        await teacher.call("POST", `/api/students/${elodie.id}/card`, { uid: "6100001" });
        await teacher.call("POST", `/api/students/${jean.id}/card`, { uid: "6100002" });
        res = await teacher.call("POST", "/api/sessions", { label: "Session rapport", groupId: rg.id });
        const sReport = res.body.data;
        await teacher.call("POST", `/api/sessions/${sReport.id}/start`);
        attendanceService.handleScan("6100001");
        attendanceService.handleScan("6100001"); // duplicate
        attendanceService.handleScan("6100002");
        attendanceService.handleScan("6199999"); // unknown card (journal only)
        await teacher.call("POST", `/api/sessions/${sReport.id}/stop`);

        res = await teacher.call("GET", "/api/reports/sessions");
        ok(
            "ligne de rapport : created_by_username du créateur (prof1)",
            (res.body.data as any[]).find((r) => r.id === sReport.id)?.created_by_username === "prof1",
        );

        res = await teacher.call("GET", `/api/reports/sessions/${sReport.id}`);
        const report = res.body.data;
        ok(
            "rapport : 2 présents / 1 absent / 3 total (doublon ignoré)",
            res.status === 200 && report.summary.present === 2 && report.summary.absent === 1 && report.summary.total === 3,
        );
        const reportRows = report.rows as any[];
        ok(
            "rapport : lignes cohérente (présent ⇒ heure du 1er scan, absent ⇒ heure vide)",
            reportRows.length === 3 &&
                reportRows.every((r) => (r.status === "present" ? typeof r.first_scan_at === "string" : r.first_scan_at === null)),
        );
        ok(
            "rapport : numéro étudiant et groupe exposés",
            reportRows.every((r) => typeof r.student_number === "string" && r.group_name === "G-REPORT"),
        );
        const elodieRow = reportRows.find((r) => r.student_id === elodie.id);
        ok("rapport : l'heure affichée est le premier scan accepté (pas le doublon)", elodieRow?.status === "present");

        // Multi-group: the report covers the UNION of the groups' students.
        res = await teacher.call("POST", "/api/groups", { name: "G-REPORT2" });
        const rg2 = res.body.data;
        await teacher.call("POST", "/api/students", { firstName: "Kim", lastName: "Nguyen", groupId: rg2.id, studentNumber: "RPT-4" });
        res = await teacher.call("POST", "/api/sessions", { label: "Session deux groupes", groupIds: [rg.id, rg2.id] });
        const sTwoGroups = res.body.data;
        res = await teacher.call("GET", `/api/reports/sessions/${sTwoGroups.id}`);
        const report2 = res.body.data;
        ok(
            "rapport multi-groupes : roster = UNION des groupes (3 + 1 = 4), 0 présent",
            res.status === 200 && report2.summary.total === 4 && report2.summary.absent === 4 && report2.summary.present === 0,
        );
        ok(
            "rapport multi-groupes : noms de groupes joints dans group_name",
            typeof report2.group_name === "string" &&
                report2.group_name.includes("G-REPORT") &&
                report2.group_name.includes("G-REPORT2"),
        );
        ok(
            "rapport multi-groupes : l'étudiante du second groupe est listée",
            (report2.rows as any[]).some((r) => r.student_number === "RPT-4" && r.group_name === "G-REPORT2"),
        );
        res = await teacher.call("GET", `/api/reports/sessions?groupId=${rg2.id}`);
        ok(
            "filtre par groupe : session multi-groupes listée pour chacun de ses groupes",
            (res.body.data as any[]).some((s) => s.id === sTwoGroups.id),
        );

        res = await teacher.call("GET", `/api/reports/sessions?groupId=${rg.id}`);
        const listed = (res.body.data as any[]).find((s) => s.id === sReport.id);
        ok("liste filtrée par groupe : 2 présents / 4 scans journalisés", listed?.present_count === 2 && listed?.scan_count === 4);
        const today = new Date().toISOString().slice(0, 10);
        res = await teacher.call("GET", `/api/reports/sessions?from=${today}&to=${today}`);
        ok("filtre de dates (aujourd'hui) : la session est listée", (res.body.data as any[]).some((s) => s.id === sReport.id));
        res = await teacher.call("GET", "/api/reports/sessions?from=2000-01-01&to=2000-01-02");
        ok("filtre de dates hors plage : aucune session", res.status === 200 && (res.body.data as any[]).length === 0);
        res = await teacher.call("GET", "/api/reports/sessions?status=cancelled");
        ok("filtre statut annulé : uniquement des sessions annulées", res.status === 200 && (res.body.data as any[]).every((s) => s.status === "cancelled"));

        res = await teacher.call("POST", "/api/sessions", { label: "Annulée rapport", groupId: rg.id });
        const sCancelled = res.body.data;
        await teacher.call("POST", `/api/sessions/${sCancelled.id}/cancel`);
        res = await teacher.call("GET", `/api/reports/sessions/${sCancelled.id}`);
        ok("session annulée : rapport accessible avec statut cancelled", res.status === 200 && res.body.data.session.status === "cancelled");
        res = await teacher.call("GET", "/api/reports/sessions/999999");
        ok("rapport d'une session inconnue → 404", res.status === 404 && res.body.error.code === "NOT_FOUND");

        // CSV export: file response from authoritative server-side data.
        {
            const csvRes = await fetch(`${base}/api/reports/sessions/${sReport.id}/export`, {
                headers: { cookie: teacher.cookie! },
            });
            // Raw bytes: text() would silently strip the leading BOM.
            const csvBytes = new Uint8Array(await csvRes.arrayBuffer());
            const csvText = new TextDecoder("utf-8").decode(csvBytes);
            ok(
                "export CSV : 200, Content-Type texte/csv, pièce jointe nommée",
                csvRes.status === 200 &&
                    (csvRes.headers.get("content-type") ?? "").startsWith("text/csv") &&
                    /attachment; filename="presences-session-\d+\.csv"/.test(csvRes.headers.get("content-disposition") ?? ""),
            );
            ok(
                "export CSV : BOM UTF-8 en tête de fichier",
                csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf,
            );
            ok(
                "export CSV : en-têtes de colonnes stables",
                csvText.startsWith("Nom,Prénom,Numéro étudiant,Groupe,Présence,Heure du premier scan"),
            );
            ok("export CSV : noms accentués conservés (UTF-8)", csvText.includes("Élodie") && csvText.includes("Belkacem"));
            ok("export CSV : nom avec virgule échappé entre guillemets", csvText.includes('"Truchon, Anne"'));
            ok("export CSV : absent explicite (Absent(e), heure vide)", /Absent\(e\),\r\n$/.test(csvText));
            ok(
                "export CSV : 1 en-tête + 3 lignes, jamais de données internes",
                csvText.trim().split("\r\n").length === 4 && !csvText.includes("password") && !csvText.includes("6100001"),
            );
            const csvAnon = await fetch(`${base}/api/reports/sessions/${sReport.id}/export`);
            ok("export CSV sans session → 401 JSON (pas de fichier)", csvAnon.status === 401);
        }
        res = await teacher.call("GET", "/api/reports/sessions/999999/export");
        ok("export d'une session inconnue → 404", res.status === 404 && res.body.error.code === "NOT_FOUND");

        console.log("── 15. Kiosk account and automatic scheduler ──");
        // Kiosk account: read-only on the API, never management.
        res = await admin.call("POST", "/api/users", { username: "borne1", password: "borne-pass-123", role: "kiosk" });
        ok("admin crée un compte kiosk → 201 (rôle kiosk)", res.status === 201 && res.body.data.role === "kiosk");
        const borne = new Client(base);
        res = await borne.call("POST", "/api/auth/login", { username: "borne1", password: "borne-pass-123" });
        ok("login kiosk → 200 avec rôle exposé", res.status === 200 && res.body.data.user.role === "kiosk");
        res = await borne.call("GET", "/api/sessions");
        ok("kiosk GET /api/sessions → 200 (lecture autorisée)", res.status === 200);
        res = await borne.call("GET", "/api/reports/sessions");
        ok("kiosk GET /api/reports/sessions → 200 (lecture autorisée)", res.status === 200);
        res = await borne.call("GET", "/api/users");
        ok("kiosk GET /api/users → 403 (toujours réservé admin)", res.status === 403 && res.body.error.code === "FORBIDDEN");
        res = await borne.call("POST", "/api/sessions", { label: "Interdite", groupId: g1.id });
        ok("kiosk POST /api/sessions → 403 lecture seule", res.status === 403 && res.body.error.code === "FORBIDDEN");
        res = await borne.call("POST", "/api/reader/beep");
        ok("kiosk POST /api/reader/beep → 403 lecture seule", res.status === 403 && res.body.error.code === "FORBIDDEN");
        const borneRow = userRepository.findByUsername("borne1")!;
        res = await admin.call("PATCH", `/api/users/${borneRow.id}`, { role: "teacher" });
        ok("admin promeut un kiosk en teacher → 200", res.status === 200 && res.body.data.role === "teacher");
        res = await admin.call("PATCH", `/api/users/${borneRow.id}`, { role: "kiosk" });
        ok("admin rétrograde un teacher en kiosk → 200", res.status === 200 && res.body.data.role === "kiosk");

        // Scheduler: the exposed tick drives the same logic as the server's
        // timer (startSessionScheduler is not started here).
        const scheduler = await import("../services/schedulerService");
        const { sessionRepository: sessionsRepo } = await import("../db");
        const minsAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

        // First neutralize the sessions still "scheduled" left open by the
        // previous sections (no interference).
        for (const s of sessionService.list()) {
            if (s.status === "scheduled") await teacher.call("POST", `/api/sessions/${s.id}/cancel`);
        }

        res = await teacher.call("POST", "/api/sessions", { label: "Fenêtre passée", groupId: g1.id, scheduledAt: minsAgo(10), durationMinutes: 5 });
        const sPast = res.body.data;
        scheduler.runSchedulerTick();
        res = await teacher.call("GET", `/api/sessions/${sPast.id}`);
        ok("scheduler : fenêtre déjà écoulée → pas de démarrage (pas de rattrapage)", res.status === 200 && res.body.data.status === "scheduled");

        res = await teacher.call("POST", "/api/sessions", { label: "Dans la fenêtre", groupId: g1.id, scheduledAt: minsAgo(2), durationMinutes: 60 });
        const sLive = res.body.data;
        scheduler.runSchedulerTick();
        res = await teacher.call("GET", `/api/sessions/${sLive.id}`);
        ok("scheduler : fenêtre en cours → démarrage automatique", res.status === 200 && res.body.data.status === "running" && res.body.data.started_at !== null);

        res = await teacher.call("POST", "/api/sessions", { label: "En attente (mono-lecteur)", groupId: g1.id, scheduledAt: minsAgo(1), durationMinutes: 30 });
        const sWaiting = res.body.data;
        scheduler.runSchedulerTick();
        res = await teacher.call("GET", `/api/sessions/${sWaiting.id}`);
        ok("scheduler : pas de second démarrage pendant une running (mono-lecteur)", res.status === 200 && res.body.data.status === "scheduled");
        await teacher.call("POST", `/api/sessions/${sLive.id}/stop`);

        // Running session whose window has elapsed → automatic stop.
        res = await teacher.call("POST", "/api/sessions", { label: "Fin automatique", groupId: g1.id, scheduledAt: minsAgo(30), durationMinutes: 10 });
        const sAutoEnd = res.body.data;
        sessionsRepo.start(sAutoEnd.id); // manual start despite the past window (repository)
        scheduler.runSchedulerTick();
        res = await teacher.call("GET", `/api/sessions/${sAutoEnd.id}`);
        ok("scheduler : fenêtre écoulée pendant running → arrêt automatique (completed)", res.status === 200 && res.body.data.status === "completed" && res.body.data.ended_at !== null);

        console.log("── 16. Student CSV import ──");
        // Raw POST as text/csv (the file is sent as is, parsed server-side).
        const importCsv = async (body: string): Promise<ApiResponse> => {
            const r = await fetch(`${base}/api/students/import`, {
                method: "POST",
                headers: { "content-type": "text/csv", cookie: teacher.cookie! },
                body,
            });
            let parsed: any = null;
            const t = await r.text();
            if (t) {
                try {
                    parsed = JSON.parse(t);
                } catch {
                    /* empty response */
                }
            }
            return { status: r.status, body: parsed };
        };

        res = await importCsv("");
        ok("import CSV sans contenu → 400 VALIDATION_ERROR", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
        res = await importCsv("prénom,mail\nMarie,marie@ex.io");
        ok("import CSV sans colonne « nom » → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");

        // Active card held by another student ("card already assigned" case).
        await teacher.call("POST", `/api/students/${alan.id}/card`, { uid: "8000009" });

        res = await importCsv(
            "prénom,nom,groupe,email,id\n" +
                "Marie,Curie,G-IMP,marie@ex.io,8000001\n" +
                "Jean,,G1-bis,,\n" +
                "Georges,Dumont,,,8000009\n" +
                ",Dupont,,bad@\n" +
                "Zoe,Zolette,,,\n",
        );
        ok(
            "import CSV valide → 200 (2 importés, 3 ignorés, groupe G-IMP créé)",
            res.status === 200 &&
                res.body.data.imported === 2 &&
                res.body.data.skipped === 3 &&
                (res.body.data.groups_created as string[]).includes("G-IMP"),
        );
        ok(
            "import CSV : erreurs explicites (nom manquant, carte déjà attribuée)",
            (res.body.data.errors as any[]).some((e) => /Prénom et nom/.test(e.message)) &&
                (res.body.data.errors as any[]).some((e) => /déjà attribuée/.test(e.message)),
        );

        res = await teacher.call("GET", "/api/groups");
        const gImp = (res.body.data as any[]).find((g) => g.name === "G-IMP");
        ok("import CSV : le groupe inexistant a été créé", gImp !== undefined);
        res = await teacher.call("GET", "/api/students");
        const marie = (res.body.data as any[]).find((s) => s.first_name === "Marie" && s.last_name === "Curie");
        ok(
            "import CSV : étudiante créée avec groupe et e-mail",
            marie !== undefined && marie.group_id === gImp.id && marie.email === "marie@ex.io",
        );
        res = await teacher.call("GET", "/api/students/by-card/8000001");
        ok("import CSV : la carte « id » est attribuée à l'étudiante importée", res.status === 200 && res.body.data.id === marie.id);

        res = await importCsv("prénom,nom,id\nMauvais,Uid,ABC12X\n");
        ok(
            "import CSV : UID de carte non décimal → ligne ignorée",
            res.status === 200 &&
                res.body.data.imported === 0 &&
                res.body.data.skipped === 1 &&
                /UID/.test((res.body.data.errors as any[])[0].message),
        );

        // UTF-8 BOM + semicolon separator (French Excel export) + header case.
        res = await importCsv("\uFEFFPrénom;Nom;Groupe;Email;Id\nYves;Martin;G-IMP2;;8000002\n");
        ok(
            "import CSV : BOM + « ; » + en-tête en majuscules acceptés",
            res.status === 200 &&
                res.body.data.imported === 1 &&
                (res.body.data.groups_created as string[]).includes("G-IMP2"),
        );

        res = await importCsv("prénom,nom,id\nMarie,Curie,8000001\n");
        ok(
            "re-import de la même carte : ligne ignorée (déjà attribuée)",
            res.status === 200 && res.body.data.imported === 0 && res.body.data.skipped === 1,
        );
        const importAnon = await fetch(`${base}/api/students/import`, { method: "POST", headers: { "content-type": "text/csv" }, body: "prénom,nom\nA,B" });
        ok("import CSV sans session → 401", importAnon.status === 401);

        console.log("── 17. Rate limiting of POST /api/auth/login (anti-brute-force) ──");
        {
            const { resetLoginRateLimits, shiftLoginRateLimitClock } = await import("../api/middleware/loginRateLimit");
            const rateCfg = await import("../config/env");

            const loginRaw = async (
                body: unknown,
                headers?: Record<string, string>,
            ): Promise<{ status: number; body: any; retryAfter: string | null }> => {
                const r = await fetch(`${base}/api/auth/login`, {
                    method: "POST",
                    headers: { "content-type": "application/json", ...(headers ?? {}) },
                    body: JSON.stringify(body),
                });
                let parsed: any = null;
                const t = await r.text();
                if (t) {
                    try {
                        parsed = JSON.parse(t);
                    } catch {
                        /* empty response */
                    }
                }
                return { status: r.status, body: parsed, retryAfter: r.headers.get("retry-after") };
            };

            ok(
                "réglages par défaut du limiteur (10/IP, 5/utilisateur, 15 min, backoff 30 s)",
                rateCfg.LOGIN_FAIL_LIMIT_PER_IP === 10 &&
                    rateCfg.LOGIN_FAIL_LIMIT_PER_USER === 5 &&
                    rateCfg.LOGIN_RATE_WINDOW_MINUTES === 15 &&
                    rateCfg.LOGIN_BACKOFF_BASE_SECONDS === 30 &&
                    rateCfg.LOGIN_BACKOFF_MAX_MINUTES === 15,
            );

            resetLoginRateLimits();
            res = await admin.call("POST", "/api/users", { username: "fragile", password: "fragile-pass-123", role: "teacher" });
            ok("utilisateur « fragile » dédié au limiteur créé → 201", res.status === 201);

            // ── Dimension par NOM D'UTILISATEUR : seuil → verrouillage ──
            let failedAttempts = 0;
            for (let i = 1; i <= rateCfg.LOGIN_FAIL_LIMIT_PER_USER; i++) {
                const r = await loginRaw({ username: "fragile", password: `mauvais-${i}` });
                if (r.status === 401 && r.body.error.code === "INVALID_CREDENTIALS") failedAttempts += 1;
            }
            ok(
                `${rateCfg.LOGIN_FAIL_LIMIT_PER_USER} mots de passe erronés (fragile) → 401 à chaque tentative`,
                failedAttempts === rateCfg.LOGIN_FAIL_LIMIT_PER_USER,
            );

            const lockedFragile = await loginRaw({ username: "fragile", password: "fragile-pass-123" });
            ok(
                "mot de passe correct juste après le seuil → 429 RATE_LIMITED (enveloppe {error})",
                lockedFragile.status === 429 &&
                    lockedFragile.body.error.code === "RATE_LIMITED" &&
                    typeof lockedFragile.body.error.message === "string",
            );
            ok(
                "429 avec Retry-After (entier, 1 à 30 s)",
                /^\d+$/.test(lockedFragile.retryAfter ?? "") &&
                    Number(lockedFragile.retryAfter) >= 1 &&
                    Number(lockedFragile.retryAfter) <= 30,
            );
            const malformedLocked = await loginRaw({ username: "fragile" });
            ok("requête mal formée pendant le verrouillage → 429 (pas 400 — cohérent)", malformedLocked.status === 429);
            const otherUser = await loginRaw({ username: "root", password: "root-pass-123" });
            ok("autre utilisateur non affecté par le verrouillage de « fragile » → 200", otherUser.status === 200);

            shiftLoginRateLimitClock(31_000); // expiration simulée du verrouillage (30 s)
            const fragileBack = await loginRaw({ username: "fragile", password: "fragile-pass-123" });
            ok("verrouillage expiré (temps simulé) → login correct de nouveau accepté", fragileBack.status === 200);

            // ── Dimension par IP : varier les noms d'utilisateur ne trompe pas ──
            let sprayed = 0;
            for (let i = 1; i <= rateCfg.LOGIN_FAIL_LIMIT_PER_IP; i++) {
                const r = await loginRaw({ username: `probe-${String(i).padStart(2, "0")}`, password: "pas-le-bon" });
                if (r.status === 401) sprayed += 1;
            }
            ok(
                `${rateCfg.LOGIN_FAIL_LIMIT_PER_IP} noms d'utilisateur distincts refusés → 401 chacun (le compteur IP s'accumule)`,
                sprayed === rateCfg.LOGIN_FAIL_LIMIT_PER_IP,
            );
            const bypassAttempt = await loginRaw({ username: "root", password: "root-pass-123" });
            ok(
                "login correct après le seuil IP → 429 (varier les usernames ne contourne pas la limite)",
                bypassAttempt.status === 429 && bypassAttempt.body.error.code === "RATE_LIMITED",
            );
            ok(
                "messages 429 identiques (utilisateur existant verrouillé vs IP) → aucune divulgation d'existence",
                bypassAttempt.body.error.message === lockedFragile.body.error.message,
            );
            const otherIp = await loginRaw({ username: "root", password: "root-pass-123" }, { "x-forwarded-for": "9.9.9.9" });
            ok(
                "même login refusé depuis une autre IP (X-Forwarded-For, TRUST_PROXY=1) → 200 (isolation par IP)",
                otherIp.status === 200,
            );

            // ── Backoff progressif : chaque dépassement double la durée ──
            shiftLoginRateLimitClock(31_000); // premier verrouillage IP (30 s) expiré
            const probeAgain = await loginRaw({ username: "probe-99", password: "pas-le-bon" });
            ok("échec autorisé après expiration du court verrouillage → 401", probeAgain.status === 401);
            const lockedHarder = await loginRaw({ username: "root", password: "root-pass-123" });
            ok(
                "second verrouillage plus long que le premier (30 s → 60 s)",
                lockedHarder.status === 429 && Number(lockedHarder.retryAfter) > 30 && Number(lockedHarder.retryAfter) <= 60,
            );

            // ── Expiration + remise à zéro par un login réussi ──
            shiftLoginRateLimitClock(61_000);
            const finalOk = await loginRaw({ username: "root", password: "root-pass-123" });
            ok("second verrouillage expiré → login réussi (remet les compteurs à zéro)", finalOk.status === 200);
            let afterReset = 0;
            for (let i = 1; i <= rateCfg.LOGIN_FAIL_LIMIT_PER_IP - 1; i++) {
                const r = await loginRaw({ username: `reset-${String(i).padStart(2, "0")}`, password: "pas-le-bon" });
                if (r.status === 401) afterReset += 1;
            }
            ok(
                "compteurs remis à zéro par le succès : 9 nouvelles tentatives toutes en 401 (aucun blocage anticipé)",
                afterReset === rateCfg.LOGIN_FAIL_LIMIT_PER_IP - 1,
            );
            resetLoginRateLimits(); // la suite se termine sans verrouillage résiduel
        }

        console.log("── 18. Abstraction RFID : injection du lecteur factice (RfidReader) ──");
        {
            const rfid = await import("../rfid/reader");
            const { FakeRfidReader } = await import("../rfid/fakeReader");
            const readerSvc = await import("../services/readerService");
            const { ReaderTimeoutError } = await import("../core/errors");

            ok(
                "lecteur actif par défaut = stub hors ligne (RFID_DISABLED=1, aucune dépendance USB)",
                rfid.getReader().isOnline() === false,
            );

            const fake = new FakeRfidReader();
            const restoreReader = rfid.setReader(fake);

            // ── Simulated offline reader (injected) ──
            res = await teacher.call("GET", "/api/reader/status");
            ok("lecteur injecté hors ligne → /reader/status online:false", res.status === 200 && res.body.data.online === false);
            res = await teacher.call("POST", "/api/reader/beep");
            ok("beep (fake hors ligne) → 503 READER_OFFLINE", res.status === 503 && res.body.error.code === "READER_OFFLINE");
            res = await teacher.call("POST", "/api/reader/next-card");
            ok("next-card (fake hors ligne) → 503 READER_OFFLINE", res.status === 503 && res.body.error.code === "READER_OFFLINE");

            // ── Offline → online transition ──
            fake.setOnline(true);
            res = await teacher.call("GET", "/api/reader/status");
            ok("transition hors ligne → en ligne visible sur /reader/status", res.status === 200 && res.body.data.online === true);
            res = await teacher.call("POST", "/api/reader/beep");
            ok(
                "beep (fake en ligne) → 200 et propagé au lecteur (compteur = 1)",
                res.status === 200 && res.body.data.beep === "ok" && fake.beepCount === 1,
            );

            // ── One-shot HTTP read: UID injected deterministically ──
            const nextCardHttp = teacher.call("POST", "/api/reader/next-card");
            await waitFor("lecture unique armée côté lecteur", () => fake.pendingReads === 1);
            fake.presentCard("9200001", "1C71C1");
            res = await nextCardHttp;
            ok(
                "next-card (HTTP) renvoie l'UID injecté",
                res.status === 200 && res.body.data.uid === "9200001" && res.body.data.hexId === "1C71C1",
            );

            // ── Scan loop driven by the fake reader (real pipeline) ──
            res = await teacher.call("POST", "/api/groups", { name: "G-FAKE" });
            const gFake = res.body.data;
            res = await teacher.call("POST", "/api/students", { firstName: "Fanny", lastName: "Fake", groupId: gFake.id });
            const fanny = res.body.data;
            await teacher.call("POST", `/api/students/${fanny.id}/card`, { uid: "9200002" });
            res = await teacher.call("POST", "/api/sessions", { label: "Session fake reader", groupId: gFake.id });
            const sFake = res.body.data;
            await teacher.call("POST", `/api/sessions/${sFake.id}/start`);

            await waitFor("boucle de scan armée sur le lecteur", () => fake.pendingReads === 1);
            fake.presentCard("9200002");
            await waitFor("présence enregistrée par la boucle", async () => {
                const r = await teacher.call("GET", `/api/sessions/${sFake.id}/attendance`);
                return (r.body.data as any[]).some((row) => row.student_id === fanny.id);
            });
            ok("scan reçu via la boucle + fake → présence enregistrée", true);

            fake.presentCard("9299999"); // unknown card
            fake.presentCard("9200002"); // duplicate of the accepted scan
            await waitFor("doublon journalisé", async () => {
                const r = await teacher.call("GET", `/api/sessions/${sFake.id}/scans`);
                return (r.body.data as any[]).length === 3;
            });
            res = await teacher.call("GET", `/api/sessions/${sFake.id}/scans`);
            const fakeScans = res.body.data as any[];
            res = await teacher.call("GET", `/api/sessions/${sFake.id}/attendance`);
            ok(
                "boucle + fake : 3 scans journalisés (accepted, unknown, duplicate), 1 seule présence",
                fakeScans.map((row) => row.result).join(",") === "accepted,unknown,duplicate" &&
                    (res.body.data as any[]).length === 1,
            );

            res = await teacher.call("POST", "/api/reader/next-card");
            ok(
                "next-card pendant que la boucle tient le lecteur → 409 READER_BUSY",
                res.status === 409 && res.body.error.code === "READER_BUSY",
            );

            // ── Hot disconnect/reconnect while the scan loop runs ──
            fake.setOnline(false);
            res = await teacher.call("GET", "/api/reader/status");
            ok(
                "déconnexion à chaud (session en cours) → online:false, scanRunning:true",
                res.status === 200 && res.body.data.online === false && res.body.data.scanRunning === true,
            );
            res = await teacher.call("POST", "/api/reader/beep");
            ok("beep pendant la déconnexion → 503 READER_OFFLINE", res.status === 503 && res.body.error.code === "READER_OFFLINE");

            res = await teacher.call("POST", "/api/students", { firstName: "Franck", lastName: "Reconnect", groupId: gFake.id });
            const frank = res.body.data;
            await teacher.call("POST", `/api/students/${frank.id}/card`, { uid: "9200003" });
            fake.setOnline(true);
            await waitFor("reconnexion : boucle de nouveau armée", () => fake.pendingReads === 1);
            fake.presentCard("9200003");
            await waitFor("scan traité après reconnexion", async () => {
                const r = await teacher.call("GET", `/api/sessions/${sFake.id}/attendance`);
                return (r.body.data as any[]).some((row) => row.student_id === frank.id);
            });
            ok("reconnexion à chaud : la boucle attendait, reprend et traite le scan", true);

            res = await teacher.call("POST", `/api/sessions/${sFake.id}/stop`);
            ok("stop de la session (lecteur fake) → completed", res.status === 200 && res.body.data.status === "completed");
            if (fake.pendingReads > 0) fake.presentCard("9200000"); // vide la lecture abandonnée par la boucle

            // ── Timeout (504) and its busy guard, at the service level ──
            let timedOut = false;
            try {
                await readerSvc.nextCard(150); // aucune carte présentée
            } catch (err) {
                timedOut = err instanceof ReaderTimeoutError;
            }
            ok("next-card sans carte présentée → ReaderTimeoutError (504 READER_TIMEOUT)", timedOut);

            res = await teacher.call("POST", "/api/reader/next-card");
            ok(
                "sonde expirée encore armée côté lecteur → POST next-card 409 READER_BUSY",
                res.status === 409 && res.body.error.code === "READER_BUSY",
            );
            fake.presentCard("9200004"); // satisfait (et consomme) la sonde abandonnée
            await waitFor("sonde abandonnée consommée", () => fake.pendingReads === 0);
            const nextAfterDrain = teacher.call("POST", "/api/reader/next-card");
            await waitFor("nouvelle lecture armée", () => fake.pendingReads === 1);
            fake.presentCard("9200005");
            res = await nextAfterDrain;
            ok("sonde abandonnée consommée → next-card de nouveau opérationnel", res.status === 200 && res.body.data.uid === "9200005");

            restoreReader();
            ok("lecteur par défaut restauré après l'injection (stub hors ligne)", rfid.getReader().isOnline() === false);
        }

        console.log("── 19. Base de données : sauvegarde SQLite (.db, admin seul) ──");
        {
            const Database = (await import("better-sqlite3")).default;
            const { db, TARGET_SCHEMA_VERSION } = await import("../db");

            // NB: « anon » a été authentifié root en section 13 — un client
            // neuf (sans cookie) est nécessaire pour le cas vraiment anonyme.
            const noCookie = new Client(base);
            res = await noCookie.call("GET", "/api/backups");
            ok("GET /api/backups sans session → 401 NOT_AUTHENTICATED", res.status === 401 && res.body.error.code === "NOT_AUTHENTICATED");
            res = await teacher.call("GET", "/api/backups");
            ok("GET /api/backups avec teacher → 403 FORBIDDEN", res.status === 403 && res.body.error.code === "FORBIDDEN");
            res = await teacher.call("POST", "/api/backups");
            ok("POST /api/backups avec teacher → 403 FORBIDDEN", res.status === 403 && res.body.error.code === "FORBIDDEN");

            // Witness row created right before the snapshot: fresh writes live
            // in the WAL (not checkpointed yet), so finding this group inside
            // the backup proves the online backup integrated the WAL.
            res = await teacher.call("POST", "/api/groups", { name: "G-DANS-BACKUP" });
            ok("groupe témoin créé avant la sauvegarde → 201", res.status === 201);

            res = await admin.call("POST", "/api/backups");
            const backup = res.body.data;
            ok(
                "POST /api/backups (admin) → 201 { filename horodaté, size_bytes > 0, created_at }",
                res.status === 201 &&
                    /^attendance-\d{8}-\d{6}(?:-\d{1,2})?\.db$/.test(backup.filename ?? "") &&
                    backup.size_bytes > 0 &&
                    typeof backup.created_at === "string",
            );
            ok(
                "nom de fichier sûr : aucun chemin ni séparateur exposé",
                !backup.filename.includes("/") && !backup.filename.includes("\\") && !backup.filename.includes(".."),
            );

            // Row created AFTER the snapshot must be absent from it.
            res = await teacher.call("POST", "/api/groups", { name: "G-APRES-BACKUP" });
            ok("groupe créé après la sauvegarde → 201", res.status === 201);

            const second = await admin.call("POST", "/api/backups");
            ok(
                "seconde sauvegarde → 201 avec nom distinct (suffixe anti-collision)",
                second.status === 201 && second.body.data.filename !== backup.filename,
            );

            res = await admin.call("GET", "/api/backups");
            ok(
                "GET /api/backups → les 2 sauvegardes listées, plus récente d'abord",
                res.status === 200 &&
                    res.body.meta.total === 2 &&
                    res.body.data[0].filename === second.body.data.filename &&
                    res.body.data[1].filename === backup.filename,
            );

            // ── Download the stored backup as a raw .db attachment ──
            const dl = await fetch(`${base}/api/backups/${backup.filename}`, {
                headers: { cookie: admin.cookie ?? "" },
            });
            const disposition = dl.headers.get("content-disposition") ?? "";
            const bytes = Buffer.from(await dl.arrayBuffer());
            ok(
                "GET /api/backups/:filename → 200 + Content-Disposition attachment « ...db »",
                dl.status === 200 && /^attachment; filename="attendance-\d{8}-\d{6}(?:-\d{1,2})?\.db"$/.test(disposition),
            );
            ok(
                "octets téléchargés : en-tête SQLite valide + taille annoncée cohérente",
                bytes.subarray(0, 15).toString("latin1") === "SQLite format 3" &&
                    Number(dl.headers.get("content-length")) === bytes.length,
            );

            // ── Open the backup independently (own file, read-only) ──
            const extractedPath = path.join(tmpDir, "backup-extrait.db");
            fs.writeFileSync(extractedPath, bytes);
            const extracted = new Database(extractedPath, { readonly: true, fileMustExist: true });
            try {
                ok(
                    "sauvegarde ouverte seule : PRAGMA integrity_check → ok",
                    extracted.pragma("integrity_check", { simple: true }) === "ok",
                );
                ok(
                    "sauvegarde ouverte seule : version de schéma = TARGET_SCHEMA_VERSION",
                    extracted.pragma("user_version", { simple: true }) === TARGET_SCHEMA_VERSION,
                );
                const liveUsers = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
                const backupUsers = extracted.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
                ok("contenu cohérent : même nombre d'utilisateurs que la base vivante", backupUsers.n === liveUsers.n);
                const witness = extracted.prepare("SELECT COUNT(*) AS n FROM groups WHERE name = ?").get("G-DANS-BACKUP") as { n: number };
                ok("l'écriture récente (journal WAL non checkpointé) EST dans la sauvegarde", witness.n === 1);
                const tooLate = extracted.prepare("SELECT COUNT(*) AS n FROM groups WHERE name = ?").get("G-APRES-BACKUP") as { n: number };
                ok("sémantique d'instantané : le groupe créé après la sauvegarde est absent", tooLate.n === 0);
            } finally {
                extracted.close();
            }

            // ── The live database is untouched by the backup (no file copy) ──
            ok("base vivante toujours intègre après sauvegarde (integrity_check)", db.pragma("integrity_check", { simple: true }) === "ok");
            res = await teacher.call("POST", "/api/groups", { name: "G-APRES-TELECHARGEMENT" });
            ok("base vivante toujours inscriptible après la sauvegarde (aucun verrou)", res.status === 201);
            ok(
                "la sauvegarde est bien stockée dans BACKUP_DIR (répertoire dédié, hors base)",
                fs.existsSync(path.join(process.env.BACKUP_DIR ?? "", backup.filename)),
            );

            // ── Hardening: unknown file, traversal, non-admin download ──
            res = await admin.call("GET", "/api/backups/attendance-20000101-000000.db");
            ok(
                "sauvegarde au nom valide mais inconnue → 404 NOT_FOUND sans fuite de chemin",
                res.status === 404 && res.body.error.code === "NOT_FOUND" && !JSON.stringify(res.body).includes(tmpDir),
            );
            res = await admin.call("GET", "/api/backups/inconnu-00000000-000000.db");
            ok(
                "nom hors format (whitelist stricte) → 400 VALIDATION_ERROR",
                res.status === 400 && res.body.error.code === "VALIDATION_ERROR",
            );
            res = await admin.call("GET", `/api/backups/${encodeURIComponent("../verify.db")}`);
            ok(
                "traversal de chemin (« ..%2F ») refusé (400/404) sans divulgation",
                (res.status === 400 || res.status === 404) && !JSON.stringify(res.body).includes(tmpDir),
            );
            res = await teacher.call("GET", `/api/backups/${backup.filename}`);
            ok("téléchargement par teacher → 403 FORBIDDEN", res.status === 403 && res.body.error.code === "FORBIDDEN");
        }

        console.log("── 20. Base de données : restauration complète (.db, admin seul) ──");
        {
            const Database = (await import("better-sqlite3")).default;
            const dbBefore = (await import("../db")).db;
            const backupDirPath = process.env.BACKUP_DIR ?? "";

            const restoreRaw = async (body: Uint8Array, cookie?: string): Promise<ApiResponse> => {
                const r = await fetch(`${base}/api/backups/restore`, {
                    method: "POST",
                    headers: {
                        "content-type": "application/octet-stream",
                        ...(cookie ? { cookie } : {}),
                    },
                    body,
                });
                let parsed: unknown = null;
                try {
                    parsed = await r.json();
                } catch {
                    /* empty response */
                }
                return { status: r.status, body: parsed };
            };

            // ── Authentification : admin uniquement ──
            let r20 = await restoreRaw(Buffer.alloc(0));
            ok(
                "POST /api/backups/restore sans session → 401 NOT_AUTHENTICATED",
                r20.status === 401 && r20.body.error.code === "NOT_AUTHENTICATED",
            );
            r20 = await restoreRaw(Buffer.alloc(0), teacher.cookie);
            ok("POST /api/backups/restore avec teacher → 403 FORBIDDEN", r20.status === 403 && r20.body.error.code === "FORBIDDEN");

            // ── Fichiers invalides refusés, base vivante jamais touchée ──
            r20 = await restoreRaw(Buffer.alloc(0), admin.cookie);
            ok("corps vide → 400 VALIDATION_ERROR", r20.status === 400 && r20.body.error.code === "VALIDATION_ERROR");
            r20 = await restoreRaw(Buffer.from("ceci n'est pas une base SQLite"), admin.cookie);
            ok("octets qui ne sont pas du SQLite → 400 VALIDATION_ERROR", r20.status === 400 && r20.body.error.code === "VALIDATION_ERROR");
            res = await teacher.call("POST", "/api/groups", { name: "G-ENCORE-LA" });
            ok("base vivante toujours utilisable après les refus (aucun fichier touché)", res.status === 201);

            // ── Base SQLite corrompue → integrity_check la refuse ──
            // Fichier SQLite valide (grosses données), puis une page centrale
            // — forcément allouée — est remise à zéro : l'integrity_check
            // détecte la page invalide et la restauration est refusée.
            const corruptPath = path.join(tmpDir, "corrompu.db");
            {
                const cdb = new Database(corruptPath);
                cdb.exec("CREATE TABLE t (x TEXT NOT NULL)");
                const insert = cdb.prepare("INSERT INTO t (x) VALUES (?)");
                // UNE seule transaction : sans elle, 2 000 commits fsyncés
                // bloquent la boucle d'événements plusieurs secondes, le
                // keep-alive du serveur expire et la requête suivante part
                // sur un socket mort (ECONNRESET aléatoire).
                cdb.transaction(() => {
                    for (let i = 0; i < 2000; i++) insert.run(`ligne-${i}-${"x".repeat(64)}`);
                })();
                cdb.close(); // checkpoint : toutes les pages sont dans le fichier
                const corrupt = fs.readFileSync(corruptPath);
                const pageStart = Math.floor(corrupt.length / 2 / 4096) * 4096;
                corrupt.fill(0, pageStart, pageStart + 4096);
                r20 = await restoreRaw(corrupt, admin.cookie);
                ok(
                    "base SQLite corrompue → 400 VALIDATION_ERROR (contrôle d'intégrité)",
                    r20.status === 400 &&
                        r20.body.error.code === "VALIDATION_ERROR" &&
                        /intégrit/i.test(r20.body.error.message ?? ""),
                );
            }

            // ── Version de schéma postérieure à l'application → refus ──
            const futurePath = path.join(tmpDir, "future.db");
            {
                const fdb = new Database(futurePath);
                fdb.exec("CREATE TABLE t (x TEXT)");
                fdb.pragma("user_version = 999");
                fdb.close();
                r20 = await restoreRaw(fs.readFileSync(futurePath), admin.cookie);
                ok(
                    "version de schéma 999 (future) → 400 VALIDATION_ERROR",
                    r20.status === 400 && r20.body.error.code === "VALIDATION_ERROR",
                );
            }

            // ── SQLite valide mais étranger à l'application (tables absentes) ──
            const emptyTargetPath = path.join(tmpDir, "vide-cible.db");
            {
                const { TARGET_SCHEMA_VERSION: targetVersion } = await import("../db");
                const edb = new Database(emptyTargetPath);
                // Version cible exacte : aucune migration n'est rejouée sur ce
                // fichier vide, c'est bien le contrôle des tables attendues
                // qui doit refuser la restauration.
                edb.pragma(`user_version = ${targetVersion}`);
                edb.close();
                r20 = await restoreRaw(fs.readFileSync(emptyTargetPath), admin.cookie);
                ok(
                    "SQLite intègre sans les tables de l'application → 400 (tables attendues absentes)",
                    r20.status === 400 &&
                        r20.body.error.code === "VALIDATION_ERROR" &&
                        /tables attendues absentes/i.test(r20.body.error.message ?? ""),
                );
            }

            // ── Session active → restauration bloquée (409), aucune trace ──
            res = await teacher.call("POST", "/api/groups", { name: "G-SESSION-20" });
            const g20 = res.body.data;
            res = await teacher.call("POST", "/api/sessions", { label: "Session bloc-restaure", groupId: g20.id });
            const s20 = res.body.data;
            res = await teacher.call("POST", `/api/sessions/${s20.id}/start`);
            ok("session active créée pour tester le blocage → running", res.status === 200 && res.body.data.status === "running");

            res = await admin.call("GET", "/api/backups");
            const listBefore = res.body.meta.total as number;
            const usableName = res.body.data[0].filename as string;
            const usableBytes = fs.readFileSync(path.join(backupDirPath, usableName));
            r20 = await restoreRaw(usableBytes, admin.cookie);
            ok(
                "session active → 409 RESTORE_SESSION_RUNNING (fichier valide mais restauration refusée)",
                r20.status === 409 && r20.body.error.code === "RESTORE_SESSION_RUNNING",
            );
            res = await admin.call("GET", "/api/backups");
            ok("refus sur session active : aucune sauvegarde de sécurité parasite", res.body.meta.total === listBefore);
            res = await teacher.call("POST", `/api/sessions/${s20.id}/stop`);
            ok("session arrêtée → restauration de nouveau possible", res.status === 200);

            // ── Restauration réussie ──
            // 1. Instantané de l'état courant, utilisé comme fichier restauré.
            res = await admin.call("POST", "/api/backups");
            const snapshot = res.body.data;
            const snapshotBytes = fs.readFileSync(path.join(backupDirPath, snapshot.filename));
            ok("instantané courant créé pour tester la restauration → 201", res.status === 201 && snapshotBytes.length > 0);

            // 2. Témoin créé APRÈS l'instantané : la restauration doit l'effacer.
            res = await teacher.call("POST", "/api/groups", { name: "G-EFFACEE-PAR-RESTAURATION" });
            ok("groupe créé après l'instantané (devra disparaître) → 201", res.status === 201);

            // 3. Restauration à proprement parler.
            r20 = await restoreRaw(snapshotBytes, admin.cookie);
            ok(
                "POST /api/backups/restore (admin, fichier valide) → 200 { restored_size_bytes, safety_backup horodaté }",
                r20.status === 200 &&
                    r20.body.data.restored_size_bytes === snapshotBytes.length &&
                    /^attendance-\d{8}-\d{6}(?:-\d{1,2})?\.db$/.test(r20.body.data.safety_backup?.filename ?? "") &&
                    r20.body.data.safety_backup?.size_bytes > 0,
            );
            const safetyName = r20.body.data.safety_backup.filename as string;

            // 4. La sauvegarde de sécurité contient l'état d'AVANT restauration.
            const safetyPath = path.join(backupDirPath, safetyName);
            ok("sauvegarde de sécurité écrite dans BACKUP_DIR", fs.existsSync(safetyPath));
            const safetyDb = new Database(safetyPath, { readonly: true, fileMustExist: true });
            try {
                ok(
                    "sauvegarde de sécurité : integrity_check ok + état d'avant conservé (témoin présent)",
                    safetyDb.pragma("integrity_check", { simple: true }) === "ok" &&
                        (safetyDb.prepare("SELECT COUNT(*) AS n FROM groups WHERE name = ?").get("G-EFFACEE-PAR-RESTAURATION") as { n: number }).n === 1,
                );
            } finally {
                safetyDb.close();
            }

            // 5. La base vivante est le fichier restauré, via une connexion rouverte.
            const dbAfter = (await import("../db")).db;
            ok("connexion SQLite refermée puis rouverte (nouvelle poignée active)", dbAfter !== dbBefore);
            const countGroup = (name: string): number =>
                (dbAfter.prepare("SELECT COUNT(*) AS n FROM groups WHERE name = ?").get(name) as { n: number }).n;
            ok(
                "base restaurée : le témoin d'après-instantané a disparu, les écritures antérieures sont présentes",
                countGroup("G-EFFACEE-PAR-RESTAURATION") === 0 &&
                    countGroup("G-DANS-BACKUP") === 1 &&
                    countGroup("G-ENCORE-LA") === 1,
            );
            ok(
                "base restaurée intègre (integrity_check) et toujours en mode WAL",
                dbAfter.pragma("integrity_check", { simple: true }) === "ok" &&
                    dbAfter.pragma("journal_mode", { simple: true }) === "wal",
            );

            // 6. API et services passent transparentement sur la nouvelle connexion.
            res = await teacher.call("GET", "/api/groups");
            ok(
                "API sur la nouvelle connexion : le groupe effacé n'est plus listé",
                res.status === 200 && !(res.body.data as any[]).some((g) => g.name === "G-EFFACEE-PAR-RESTAURATION"),
            );
            res = await teacher.call("POST", "/api/groups", { name: "G-APRES-RESTAURE" });
            ok("nouvelle écriture après restauration → 201 (services rebranchés)", res.status === 201);
            res = await admin.call("GET", "/api/auth/me");
            ok("session de connexion toujours valide (compte présent dans la base restaurée)", res.status === 200 && res.body.data.user.username === "root");

            // 7. La sauvegarde de sécurité reste listée et téléchargeable.
            res = await admin.call("GET", "/api/backups");
            ok(
                "sauvegarde de sécurité listée parmi les sauvegardes (récupérable)",
                res.status === 200 && (res.body.data as any[]).some((b) => b.filename === safetyName),
            );

            // 8. Aucun fichier temporaire résiduel à côté de la base.
            const leftovers = fs
                .readdirSync(path.dirname(process.env.DB_PATH!))
                .filter((f) => f.includes(".restore-") || f.includes("-journal"));
            ok("aucun fichier temporaire (.restore-*, -journal) résiduel à côté de la base", leftovers.length === 0);
        }

        console.log("── 21. Horloge injectable : scheduler et transitions déterministes (FakeClock) ──");
        {
            const { getClock, setClock, systemClock } = await import("../core/clock");
            const { FakeClock } = await import("../core/fakeClock");
            const { isoNow } = await import("../db/types");

            // Neutralize every session the previous sections left scheduled or
            // running: nothing may interfere with the simulated windows.
            for (const s of sessionService.list()) {
                if (s.status === "scheduled") await teacher.call("POST", `/api/sessions/${s.id}/cancel`);
            }
            const leftover = sessionService.getActive();
            if (leftover) await teacher.call("POST", `/api/sessions/${leftover.id}/stop`);

            ok("horloge active par défaut = horloge système (démarrage inchangé)", getClock() === systemClock);

            const MIN = 60_000;
            const T0 = Date.parse("2026-03-01T08:00:00.000Z");
            const iso = (ms: number): string => new Date(ms).toISOString();
            const sessionRow = async (id: number): Promise<any> => (await teacher.call("GET", `/api/sessions/${id}`)).body.data;

            const fake = new FakeClock(iso(T0));
            const restoreClock = setClock(fake);
            try {
                ok(
                    "isoNow() = l'horloge injectée (convention ISO UTC ms + Z conservée)",
                    isoNow() === "2026-03-01T08:00:00.000Z",
                );

                // La création sans scheduledAt ancre la fenêtre sur la fausse
                // horloge (la route ne lit plus Date.now()).
                res = await teacher.call("POST", "/api/sessions", { label: "Horloge — now par défaut", groupId: g1.id });
                const sDefault = res.body.data;
                ok("scheduledAt par défaut de création = horloge factice", sDefault.scheduled_at === iso(T0));
                await teacher.call("POST", `/api/sessions/${sDefault.id}/cancel`); // sinon sa fenêtre s'ouvrirait au premier tick

                // 1) Fenêtre pas encore ouverte → rien ne démarre.
                res = await teacher.call("POST", "/api/sessions", {
                    label: "Horloge — pas encore",
                    groupId: g1.id,
                    scheduledAt: iso(T0 + 5 * MIN),
                    durationMinutes: 30,
                });
                const sFenetre = res.body.data;
                scheduler.runSchedulerTick();
                ok("fenêtre pas encore ouverte → pas de démarrage automatique", (await sessionRow(sFenetre.id)).status === "scheduled");

                // 2) Cap exactement sur scheduled_at (borne basse incluse).
                fake.set(iso(T0 + 5 * MIN));
                scheduler.runSchedulerTick();
                const started = await sessionRow(sFenetre.id);
                ok("démarrage automatique pile sur scheduled_at (borne basse incluse)", started.status === "running");
                ok("started_at écrit par l'horloge injectée (transition déterministe)", started.started_at === iso(T0 + 5 * MIN));

                // 3) Une seconde avant la fin → toujours en cours.
                fake.advance(29 * MIN + 59_000); // fin de fenêtre − 1 s
                scheduler.runSchedulerTick();
                ok("1 s avant la fin de la fenêtre → session toujours running", (await sessionRow(sFenetre.id)).status === "running");

                // 4) Cap exactement sur la fin → arrêt automatique (auto_end
                //    passe par sessionService → repository → isoNow()).
                fake.advance(1_000);
                scheduler.runSchedulerTick();
                const ended = await sessionRow(sFenetre.id);
                ok(
                    "arrêt automatique pile à la fin de la fenêtre (now ≥ scheduled_at + durée)",
                    ended.status === "completed" && ended.ended_at !== null,
                );
                ok("ended_at écrit par l'horloge injectée (fin auto déterministe)", ended.ended_at === iso(T0 + 35 * MIN));

                // 5) Fenêtre entièrement écoulée → jamais de rattrapage, même
                //    après un voyage dans le temps.
                res = await teacher.call("POST", "/api/sessions", {
                    label: "Horloge — rattrapage",
                    groupId: g1.id,
                    scheduledAt: iso(T0 + 120 * MIN),
                    durationMinutes: 10,
                });
                const sRate = res.body.data;
                fake.set(iso(T0 + 131 * MIN)); // fin de fenêtre + 1 min
                scheduler.runSchedulerTick();
                ok("fenêtre écoulée → pas de rattrapage (reste scheduled après le voyage temporel)", (await sessionRow(sRate.id)).status === "scheduled");

                // 6) Borne haute exclusive : now == scheduled_at + durée
                //    exactement n'appartient plus à la fenêtre.
                res = await teacher.call("POST", "/api/sessions", {
                    label: "Horloge — borne exclue",
                    groupId: g1.id,
                    scheduledAt: iso(T0 + 180 * MIN),
                    durationMinutes: 10,
                });
                const sExclue = res.body.data;
                fake.set(iso(T0 + 190 * MIN));
                scheduler.runSchedulerTick();
                ok("now = borne haute exacte de la fenêtre → pas de démarrage (fin exclusive)", (await sessionRow(sExclue.id)).status === "scheduled");

                // 7) Deux fenêtres contenant now → la plus ancienne démarre
                //    d'abord (mono-lecteur), puis laisse la place ; une session
                //    arrêtée ne redémarre jamais.
                res = await teacher.call("POST", "/api/sessions", {
                    label: "Horloge — aînée",
                    groupId: g1.id,
                    scheduledAt: iso(T0 + 230 * MIN),
                    durationMinutes: 90,
                });
                const sAinee = res.body.data;
                res = await teacher.call("POST", "/api/sessions", {
                    label: "Horloge — cadette",
                    groupId: g1.id,
                    scheduledAt: iso(T0 + 240 * MIN),
                    durationMinutes: 30,
                });
                const sCadette = res.body.data;
                fake.set(iso(T0 + 240 * MIN)); // les deux fenêtres contiennent now
                scheduler.runSchedulerTick();
                ok(
                    "deux fenêtres contenant now → la plus ancienne démarre (mono-lecteur)",
                    (await sessionRow(sAinee.id)).status === "running" && (await sessionRow(sCadette.id)).status === "scheduled",
                );
                await teacher.call("POST", `/api/sessions/${sAinee.id}/stop`);
                scheduler.runSchedulerTick();
                const cadette = await sessionRow(sCadette.id);
                ok(
                    "relais pris par la suivante, la session arrêtée ne redémarre pas",
                    cadette.status === "running" &&
                        cadette.started_at === iso(T0 + 240 * MIN) &&
                        (await sessionRow(sAinee.id)).status === "completed",
                );
            } finally {
                restoreClock();
            }

            ok(
                "horloge système restaurée après injection (isoNow() revenu à l'heure réelle)",
                getClock() === systemClock && Math.abs(Date.now() - Date.parse(isoNow())) < 120_000,
            );
        }

        console.log("── 22. Journalisation structurée : lignes JSON + masquage des données sensibles ──");
        {
            const { logger, setLogSink, maskUid } = await import("../core/logger");
            const { setClock } = await import("../core/clock");
            const { FakeClock } = await import("../core/fakeClock");
            const { errorHandler } = await import("../api/middleware/error");
            const { AppError } = await import("../core/errors");

            // Silence d'abord : aucun tick ni boucle de scan ne doit venir
            // polluer la capture pendant cette section.
            for (const s of sessionService.list()) {
                if (s.status === "running") await teacher.call("POST", `/api/sessions/${s.id}/stop`);
                if (s.status === "scheduled") await teacher.call("POST", `/api/sessions/${s.id}/cancel`);
            }

            interface CapturedLine {
                line: string;
                level: string;
                record: any;
            }
            const captured: CapturedLine[] = [];
            const restoreSink = setLogSink((line, level, record) => {
                captured.push({ line, level, record });
            });
            try {
                const probe = logger.child({ component: "verify" });
                const findLine = (event: string): CapturedLine | undefined => captured.find((c) => c.record.event === event);

                // 1) Format : une ligne JSON par événement { timestamp ISO UTC,
                //    level, event, contexte } (+ bindings du child). Le timestamp
                //    reste à l'heure RÉELLE même sous FakeClock (exception
                //    délibérée des logs, cf. core/logger.ts).
                const fake = new FakeClock("2026-05-05T10:00:00.000Z");
                const restoreClock = setClock(fake);
                try {
                    probe.info("verify.event", { session_id: 42, ok: true });
                } finally {
                    restoreClock();
                }
                const fmt = findLine("verify.event")!;
                ok(
                    "ligne directe : JSON parseable { timestamp, level, event, contexte } (+ bindings child)",
                    fmt.record.level === "info" &&
                        fmt.record.event === "verify.event" &&
                        fmt.record.component === "verify" &&
                        fmt.record.session_id === 42 &&
                        fmt.record.ok === true,
                );
                ok(
                    "timestamp ISO UTC à l'heure réelle malgré FakeClock injectée (exception logs)",
                    fmt.record.timestamp === new Date(fmt.record.timestamp).toISOString() &&
                        Math.abs(Date.now() - Date.parse(fmt.record.timestamp)) < 120_000 &&
                        JSON.parse(fmt.line).timestamp === fmt.record.timestamp,
                );

                // 2) Masquage : mot de passe, hash, token, cookie, authorization,
                //    sid — y compris imbriqués — et UID RFID tronqué aux 4 derniers.
                captured.length = 0;
                probe.info("verify.secret", {
                    username: "root",
                    password: "S3cret-JAMAIS-DANS-LES-LOGS",
                    password_hash: "scrypt$N$r$p$c2FsdA==$aGFzaA==",
                    token: "TOKEN-SESSION-XYZ",
                    cookie: "sid=TOKEN-SESSION-XYZ",
                    headers: { authorization: "Bearer ABC123SECRET", accept: "application/json" },
                    nested: { sid: "SID-42", newPassword: "nope-jamais" },
                    uid: "9000001",
                    scans: [{ uid: "9000002", note: "visible" }],
                });
                const sec = findLine("verify.secret")!;
                ok(
                    "aucune valeur sensible ne subsiste dans la ligne sérialisée",
                    !sec.line.includes("S3cret-JAMAIS-DANS-LES-LOGS") &&
                        !sec.line.includes("scrypt$") &&
                        !sec.line.includes("TOKEN-SESSION-XYZ") &&
                        !sec.line.includes("ABC123SECRET") &&
                        !sec.line.includes("SID-42") &&
                        !sec.line.includes("nope-jamais") &&
                        !sec.line.includes("9000001") &&
                        !sec.line.includes("9000002"),
                );
                ok(
                    "champs sensibles remplacés par [redacted] (récursif, hors majuscules/« _ »)",
                    sec.record.password === "[redacted]" &&
                        sec.record.password_hash === "[redacted]" &&
                        sec.record.token === "[redacted]" &&
                        sec.record.cookie === "[redacted]" &&
                        sec.record.headers.authorization === "[redacted]" &&
                        sec.record.nested.sid === "[redacted]" &&
                        sec.record.nested.newPassword === "[redacted]",
                );
                ok(
                    "les champs non sensibles traversent intacts",
                    sec.record.username === "root" &&
                        sec.record.headers.accept === "application/json" &&
                        sec.record.scans[0].note === "visible",
                );
                ok(
                    "UID RFID masqués aux 4 derniers chiffres (uid, decid, hexid, y compris dans un tableau)",
                    sec.record.uid === "***0001" && sec.record.scans[0].uid === "***0002" && maskUid("9000001") === "***0001",
                );

                // 3) Filtrage par niveau : debug silencieux par défaut.
                probe.debug("verify.hidden", {});
                ok(
                    "LOG_LEVEL par défaut (info) : les lignes debug sont écartées",
                    captured.every((c) => c.record.event !== "verify.hidden"),
                );
                process.env.LOG_LEVEL = "debug";
                try {
                    probe.debug("verify.visible", {});
                } finally {
                    delete process.env.LOG_LEVEL;
                }
                ok("LOG_LEVEL=debug : la ligne debug est émise", findLine("verify.visible")?.level === "debug");

                // 4) Le middleware d'erreur ne journalise la stack QUE pour les 500,
                //    et la réponse client reste générique (aucun détail interne).
                const makeRes = (): any => {
                    const res: any = {
                        status(s: number) {
                            res.statusCode = s;
                            return res;
                        },
                        set() {
                            return res;
                        },
                        json(body: unknown) {
                            res.body = body;
                            return res;
                        },
                    };
                    return res;
                };

                captured.length = 0;
                const internalRes = makeRes();
                errorHandler(new Error("PANNE-INTERNE-BOOM"), { method: "GET", originalUrl: "/api/boom" } as any, internalRes, () => {});
                const internalLine = captured.find((c) => c.record.event === "http.request_error");
                ok(
                    "500 : journalisée level error AVEC stack (serveur uniquement)",
                    internalLine?.level === "error" &&
                        internalLine.record.code === "INTERNAL" &&
                        typeof internalLine.record.error?.stack === "string" &&
                        internalLine.record.error.stack.includes("PANNE-INTERNE-BOOM"),
                );
                ok(
                    "500 : réponse client générique — message interne et stack ne sortent jamais",
                    internalRes.statusCode === 500 &&
                        internalRes.body.error.code === "INTERNAL" &&
                        !JSON.stringify(internalRes.body).includes("PANNE-INTERNE-BOOM"),
                );

                captured.length = 0;
                const clientErrRes = makeRes();
                errorHandler(
                    new AppError(404, "NOT_FOUND", "Session introuvable."),
                    { method: "GET", originalUrl: "/api/sessions/999999" } as any,
                    clientErrRes,
                    () => {},
                );
                const clientErrLine = captured.find((c) => c.record.event === "http.request_error");
                ok(
                    "4xx : journalisée sans stack ni objet Error (method/path/status/code suffisent)",
                    clientErrLine?.level === "info" &&
                        clientErrLine.record.status === 404 &&
                        clientErrLine.record.code === "NOT_FOUND" &&
                        clientErrLine.record.error === undefined &&
                        clientErrLine.record.stack === undefined,
                );

                // 5) Bout en bout par HTTP : l'échec de login journalise le nom
                //    d'utilisateur, JAMAIS le mot de passe soumis.
                captured.length = 0;
                res = await anon.call("POST", "/api/auth/login", { username: "root", password: "jamais-dans-les-logs" });
                const loginFail = captured.find((c) => c.record.event === "auth.login_failed");
                ok(
                    "login refusé : username journalisé, mot de passe absent de la ligne",
                    res.status === 401 && loginFail?.record.username === "root" && !loginFail.line.includes("jamais-dans-les-logs"),
                );

                // 6) Bout en bout par le vrai pipeline de scan (lecteur factice) :
                //    la ligne scan.accepted masque l'UID et ne nomme pas l'élève.
                const rfidMod = await import("../rfid/reader");
                const { FakeRfidReader } = await import("../rfid/fakeReader");
                const scanner = new FakeRfidReader();
                const restoreReader = rfidMod.setReader(scanner);
                try {
                    res = await teacher.call("POST", "/api/groups", { name: "G-LOG" });
                    const gLog = res.body.data;
                    res = await teacher.call("POST", "/api/students", { firstName: "Lou", lastName: "Journal", groupId: gLog.id });
                    const lou = res.body.data;
                    await teacher.call("POST", `/api/students/${lou.id}/card`, { uid: "7700001" });
                    res = await teacher.call("POST", "/api/sessions", { label: "Session logs", groupId: gLog.id });
                    const sLog = res.body.data;
                    await teacher.call("POST", `/api/sessions/${sLog.id}/start`);
                    scanner.setOnline(true);
                    await waitFor("boucle de scan armée (section 22)", () => scanner.pendingReads === 1);
                    captured.length = 0;
                    scanner.presentCard("7700001");
                    await waitFor("ligne scan.accepted capturo", () => captured.some((c) => c.record.event === "scan.accepted"));
                    const scanLine = captured.find((c) => c.record.event === "scan.accepted")!;
                    ok(
                        "scan réel : uid masqué (***0001), uid complet et nom de l'élève absents de la ligne",
                        scanLine.record.uid === "***0001" &&
                            scanLine.record.session_id === sLog.id &&
                            scanLine.record.student_id === lou.id &&
                            !scanLine.line.includes("7700001") &&
                            !scanLine.line.includes("Lou") &&
                            !scanLine.line.includes("Journal"),
                    );
                    await teacher.call("POST", `/api/sessions/${sLog.id}/stop`);
                    if (scanner.pendingReads > 0) scanner.presentCard("7700000"); // vide la lecture abandonnée
                } finally {
                    restoreReader();
                }
            } finally {
                restoreSink();
            }
        }

        console.log("── 23. Sessions d'authentification persistantes (SQLite, hash SHA-256, redémarrage) ──");
        {
            const authService = await import("../services/authService");
            const dbMod = await import("../db");
            const { hashToken } = await import("../auth/sessionStore");
            const { SESSION_TTL_HOURS } = await import("../config/env");
            const ISO23 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
            const sessions = () => dbMod.authSessionRepository; // live binding (rebound on reopen)

            // Raw helpers (independent from the shared clients) to capture the
            // cookie token and probe authentication WITHOUT touching any state.
            const loginRaw = async (username: string, password: string): Promise<string> => {
                const r = await fetch(`${base}/api/auth/login`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ username, password }),
                });
                const tok = /sid=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")?.[1] ?? "";
                if (r.status !== 200 || !tok) throw new Error(`login raw inattendu (${r.status})`);
                return tok;
            };
            const whoami = async (token: string): Promise<number> =>
                (await fetch(`${base}/api/auth/me`, { headers: { cookie: `sid=${token}` } })).status;

            res = await admin.call("POST", "/api/users", { username: "persist1", password: "persist1-pass-123", role: "teacher" });
            ok("compte dédié à la persistance créé → 201", res.status === 201);
            // The repository is read from the MODULE (live binding): sections
            // 19-20 already swapped the underlying connection through a restore.
            const persistUser = dbMod.userRepository.findByUsername("persist1")!;

            // 1) Creation — the session becomes a persistent ROW, keyed by a hash.
            const count0 = sessions().count();
            const t1 = await loginRaw("persist1", "persist1-pass-123");
            ok("login → une ligne auth_sessions ajoutée (plus de Map mémoire)", sessions().count() === count0 + 1);
            const row1 = sessions().findByTokenHash(hashToken(t1));
            ok("session retrouvée par SHA-256(jeton), jamais par le jeton brut", row1 !== undefined && sessions().findByTokenHash(t1) === undefined);
            ok(
                "le jeton brut n'est JAMAIS stocké en clair dans la base",
                (dbMod.db.prepare("SELECT COUNT(*) AS c FROM auth_sessions WHERE token_hash = ?").get(t1) as { c: number }).c === 0 &&
                    /^[0-9a-f]{64}$/.test(row1!.token_hash) &&
                    row1!.token_hash !== t1,
            );
            ok(
                "horodatages created_at / expires_at / last_seen_at en ISO UTC",
                ISO23.test(row1!.created_at) && ISO23.test(row1!.expires_at) && ISO23.test(row1!.last_seen_at),
            );
            ok(
                "TTL persisté : expires_at = created_at + SESSION_TTL_HOURS",
                Date.parse(row1!.expires_at) - Date.parse(row1!.created_at) === SESSION_TTL_HOURS * 3_600_000,
            );
            ok(
                "jeton brut introuvable dans les OCTETS du fichier de base (et du WAL)",
                [process.env.DB_PATH!, `${process.env.DB_PATH!}-wal`]
                    .filter((f) => fs.existsSync(f))
                    .every((f) => !fs.readFileSync(f).toString("latin1").includes(t1)),
            );

            // 2) Concurrent sessions — two independent rows for the same account.
            const t1b = await loginRaw("persist1", "persist1-pass-123");
            ok(
                "sessions simultanées : deux jetons distincts tous deux valides",
                t1b !== t1 && (await whoami(t1)) === 200 && (await whoami(t1b)) === 200,
            );
            ok("deux lignes distinctes pour ce compte", new Set(sessions().listTokenHashesByUser(persistUser.id)).size === 2);

            // 3) Persistence across a restart — close and reopen the SAME file,
            //    exactly what the database restore does; the cookies still work.
            dbMod.reopenDatabase(dbMod.getCurrentDbPath());
            ok(
                "persistance après redémarrage simulé (base refermée/rouverte) : t1 et t1b toujours valides",
                (await whoami(t1)) === 200 && (await whoami(t1b)) === 200,
            );

            // 4) Logout — one row dies, the concurrent one survives.
            const logoutRes = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie: `sid=${t1}` } });
            ok("POST /api/auth/logout → 204", logoutRes.status === 204);
            ok("logout : la ligne de t1 est supprimée, t1 → 401", sessions().findByTokenHash(hashToken(t1)) === undefined && (await whoami(t1)) === 401);
            ok("session simultanée t1b toujours valide après le logout de t1", (await whoami(t1b)) === 200);

            // 5a) Expiration then request — lazy purge removes the row on rejection.
            ok("expiration simulée de t1b (TTL)", authService.expireSession(t1b));
            ok("session expirée → 401", (await whoami(t1b)) === 401);
            ok("ligne expirée nettoyée dès la résolution (purge paresseuse)", sessions().findByTokenHash(hashToken(t1b)) === undefined);

            // 5b) Expiration without any request — the periodic sweep cleans up.
            const tExp = await loginRaw("persist1", "persist1-pass-123");
            ok("expiration simulée sans requête (ligne encore présente avant purge)", authService.expireSession(tExp) && sessions().findByTokenHash(hashToken(tExp)) !== undefined);
            const purged = authService.purgeExpiredSessions();
            ok("purgeExpiredSessions retire les lignes expirées sans requête", purged >= 1 && sessions().findByTokenHash(hashToken(tExp)) === undefined);

            // 6) Password change invalidates the target's sessions, keeps the actor.
            const tVictim = await loginRaw("persist1", "persist1-pass-123");
            const rootToken = (admin.cookie ?? "").replace(/^sid=/, "");
            ok("session de la cible valide avant la réinitialisation", (await whoami(tVictim)) === 200);
            res = await admin.call("PATCH", `/api/users/${persistUser.id}`, { password: "persist1-new-123" });
            ok("réinitialisation du mot de passe (admin) → 200", res.status === 200);
            ok(
                "toutes les sessions de la cible invalidées (cookie 401 + aucune ligne en base)",
                (await whoami(tVictim)) === 401 && sessions().listTokenHashesByUser(persistUser.id).length === 0,
            );
            ok("session active de l'admin (root) préservée après sa réinitialisation", rootToken !== "" && (await whoami(rootToken)) === 200);

            // 7) Role change applies immediately to the SAME live session.
            const tRole = await loginRaw("persist1", "persist1-new-123");
            const as403 = await fetch(`${base}/api/users`, { headers: { cookie: `sid=${tRole}` } });
            ok("même cookie, rôle teacher : GET /api/users refusé (403)", as403.status === 403);
            await admin.call("PATCH", `/api/users/${persistUser.id}`, { role: "admin" });
            const as200 = await fetch(`${base}/api/users`, { headers: { cookie: `sid=${tRole}` } });
            ok("changement de rôle appliqué immédiatement sur la MÊME session (200)", as200.status === 200);
            ok(
                "le changement de rôle ne recrée pas la session (même jeton/hash toujours en base)",
                sessions().findByTokenHash(hashToken(tRole)) !== undefined && (await whoami(tRole)) === 200,
            );
            await admin.call("PATCH", `/api/users/${persistUser.id}`, { role: "teacher" }); // restore suite state
        }

        console.log("── 24. Journaux serveur : tampon mémoire en lecture admin (GET /api/logs) ──");
        {
            const { logger } = await import("../core/logger");
            const guest = new Client(base); // aucune session : sonne l'alarme 401
            const vlog = logger.child({ component: "verify" });
            const tail = async (qs = ""): Promise<any[]> => {
                const r = await admin.call("GET", `/api/logs${qs}`);
                return (r.body.data ?? []) as any[];
            };
            const findIn = (rows: any[], event: string): any | undefined => rows.find((e) => e.event === event);

            // 1) Accès : admin seul. Anonyme → 401, teacher → 403 (le tampon
            //    peut porter des stack traces de 500 → jamais exposé aux autres).
            res = await guest.call("GET", "/api/logs");
            ok("anonyme → 401 NOT_AUTHENTICATED", res.status === 401 && res.body.error.code === "NOT_AUTHENTICATED");
            res = await teacher.call("GET", "/api/logs");
            ok("teacher → 403 FORBIDDEN", res.status === 403 && res.body.error.code === "FORBIDDEN");
            res = await admin.call("GET", "/api/logs");
            ok(
                "admin → 200 { data:[], meta.capacity }",
                res.status === 200 &&
                    Array.isArray(res.body.data) &&
                    typeof res.body.meta.capacity === "number" &&
                    res.body.meta.capacity >= 1,
            );

            // 2) Les lignes déjà émises par le serveur peuplent le tampon (le
            //    logger alimente le tampon indépendamment du sink de la
            //    section 22). Une erreur 500 antérieure doit être présente.
            const all = await tail();
            ok(
                "le tampon contient les lignes émises (événement + niveau + tri chronologique)",
                all.length > 0 &&
                    all.every((e) => typeof e.seq === "number" && typeof e.level === "string" && typeof e.event === "string") &&
                    all.every((e, i) => i === 0 || all[i - 1].seq <= e.seq),
            );

            // 3) Un marqueur émis maintenant est récupérable, AVEC les
            //    masquages du logger (mot de passe [redacted], uid tronqué).
            vlog.info("verify.tail_marker", { note: "visible", password: "SECRET-JAMAIS-DANS-LOGS", uid: "9000009" });
            const withMarker = await tail();
            const marker = findIn(withMarker, "verify.tail_marker");
            ok(
                "marqueur présent, level info, component verify, contexte non sensible intact",
                marker !== undefined &&
                    marker.level === "info" &&
                    marker.component === "verify" &&
                    marker.fields.note === "visible",
            );
            ok(
                "masquage appliqué au tampon : password [redacted] + uid tronqué, secret jamais présent",
                marker.fields.password === "[redacted]" &&
                    marker.fields.uid === "***0009" &&
                    !JSON.stringify(marker.fields).includes("SECRET-JAMAIS-DANS-LOGS") &&
                    !marker.line.includes("SECRET-JAMAIS-DANS-LOGS"),
            );

            // 4) Filtre par niveau exact : le marqueur (info) disparaît quand on
            //    ne demande que les erreurs.
            const errorsOnly = await tail("?level=error");
            ok("level=error : le marqueur info est filtré", findIn(errorsOnly, "verify.tail_marker") === undefined);
            ok("level=warn : aucune erreur mêlée", (await tail("?level=warn")).every((e) => e.level === "warn"));

            // 5) Fenêtre : limit borne le nombre de lignes (les plus récentes).
            const one = await tail("?limit=1");
            ok("limit=1 : au plus une ligne retournée", one.length === 1);

            // 6) Curseur incrémental (since) : uniquement les lignes d'après un
            //    seq donné — le mode « tail » du client.
            const markerSeq = marker.seq as number;
            vlog.info("verify.tail_after", { rank: 2 });
            const after = await tail(`?since=${markerSeq}`);
            ok(
                "since=<seq> : exclut le marqueur, inclut la ligne émise ensuite, tout > seq",
                findIn(after, "verify.tail_marker") === undefined &&
                    findIn(after, "verify.tail_after") !== undefined &&
                    after.every((e) => e.seq > markerSeq),
            );

            // 7) Validation des paramètres (même rigueur que le reste de l'API).
            res = await admin.call("GET", "/api/logs?level=critique");
            ok("level invalide → 400 VALIDATION_ERROR", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
            res = await admin.call("GET", "/api/logs?limit=0");
            ok("limit=0 → 400", res.status === 400);
            res = await admin.call("GET", "/api/logs?limit=999999");
            ok("limit démesuré → 400", res.status === 400);
        }

        console.log("── 25. Séries récurrentes : génération et éditions sous FakeClock ──");
        {
            const { AppError } = await import("../core/errors");
            const { setClock } = await import("../core/clock");
            const { FakeClock } = await import("../core/fakeClock");
            const {
                db,
                groupRepository,
                sessionParticipantRepository,
                sessionRepository,
                sessionSeriesRepository,
                userRepository,
            } = await import("../db");
            const seriesService = await import("../services/seriesService");
            const { localDateTimeInZone, zonedTimeToUtc } = await import("../services/localTime");

            const rejects = (fn: () => unknown, status = 400, code = "VALIDATION_ERROR"): boolean => {
                try {
                    fn();
                    return false;
                } catch (err) {
                    return err instanceof AppError && err.status === status && err.code === code;
                }
            };

            const fake = new FakeClock("2026-06-01T12:00:00.000Z"); // lundi 1er juin 2026
            const restoreClock = setClock(fake);
            try {
                const root = userRepository.findByUsername("root")!;
                const gRec = groupRepository.create("G-REC");
                const makeSeries = (
                    input: Omit<Parameters<typeof seriesService.createSeries>[0], "createdBy">,
                ) => seriesService.createSeries({ timezone: "UTC", durationMinutes: 60, createdBy: root.id, ...input });

                // 1) Validation stricte — SQLite NORMALIZE les dates impossibles
                //    (date('2026-02-30') → '2026-03-02') : le service doit refuser.
                ok(
                    "validation : 2026-02-30 et 2026-02-29 refusés (2026 non bissexile, SQLite normaliserait)",
                    rejects(() => makeSeries({ label: "x", recurrence: "daily", localTime: "08:00", startsOn: "2026-02-30", groupIds: [g1.id] })) &&
                        rejects(() => makeSeries({ label: "x", recurrence: "daily", localTime: "08:00", startsOn: "2026-02-29", groupIds: [g1.id] })) &&
                        !rejects(() => makeSeries({ label: "OK bissexile", recurrence: "daily", localTime: "08:00", startsOn: "2028-02-29", endsOn: "2028-02-29", groupIds: [g1.id] })),
                );
                ok(
                    "validation : formats date/heure/fuseau refusés (2026-6-1, 24:00, 8:30, Not/AZone)",
                    rejects(() => makeSeries({ label: "x", recurrence: "daily", localTime: "08:00", startsOn: "2026-6-01", groupIds: [g1.id] })) &&
                        rejects(() => makeSeries({ label: "x", recurrence: "daily", localTime: "24:00", startsOn: "2026-06-01", groupIds: [g1.id] })) &&
                        rejects(() => makeSeries({ label: "x", recurrence: "daily", localTime: "8:30", startsOn: "2026-06-01", groupIds: [g1.id] })) &&
                        rejects(() => makeSeries({ label: "x", recurrence: "daily", localTime: "08:00", timezone: "Not/AZone", startsOn: "2026-06-01", groupIds: [g1.id] })),
                );
                ok(
                    "validation : weekday exigé si weekly, interdit si daily ; ends_on ≥ starts_on ; groupe obligatoire",
                    rejects(() => makeSeries({ label: "x", recurrence: "weekly", localTime: "08:00", startsOn: "2026-06-01", groupIds: [g1.id] })) &&
                        rejects(() => makeSeries({ label: "x", recurrence: "daily", weekday: 3, localTime: "08:00", startsOn: "2026-06-01", groupIds: [g1.id] })) &&
                        rejects(() => makeSeries({ label: "x", recurrence: "daily", localTime: "08:00", startsOn: "2026-06-08", endsOn: "2026-06-01", groupIds: [g1.id] })) &&
                        rejects(() => makeSeries({ label: "x", recurrence: "daily", localTime: "08:00", startsOn: "2026-06-01", groupIds: [] })) &&
                        rejects(() => makeSeries({ label: "x", recurrence: "daily", localTime: "08:00", startsOn: "2026-06-01", groupIds: [987654] })),
                );

                // 2) Quotidien UTC : bornes inclusives, instants, miroirs locaux.
                const daily = makeSeries({
                    label: "REC quotidienne",
                    recurrence: "daily",
                    localTime: "08:30",
                    startsOn: "2026-06-01",
                    endsOn: "2026-06-07",
                    groupIds: [g1.id],
                });
                const genDaily = seriesService.generateOccurrences(daily.id);
                const dailyRows = seriesService.listOccurrences(daily.id);
                ok(
                    "daily : 7 occurrences aux bornes inclusives, UTC + local_time + timezone + created_by portés",
                    genDaily.created.length === 7 &&
                        genDaily.skipped.length === 0 &&
                        dailyRows.length === 7 &&
                        dailyRows.every(
                            (r, i) =>
                                r.scheduled_at === `2026-06-0${i + 1}T08:30:00.000Z` &&
                                r.occurrence_date === `2026-06-0${i + 1}` &&
                                r.local_time === "08:30" &&
                                r.timezone === "UTC" &&
                                r.status === "scheduled" &&
                                r.series_id === daily.id,
                        ) &&
                        dailyRows[0].created_by === root.id &&
                        sessionRepository.getGroupIds(dailyRows[0].id).includes(g1.id),
                );

                // 3) Idempotence + préservation des lignes existantes.
                const genAgain = seriesService.generateOccurrences(daily.id);
                sessionService.cancel(dailyRows[1].id); // annulée à la main
                sessionRepository.updateSchedule(dailyRows[3].id, { label: "MANUEL" }); // retouchée à la main
                const genThird = seriesService.generateOccurrences(daily.id);
                const rowCancelled = sessionRepository.findById(dailyRows[1].id)!;
                const rowEdited = sessionRepository.findById(dailyRows[3].id)!;
                ok(
                    "génération idempotente : seconde passe 0 créée ; annulation et retouche manuelles jamais réécrites",
                    genAgain.created.length === 0 &&
                        genAgain.existing === 7 &&
                        genThird.created.length === 0 &&
                        rowCancelled.status === "cancelled" &&
                        rowEdited.label === "MANUEL" &&
                        rowEdited.scheduled_at === "2026-06-04T08:30:00.000Z",
                );

                // 4) Hebdomadaire : sélecteur de jour, starts_on borné, horizon roulant.
                const weekly = makeSeries({
                    label: "REC lundi",
                    recurrence: "weekly",
                    weekday: 1,
                    localTime: "09:00",
                    startsOn: "2026-06-03", // mercredi → première occurrence lundi 06-08
                    groupIds: [g1.id],
                });
                seriesService.generateOccurrences(weekly.id);
                const wRows = seriesService.listOccurrences(weekly.id);
                ok(
                    "weekly lundi : rien avant starts_on (06-01 sauté), puis les lundis seuls jusqu'à today+12 semaines inclus",
                    wRows.length === 12 &&
                        wRows[0].occurrence_date === "2026-06-08" &&
                        wRows.at(-1)!.occurrence_date === "2026-08-24" &&
                        wRows.every((r) => new Date(r.scheduled_at).getUTCDay() === 1),
                );
                const shortSeries = makeSeries({
                    label: "REC horizon court",
                    recurrence: "daily",
                    localTime: "10:00",
                    startsOn: "2026-06-01",
                    groupIds: [g1.id],
                });
                ok(
                    "horizon paramétrable : 1 semaine = today…today+7 inclus (8 jours) ; horizon invalide → 400",
                    seriesService.generateOccurrences(shortSeries.id, { horizonWeeks: 1 }).created.length === 8 &&
                        rejects(() => seriesService.generateOccurrences(shortSeries.id, { horizonWeeks: 0 })),
                );

                // 5) ends_on borne inclusive sans coller au patron.
                const wEnd = makeSeries({
                    label: "REC fin dimanche",
                    recurrence: "weekly",
                    weekday: 1,
                    localTime: "08:00",
                    startsOn: "2026-06-01",
                    endsOn: "2026-07-05", // dimanche → dernier lundi 06-29
                    groupIds: [g1.id],
                });
                seriesService.generateOccurrences(wEnd.id);
                const eRows = seriesService.listOccurrences(wEnd.id);
                ok(
                    "ends_on inclusif un dimanche : dernier lundi 2026-06-29 (aucun arrondi de borne)",
                    eRows.length === 5 && eRows.at(-1)!.occurrence_date === "2026-06-29",
                );

                // 6) Copie des groupes et des deltas individuels.
                const withP = makeSeries({
                    label: "REC participants",
                    recurrence: "weekly",
                    weekday: 3,
                    localTime: "13:00",
                    startsOn: "2026-06-01",
                    endsOn: "2026-06-10",
                    groupIds: [g1.id, gRec.id],
                    participants: [
                        { studentId: ada.id, included: true },
                        { studentId: alan.id, included: false },
                    ],
                });
                const genP = seriesService.generateOccurrences(withP.id);
                const pRow = sessionRepository.findById(genP.created[0])!;
                const pGroups = sessionRepository.getGroupIds(pRow.id).slice().sort((a, b) => a - b);
                const pDeltas = sessionParticipantRepository.listBySession(pRow.id);
                ok(
                    "chaque occurrence copie les groupes par défaut et les deltas (inclusion/exclusion) de la série",
                    JSON.stringify(pGroups) === JSON.stringify([g1.id, gRec.id].sort((a, b) => a - b)) &&
                        pDeltas.length === 2 &&
                        pDeltas.find((d) => d.student_id === ada.id)?.included === 1 &&
                        pDeltas.find((d) => d.student_id === alan.id)?.included === 0,
                );

                // 7) Statuts : paused/cancelled ne génèrent jamais ; cancelled terminal.
                const paused = makeSeries({
                    label: "REC pause",
                    recurrence: "daily",
                    localTime: "07:00",
                    startsOn: "2026-06-01",
                    groupIds: [g1.id],
                });
                seriesService.setSeriesStatus(paused.id, "paused");
                const genPaused = seriesService.generateOccurrences(paused.id);
                seriesService.setSeriesStatus(paused.id, "cancelled");
                const genCancelled = seriesService.generateOccurrences(paused.id);
                ok(
                    "paused puis cancelled : aucune génération ; statut refusé sur une série annulée (409 SERIES_CANCELLED)",
                    genPaused.created.length === 0 &&
                        genCancelled.created.length === 0 &&
                        sessionSeriesRepository.findById(paused.id)!.status === "cancelled" &&
                        rejects(() => seriesService.setSeriesStatus(paused.id, "active"), 409, "SERIES_CANCELLED") &&
                        rejects(() => seriesService.editSeriesFrom(paused.id, "2026-06-01", { localTime: "10:00" }), 409, "SERIES_CANCELLED"),
                );

                // 8) DST — avant : l'heure locale inexistante n'est JAMAIS décalée.
                fake.set("2026-03-05T12:00:00.000Z");
                const dst = makeSeries({
                    label: "REC DST",
                    recurrence: "daily",
                    localTime: "02:30",
                    timezone: "America/New_York",
                    durationMinutes: 45,
                    startsOn: "2026-03-05",
                    endsOn: "2026-03-10",
                    groupIds: [g1.id],
                });
                const genDst = seriesService.generateOccurrences(dst.id);
                const dstRows = seriesService.listOccurrences(dst.id);
                ok(
                    "spring forward 2026-03-08 02:30 NY : date sautée et reportée (raison nonexistent_local_time), jamais décalée",
                    genDst.skipped.length === 1 &&
                        genDst.skipped[0].occurrence_date === "2026-03-08" &&
                        genDst.skipped[0].reason === "nonexistent_local_time" &&
                        dstRows.every((r) => r.occurrence_date !== "2026-03-08"),
                );
                ok(
                    "heure locale voulue conservée de part et d'autre de la transition (EST 07:30Z → EDT 06:30Z)",
                    dstRows.every((r) => localDateTimeInZone(Date.parse(r.scheduled_at), "America/New_York").time === "02:30") &&
                        dstRows.find((r) => r.occurrence_date === "2026-03-07")!.scheduled_at === "2026-03-07T07:30:00.000Z" &&
                        dstRows.find((r) => r.occurrence_date === "2026-03-09")!.scheduled_at === "2026-03-09T06:30:00.000Z",
                );

                // 8 bis) DST — arrière : heure ambiguë = première occurrence (EDT).
                fake.set("2026-10-30T12:00:00.000Z");
                const amb = makeSeries({
                    label: "REC arrière",
                    recurrence: "daily",
                    localTime: "01:30",
                    timezone: "America/New_York",
                    durationMinutes: 30,
                    startsOn: "2026-10-30",
                    endsOn: "2026-11-02",
                    groupIds: [g1.id],
                });
                seriesService.generateOccurrences(amb.id);
                const ambHelper = zonedTimeToUtc("2026-11-01", "01:30", "America/New_York");
                ok(
                    "fall back 2026-11-01 01:30 NY : heure reconnue ambiguë, instants déterministe = 1re occurrence (05:30Z EDT)",
                    ambHelper.kind === "ambiguous" &&
                        seriesService.listOccurrences(amb.id).find((r) => r.occurrence_date === "2026-11-01")?.scheduled_at ===
                            "2026-11-01T05:30:00.000Z",
                );

                // 9) Édition depuis une occurrence choisie (changement d'heure).
                fake.set("2026-06-01T12:00:00.000Z");
                const edit = makeSeries({
                    label: "REC édition",
                    recurrence: "weekly",
                    weekday: 1,
                    localTime: "09:00",
                    startsOn: "2026-06-01",
                    groupIds: [g1.id],
                    participants: [{ studentId: ada.id, included: true }],
                });
                seriesService.generateOccurrences(edit.id); // 13 lundis (06-01 → 08-24)
                const rowsOf = () => seriesService.listOccurrences(edit.id);
                const at = (date: string) => rowsOf().find((r) => r.occurrence_date === date)!;
                sessionParticipantRepository.upsert(at("2026-07-13").id, alan.id, false); // override par occurrence
                sessionService.cancel(at("2026-07-20").id); // annulée → préservée
                sessionRepository.start(at("2026-07-27").id); // running (écriture physique, pas de lecteur/WS) → préservée
                const idsBefore = new Map(rowsOf().map((r) => [r.occurrence_date, r.id]));
                const rTime = seriesService.editSeriesFrom(edit.id, "2026-07-06", { localTime: "10:00" });
                const july13 = at("2026-07-13");
                ok(
                    "édition heure 09:00→10:00 dès 07-06 : 6 futures scheduled réécrites à la MÊME identité, IDs conservés",
                    rTime.updated.length === 6 &&
                        rTime.created.length === 0 &&
                        rTime.cancelled.length === 0 &&
                        rTime.updated.every((id) => [...idsBefore.values()].includes(id)) &&
                        idsBefore.get("2026-07-13") === july13.id &&
                        july13.scheduled_at === "2026-07-13T10:00:00.000Z" &&
                        at("2026-08-24").scheduled_at === "2026-08-24T10:00:00.000Z",
                );
                ok(
                    "passé < date choisie intact, running/completed/cancelled préservés intacts (statut ET instant)",
                    at("2026-06-01").scheduled_at === "2026-06-01T09:00:00.000Z" &&
                        at("2026-06-29").scheduled_at === "2026-06-29T09:00:00.000Z" &&
                        at("2026-07-20").status === "cancelled" &&
                        at("2026-07-20").scheduled_at === "2026-07-20T09:00:00.000Z" &&
                        at("2026-07-27").status === "running" &&
                        rTime.preserved.length === 2,
                );
                ok(
                    "override par occurrence conservé (alan exclu sur 07-13) et modèle de série mis à jour",
                    sessionParticipantRepository.listBySession(july13.id).some((d) => d.student_id === alan.id && d.included === 0) &&
                        sessionSeriesRepository.findById(edit.id)!.local_time === "10:00",
                );

                // 10) Lundi → mardi dès 07-13 : annulation du désuet, création du neuf.
                const rDay = seriesService.editSeriesFrom(edit.id, "2026-07-13", { weekday: 2 });
                ok(
                    "lundi→mardi dès 07-13 : 5 lundis scheduled annulés (lignes conservées, historique intact), 6 mardis créés",
                    rDay.cancelled.length === 5 &&
                        rDay.created.length === 6 &&
                        rDay.updated.length === 0 &&
                        at("2026-07-13").status === "cancelled" &&
                        sessionRepository.findById(at("2026-07-13").id) !== undefined &&
                        at("2026-06-29").status === "scheduled" &&
                        rDay.preserved.length === 2,
                );
                const tuesday = at("2026-07-14");
                ok(
                    "mardis créés avec groupes + deltas courants de la série, heure locale éditable conservée",
                    tuesday.scheduled_at === "2026-07-14T10:00:00.000Z" &&
                        sessionRepository.getGroupIds(tuesday.id).includes(g1.id) &&
                        sessionParticipantRepository.listBySession(tuesday.id).some((d) => d.student_id === ada.id && d.included === 1) &&
                        at("2026-08-18").occurrence_date === "2026-08-18" &&
                        rowsOf().every((r) => r.occurrence_date !== "2026-08-25"),
                );

                // 11) Raccourcissement ends_on : le plan futur désuet est annulé.
                const rEnd = seriesService.editSeriesFrom(edit.id, "2026-07-14", { endsOn: "2026-07-31" });
                ok(
                    "ends_on raccourci à 07-31 : mardis 08-04/11/18 annulés, 07-14/21/28 conservés, série mise à jour",
                    rEnd.cancelled.length === 3 &&
                        rEnd.updated.length === 3 &&
                        at("2026-08-04").status === "cancelled" &&
                        at("2026-07-28").status === "scheduled" &&
                        sessionSeriesRepository.findById(edit.id)!.ends_on === "2026-07-31",
                );
                ok(
                    "éditions refusées : série inconnue 404, ancre non-occurrence 404, date invalide 400",
                    rejects(() => seriesService.editSeriesFrom(987654, "2026-06-01", { localTime: "10:00" }), 404, "NOT_FOUND") &&
                        rejects(() => seriesService.editSeriesFrom(edit.id, "2026-06-02", { localTime: "10:00" }), 404, "NOT_FOUND") &&
                        rejects(() => seriesService.editSeriesFrom(edit.id, "2026-02-30", { localTime: "10:00" }), 400, "VALIDATION_ERROR"),
                );

                // 12) Sérialité transactionnelle : échec en plein milieu → tout est annulé.
                db.exec(
                    `CREATE TEMP TRIGGER verify_series_rollback BEFORE INSERT ON app_sessions
                     BEGIN SELECT RAISE(ABORT, 'verify_series_rollback'); END;`,
                );
                let rolledBack = false;
                try {
                    seriesService.editSeriesFrom(edit.id, "2026-07-21", { recurrence: "daily", weekday: null });
                } catch {
                    rolledBack = true;
                } finally {
                    db.exec("DROP TRIGGER verify_series_rollback");
                }
                const seriesAfterRollback = sessionSeriesRepository.findById(edit.id)!;
                ok(
                    "édition interrompue par une erreur SQLite : rien d'écrit (modèle, annulations et créations rollbackés)",
                    rolledBack &&
                        seriesAfterRollback.recurrence === "weekly" &&
                        seriesAfterRollback.weekday === 2 &&
                        seriesAfterRollback.ends_on === "2026-07-31" &&
                        at("2026-07-28").status === "scheduled" &&
                        rowsOf().every((r) => r.occurrence_date !== "2026-07-22"),
                );

                // 13) Série paused : l'édition reprogramme le futur scheduled sans rien créer.
                const pausedEdit = makeSeries({
                    label: "REC pause-édition",
                    recurrence: "weekly",
                    weekday: 1,
                    localTime: "09:00",
                    startsOn: "2026-06-01",
                    groupIds: [g1.id],
                });
                seriesService.generateOccurrences(pausedEdit.id);
                seriesService.setSeriesStatus(pausedEdit.id, "paused");
                const rPaused = seriesService.editSeriesFrom(pausedEdit.id, "2026-07-06", { localTime: "11:00" });
                const rPaused2 = seriesService.editSeriesFrom(pausedEdit.id, "2026-07-13", { weekday: 2 });
                ok(
                    "série paused : futures scheduled mises à jour mais AUCUNE nouvelle occurrence matérialisée",
                    rPaused.updated.length === 8 &&
                        rPaused.created.length === 0 &&
                        rPaused2.created.length === 0 &&
                        rPaused2.cancelled.length === 7,
                );

                // Remise en état physique de la running simulée (plus de tick après cette
                // section : aucun risque d'auto-démarrage, mais on laisse la base cohérente).
                db.prepare("UPDATE app_sessions SET status = 'scheduled', started_at = NULL WHERE id = ?").run(
                    at("2026-07-27").id,
                );
            } finally {
                restoreClock();
            }
        }
        console.log("── 26. Séries récurrentes : API HTTP, calendrier et occurrence (Phase 3) ──");
        {
            const seriesApi = await import("../services/seriesService");
            const dbMod = await import("../db");
            const { setClock } = await import("../core/clock");
            const { FakeClock } = await import("../core/fakeClock");
            const { sessionRepository: sessRepo26 } = await import("../db");

            // Neutralise : aucune session ni série ne doit troubler les ticks
            // ci-dessous (les séries des sections précédentes restent paused).
            for (const s of sessionService.list()) {
                if (s.status === "running") await teacher.call("POST", `/api/sessions/${s.id}/stop`);
                if (s.status === "scheduled") await teacher.call("POST", `/api/sessions/${s.id}/cancel`);
            }
            for (const s of seriesApi.listSeries()) {
                if (s.status === "active") seriesApi.setSeriesStatus(s.id, "paused");
            }

            const fake = new FakeClock("2026-06-01T12:00:00.000Z"); // lundi 1er juin 2026
            const restoreClock = setClock(fake);
            try {
                // ── Authentification et rôles (régression kiosk : lecture seule) ──
                const guest26 = new Client(base);
                res = await guest26.call("GET", "/api/series");
                ok("GET /api/series anonyme → 401 NOT_AUTHENTICATED", res.status === 401 && res.body.error.code === "NOT_AUTHENTICATED");
                res = await guest26.call("POST", "/api/series", { label: "x", localTime: "08:00", startsOn: "2026-06-01", groupIds: [g1.id] });
                ok("POST /api/series anonyme → 401", res.status === 401);
                res = await borne.call("GET", "/api/series");
                ok("GET /api/series avec kiosk → 200 (lecture autorisée)", res.status === 200);
                res = await borne.call("POST", "/api/series", { label: "Interdite", localTime: "08:00", startsOn: "2026-06-01", groupIds: [g1.id] });
                ok("POST /api/series avec kiosk → 403 lecture seule", res.status === 403 && res.body.error.code === "FORBIDDEN");
                res = await borne.call("POST", "/api/series/1/cancel");
                ok("POST /api/series/:id/cancel avec kiosk → 403", res.status === 403);
                res = await borne.call("PATCH", "/api/sessions/1", { label: "x" });
                ok("PATCH /api/sessions/:id avec kiosk → 403 lecture seule", res.status === 403);
                res = await borne.call("GET", "/api/sessions/calendar?from=2026-06-01&to=2026-06-07");
                ok("GET /api/sessions/calendar avec kiosk → 200 (lecture autorisée)", res.status === 200);

                // ── Validation (forme côté route, sémantique côté service) ──
                res = await teacher.call("POST", "/api/series", { label: "Sans localTime", startsOn: "2026-06-01", groupIds: [g1.id] });
                ok("localTime manquant → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
                res = await teacher.call("POST", "/api/series", { localTime: "08:00", startsOn: "2026-06-01", groupIds: [g1.id] });
                ok("label manquant → 400", res.status === 400);
                res = await teacher.call("POST", "/api/series", { label: "x", localTime: "8:30", startsOn: "2026-06-01", groupIds: [g1.id] });
                ok("localTime « 8:30 » → 400 (HH:MM strict)", res.status === 400);
                res = await teacher.call("POST", "/api/series", { label: "x", localTime: "08:00", startsOn: "2026-6-01", groupIds: [g1.id] });
                ok("startsOn « 2026-6-01 » → 400", res.status === 400);
                res = await teacher.call("POST", "/api/series", { label: "x", localTime: "08:00", startsOn: "2026-02-30", groupIds: [g1.id] });
                ok("startsOn 2026-02-30 (jour que SQLite normaliserait) → 400", res.status === 400);
                res = await teacher.call("POST", "/api/series", { label: "x", localTime: "08:00", recurrence: "mensuelle", startsOn: "2026-06-01", groupIds: [g1.id] });
                ok("récurrence invalide → 400", res.status === 400);
                res = await teacher.call("POST", "/api/series", { label: "x", localTime: "08:00", recurrence: "weekly", startsOn: "2026-06-01", groupIds: [g1.id] });
                ok("weekly sans weekday → 400", res.status === 400);
                res = await teacher.call("POST", "/api/series", { label: "x", localTime: "08:00", recurrence: "daily", weekday: 3, startsOn: "2026-06-01", groupIds: [g1.id] });
                ok("daily avec weekday → 400", res.status === 400);
                res = await teacher.call("POST", "/api/series", { label: "x", localTime: "08:00", startsOn: "2026-06-08", endsOn: "2026-06-01", groupIds: [g1.id] });
                ok("endsOn < startsOn → 400", res.status === 400);
                res = await teacher.call("POST", "/api/series", { label: "x", localTime: "08:00", startsOn: "2026-06-01", groupIds: [987654] });
                ok("groupe inexistant → 400", res.status === 400);
                res = await teacher.call("POST", "/api/series", { label: "x", localTime: "08:00", startsOn: "2026-06-01" });
                ok("sans groupIds → 400", res.status === 400);
                res = await teacher.call("POST", "/api/series", { label: "x", localTime: "08:00", startsOn: "2026-06-01", groupIds: [g1.id], scheduledAt: "2026-06-01T08:00:00.000Z" });
                ok("champ inconnu (scheduledAt) → 400", res.status === 400);
                res = await teacher.call("POST", "/api/series", { label: "x", localTime: "08:00", startsOn: "2026-06-01", groupIds: [g1.id], participants: [{ studentId: ada.id, included: "oui" }] });
                ok("participant : included non booléen → 400", res.status === 400);
                res = await teacher.call("POST", "/api/series", { label: "x", localTime: "08:00", startsOn: "2026-06-01", groupIds: [g1.id], participants: [{ studentId: ada.id, included: true, why: "?" }] });
                ok("participant : champ inconnu → 400", res.status === 400);
                res = await teacher.call("POST", "/api/series", { label: "x", localTime: "08:00", startsOn: "2026-06-01", groupIds: [g1.id], participants: [{ studentId: 987654, included: true }] });
                ok("participant : étudiant inconnu → 400 (service)", res.status === 400);
                res = await teacher.call("GET", "/api/series/abc");
                ok("GET /api/series/abc → 400", res.status === 400);
                res = await teacher.call("GET", "/api/series/987654");
                ok("GET série inconnue → 404", res.status === 404 && res.body.error.code === "NOT_FOUND");

                // ── Création, lecture, génération par tick ──
                res = await teacher.call("POST", "/api/series", {
                    label: "API lundi",
                    recurrence: "weekly",
                    weekday: 1,
                    localTime: "08:30",
                    timezone: "UTC",
                    durationMinutes: 45,
                    startsOn: "2026-06-01",
                    groupIds: [g1.id],
                    participants: [{ studentId: alan.id, included: true }],
                });
                const sApi = res.body.data;
                ok(
                    "POST /api/series (teacher) → 201 active, group_ids et patron portés",
                    res.status === 201 &&
                        sApi.status === "active" &&
                        sApi.weekday === 1 &&
                        sApi.local_time === "08:30" &&
                        JSON.stringify(sApi.group_ids) === JSON.stringify([g1.id]),
                );
                res = await teacher.call("GET", `/api/series/${sApi.id}`);
                ok(
                    "GET /api/series/:id → détail avec participants",
                    res.status === 200 &&
                        (res.body.data.participants as any[]).length === 1 &&
                        res.body.data.participants[0].student_id === alan.id &&
                        res.body.data.participants[0].included === 1,
                );
                res = await teacher.call("GET", "/api/series");
                ok(
                    "GET /api/series → liste enrichie (group_ids tableaux)",
                    res.status === 200 &&
                        (res.body.data as any[]).every((s) => Array.isArray(s.group_ids)) &&
                        (res.body.data as any[]).some((s) => s.id === sApi.id),
                );

                scheduler.runSchedulerTick(); // la génération fait partie du tick
                const apiOccs = seriesApi.listOccurrences(sApi.id);
                ok(
                    "génération par tick : 13 lundis (horizon 12 semaines) tous SCHEDULED, aucune session démarrée",
                    apiOccs.length === 13 &&
                        apiOccs[0].occurrence_date === "2026-06-01" &&
                        apiOccs.every((r) => r.status === "scheduled") &&
                        sessionService.getActive() === null,
                );

                // ── GET /api/sessions/calendar ──
                res = await teacher.call("POST", "/api/sessions", { label: "Autonome juin", groupId: g1.id, scheduledAt: "2026-06-01T23:00:00.000Z" });
                const sStandalone = res.body.data;
                res = await teacher.call("GET", "/api/sessions/calendar?to=2026-06-30");
                ok("calendar sans from → 400 (bornes obligatoires)", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
                res = await teacher.call("GET", "/api/sessions/calendar?from=non&to=2026-06-30");
                ok("calendar date invalide → 400", res.status === 400);
                res = await teacher.call("GET", "/api/sessions/calendar?from=2026-02-30&to=2026-03-01");
                ok("calendar date inexistante 2026-02-30 → 400", res.status === 400);
                res = await teacher.call("GET", "/api/sessions/calendar?from=2026-06-30&to=2026-06-01");
                ok("calendar plage inversée → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");

                res = await teacher.call("POST", "/api/series", {
                    label: "API lundi New York",
                    recurrence: "weekly",
                    weekday: 1,
                    localTime: "23:30",
                    timezone: "America/New_York",
                    durationMinutes: 30,
                    startsOn: "2026-06-01",
                    groupIds: [g1.id],
                });
                const sNy = res.body.data;
                seriesApi.generateOccurrences(sNy.id);
                const nyOcc = seriesApi.listOccurrences(sNy.id).find((r) => r.occurrence_date === "2026-06-01")!;
                ok("occurrence fuseau local : 06-01 23:30 New York = 06-02 03:30Z", nyOcc.scheduled_at === "2026-06-02T03:30:00.000Z");
                res = await teacher.call("GET", "/api/sessions/calendar?from=2026-06-01&to=2026-06-01");
                ok(
                    "calendar filtre à la date LOCALE : occurrence New York au 01-06, jamais à une autre date locale",
                    (res.body.data as any[]).some((r) => r.id === nyOcc.id) &&
                        (res.body.data as any[]).every((r) => r.occurrence_date === null || r.occurrence_date === "2026-06-01"),
                );
                res = await teacher.call("GET", "/api/sessions/calendar?from=2026-06-02&to=2026-06-02");
                ok("calendar : l'occurrence New York ABSENTE du 02-06 (son jour UTC) — la date locale fait foi", !(res.body.data as any[]).some((r) => r.id === nyOcc.id));

                res = await teacher.call("GET", "/api/sessions/calendar?from=2026-06-01&to=2026-06-30");
                const june = res.body.data as any[];
                const juneOwn = june.filter((r) => r.series_id === sApi.id);
                const rowJune1 = juneOwn.find((r) => r.occurrence_date === "2026-06-01");
                ok(
                    "calendar juin « API lundi » : 5 lundis triés, métadonnées série + groupes + comptage attendus (2 = groupe + inclusion)",
                    juneOwn.length === 5 &&
                        juneOwn.every((r, i, a) => i === 0 || a[i - 1].scheduled_at <= r.scheduled_at) &&
                        rowJune1.series_label === "API lundi" &&
                        rowJune1.series_status === "active" &&
                        rowJune1.series_recurrence === "weekly" &&
                        rowJune1.local_time === "08:30" &&
                        typeof rowJune1.group_name === "string" &&
                        rowJune1.group_name.includes("G1-bis") &&
                        Array.isArray(rowJune1.group_ids) &&
                        rowJune1.group_ids.length === 1 &&
                        rowJune1.participant_count === 2,
                );
                ok(
                    "calendar : session autonome matchée au jour UTC de scheduled_at (series_id NULL, comptage live = 1)",
                    june.some((r) => r.id === sStandalone.id && r.series_id === null && r.participant_count === 1),
                );

                // ── PATCH /api/sessions/:id (une occurrence scheduled) ──
                res = await teacher.call("PATCH", `/api/sessions/${nyOcc.id}`, { label: "Occurrence déplacée", durationMinutes: 90 });
                ok(
                    "PATCH occurrence scheduled : label/durée modifiés, identité de série intacte",
                    res.status === 200 &&
                        res.body.data.label === "Occurrence déplacée" &&
                        res.body.data.duration_minutes === 90 &&
                        res.body.data.series_id === sNy.id &&
                        res.body.data.occurrence_date === "2026-06-01" &&
                        res.body.data.status === "scheduled",
                );
                res = await teacher.call("PATCH", `/api/sessions/${nyOcc.id}`, { scheduledAt: "2026-06-01T23:30:00.000Z" });
                ok(
                    "PATCH scheduledAt sur occurrence de série → 409 SESSION_OCCURRENCE_MOVE (Phase 5 : l'instant suit le créneau local de la série)",
                    res.status === 409 && res.body.error.code === "SESSION_OCCURRENCE_MOVE",
                );
                ok(
                    "l'occurrence garde son instant d'origine (aucune écriture partielle)",
                    sessRepo26.findById(nyOcc.id)!.scheduled_at === "2026-06-02T03:30:00.000Z",
                );
                res = await teacher.call("PATCH", `/api/sessions/${sStandalone.id}`, { scheduledAt: "2026-06-05T09:00:00.000Z" });
                ok(
                    "PATCH scheduledAt session AUTONOME scheduled → 200 (déplacement hors série toujours permis)",
                    res.status === 200 && res.body.data.scheduled_at === "2026-06-05T09:00:00.000Z",
                );
                res = await teacher.call("PATCH", `/api/sessions/${nyOcc.id}`, {});
                ok("PATCH sans champ → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
                res = await teacher.call("PATCH", `/api/sessions/${nyOcc.id}`, { statut: "running" });
                ok("PATCH champ inconnu → 400", res.status === 400);
                res = await teacher.call("PATCH", "/api/sessions/987654", { label: "x" });
                ok("PATCH session inconnue → 404", res.status === 404 && res.body.error.code === "NOT_FOUND");
                res = await teacher.call("POST", `/api/sessions/${sStandalone.id}/start`);
                ok("démarrage manuel (pour tester le refus PATCH)", res.status === 200 && res.body.data.status === "running");
                res = await teacher.call("PATCH", `/api/sessions/${sStandalone.id}`, { label: "Trop tard" });
                ok("PATCH session running → 409 SESSION_INVALID_TRANSITION", res.status === 409 && res.body.error.code === "SESSION_INVALID_TRANSITION");
                await teacher.call("POST", `/api/sessions/${sStandalone.id}/stop`);

                // ── PATCH /api/series/:id (édition depuis une occurrence) ──
                res = await teacher.call("PATCH", `/api/series/${sApi.id}`, { fromDate: "2026-06-15", localTime: "10:30" });
                const rEdit = res.body.data;
                ok(
                    "PATCH série « à partir de » : 11 futures scheduled réécrites (0 annulée, 0 créée, 0 préservée)",
                    res.status === 200 &&
                        rEdit.updated.length === 11 &&
                        rEdit.cancelled.length === 0 &&
                        rEdit.created.length === 0 &&
                        rEdit.preserved.length === 0 &&
                        rEdit.series.local_time === "10:30",
                );
                const occJune8 = seriesApi.listOccurrences(sApi.id).find((r) => r.occurrence_date === "2026-06-08")!;
                const occJune15 = seriesApi.listOccurrences(sApi.id).find((r) => r.occurrence_date === "2026-06-15")!;
                ok(
                    "instants réécrits : 06-15 à 10:30, 06-08 (avant l'ancre) intact à 08:30",
                    occJune15.scheduled_at === "2026-06-15T10:30:00.000Z" && occJune8.scheduled_at === "2026-06-08T08:30:00.000Z",
                );
                res = await teacher.call("PATCH", `/api/series/${sApi.id}`, { fromDate: "2026-06-16", localTime: "11:00" });
                ok("ancre sans occurrence (mardi) → 404 NOT_FOUND", res.status === 404 && res.body.error.code === "NOT_FOUND");
                res = await teacher.call("PATCH", `/api/series/${sApi.id}`, { fromDate: "2026-02-30", localTime: "11:00" });
                ok("fromDate invalide → 400", res.status === 400);
                res = await teacher.call("PATCH", `/api/series/${sApi.id}`, { fromDate: "2026-06-15", participants: [{ studentId: ada.id, included: true }] });
                ok(
                    "PATCH série « participants » éditable (Phase 5) → 200, les 11 scheduled ≥ ancre réécrites",
                    res.status === 200 && (res.body.data.updated as number[]).length === 11,
                );
                res = await teacher.call("GET", `/api/series/${sApi.id}`);
                ok(
                    "deltas série REMPLACÉS : l'inclusion d'alan a disparu, seule celle d'ada porte",
                    res.status === 200 &&
                        (res.body.data.participants as any[]).length === 1 &&
                        res.body.data.participants[0].student_id === ada.id &&
                        res.body.data.participants[0].included === 1,
                );
                res = await teacher.call("PATCH", "/api/series/987654", { fromDate: "2026-06-15", localTime: "11:00" });
                ok("PATCH série inconnue → 404", res.status === 404);

                // ── Pause / reprise ──
                res = await teacher.call("POST", "/api/series", { label: "API pause", recurrence: "daily", localTime: "07:00", startsOn: "2026-06-01", groupIds: [g1.id] });
                const sPause = res.body.data;
                scheduler.runSchedulerTick();
                const countPaused0 = seriesApi.listOccurrences(sPause.id).length;
                ok("tick : génération horizon de « API pause » (> 80 quotidiennes)", countPaused0 > 80);
                res = await teacher.call("POST", `/api/series/${sPause.id}/pause`);
                ok("POST /api/series/:id/pause → paused", res.status === 200 && res.body.data.status === "paused");
                fake.set("2026-06-15T12:00:00.000Z");
                scheduler.runSchedulerTick();
                ok("série paused : le tick ne matérialise rien de nouveau", seriesApi.listOccurrences(sPause.id).length === countPaused0);
                res = await teacher.call("POST", `/api/series/${sPause.id}/resume`);
                ok("POST /api/series/:id/resume → active", res.status === 200 && res.body.data.status === "active");
                scheduler.runSchedulerTick();
                ok("série reprise : horizon roulant prolongé (nouvelles occurrences)", seriesApi.listOccurrences(sPause.id).length > countPaused0);

                // ── Annulation de la série : futur planifié annulé, historique intact ──
                const occs26 = seriesApi.listOccurrences(sApi.id);
                const at26 = (d: string) => occs26.find((r) => r.occurrence_date === d)!;
                const oDone = at26("2026-06-01");
                const oRunning = at26("2026-06-08");
                const oAlready = at26("2026-06-22");
                sessRepo26.start(oDone.id);
                sessRepo26.complete(oDone.id);
                dbMod.attendanceRepository.recordScan({ sessionId: oDone.id, studentId: ada.id, uid: "123" });
                sessRepo26.start(oRunning.id); // running (repository, pas de boucle/WS)
                await sessionService.cancel(oAlready.id);
                // l'horizon roulant a pu matérialiser des lundis supplémentaires entre-temps : attendu dynamique
                const expectedCancelled = seriesApi
                    .listOccurrences(sApi.id)
                    .filter((r) => r.status === "scheduled" && (r.occurrence_date ?? "") >= "2026-06-15").length;
                res = await teacher.call("POST", `/api/series/${sApi.id}/cancel`);
                const rCancel = res.body.data;
                ok(
                    "POST /api/series/:id/cancel → cancelled ET toutes les occurrences futures scheduled annulées",
                    res.status === 200 &&
                        rCancel.series.status === "cancelled" &&
                        expectedCancelled >= 10 &&
                        rCancel.cancelled.length === expectedCancelled &&
                        (rCancel.cancelled as number[]).every((id) => sessRepo26.findById(id)!.status === "cancelled"),
                );
                ok(
                    "annulation de série : running / completed / déjà-annulée PRÉSERVÉES, présence historique conservée",
                    sessRepo26.findById(oRunning.id)!.status === "running" &&
                        sessRepo26.findById(oDone.id)!.status === "completed" &&
                        sessRepo26.findById(oAlready.id)!.status === "cancelled" &&
                        (dbMod.db.prepare("SELECT COUNT(*) AS c FROM app_attendances WHERE session_id = ?").get(oDone.id) as { c: number }).c === 1,
                );
                res = await teacher.call("POST", `/api/series/${sApi.id}/cancel`);
                ok("seconde annulation → 409 SERIES_CANCELLED", res.status === 409 && res.body.error.code === "SERIES_CANCELLED");
                res = await teacher.call("POST", `/api/series/${sApi.id}/resume`);
                ok("reprise après annulation → 409 SERIES_CANCELLED", res.status === 409 && res.body.error.code === "SERIES_CANCELLED");
                res = await teacher.call("PATCH", `/api/series/${sApi.id}`, { fromDate: "2026-07-06", localTime: "09:00" });
                ok("édition après annulation → 409 SERIES_CANCELLED", res.status === 409 && res.body.error.code === "SERIES_CANCELLED");

                // ── Régression : endpoints existants inchangés ──
                res = await teacher.call("GET", "/api/sessions");
                ok("régression GET /api/sessions : group_ids toujours exposés", res.status === 200 && (res.body.data as any[]).every((s) => Array.isArray(s.group_ids)));
                res = await teacher.call("GET", "/api/reports/sessions");
                ok("régression GET /api/reports/sessions : réponse inchangée", res.status === 200 && Array.isArray(res.body.data));
            } finally {
                restoreClock();
            }
        }

        console.log("── 27. Roster figé au démarrage : reporting, scans, marquage manuel, rollback ──");
        {
            const dbMod = await import("../db");
            const { sessionParticipantRepository: participants27 } = await import("../db");
            const { setClock } = await import("../core/clock");
            const { FakeClock } = await import("../core/fakeClock");

            for (const s of sessionService.list()) {
                if (s.status === "running") await teacher.call("POST", `/api/sessions/${s.id}/stop`);
                if (s.status === "scheduled") await teacher.call("POST", `/api/sessions/${s.id}/cancel`);
            }

            const fake = new FakeClock("2026-06-01T12:00:00.000Z");
            const restoreClock = setClock(fake);
            try {
                res = await teacher.call("POST", "/api/groups", { name: "G-FREEZE" });
                const gF = res.body.data;
                res = await teacher.call("POST", "/api/groups", { name: "G-AUTRE" });
                const gA = res.body.data;
                res = await teacher.call("POST", "/api/students", { firstName: "Rosa", lastName: " exclusion", groupId: gF.id });
                const rosa = res.body.data;
                res = await teacher.call("POST", "/api/students", { firstName: "Marco", groupId: gF.id });
                const marco = res.body.data;
                res = await teacher.call("POST", "/api/students", { firstName: "Iris" });
                const iris = res.body.data;
                res = await teacher.call("POST", "/api/students", { firstName: "Noé", groupId: gA.id });
                const noe = res.body.data;

                res = await teacher.call("POST", "/api/sessions", { label: "Roster figé", groupId: gF.id });
                const sF = res.body.data;
                participants27.upsert(sF.id, iris.id, true); // inclusion hors groupe
                participants27.upsert(sF.id, rosa.id, false); // exclusion malgré le groupe

                res = await teacher.call("POST", `/api/sessions/${sF.id}/start`);
                ok(
                    "start : roster_frozen_at posé dans la transaction de transition",
                    res.status === 200 && res.body.data.status === "running" && res.body.data.roster_frozen_at !== null,
                );
                const frozen = dbMod.sessionRosterRepository.listBySession(sF.id).map((r) => r.full_name).sort();
                ok(
                    "instantané = groupes ∪ inclusions − exclusions, dédupliqué (Marco + Iris ; Rosa exclue, Noé jamais présent)",
                    JSON.stringify(frozen) === JSON.stringify(["Iris", "Marco"]),
                );
                ok(
                    "noms dénormalisés dans l'instantané (groupe figé, NULL hors groupe)",
                    dbMod.sessionRosterRepository.listBySession(sF.id).every((r) =>
                        r.full_name === "Marco" ? r.group_name === "G-FREEZE" : r.group_name === null,
                    ),
                );

                res = await teacher.call("GET", `/api/reports/sessions/${sF.id}`);
                ok(
                    "reporting sur roster figé : total 2 (inclusion comptée, exclusion retirée), 0 présent",
                    res.status === 200 && res.body.data.summary.total === 2 && res.body.data.summary.absent === 2 && res.body.data.summary.present === 0,
                );

                // Scans : la portée attendue suit le roster (inclusion/exclusion).
                await teacher.call("POST", `/api/students/${iris.id}/card`, { uid: "7810001" });
                await teacher.call("POST", `/api/students/${rosa.id}/card`, { uid: "7810002" });
                await teacher.call("POST", `/api/students/${noe.id}/card`, { uid: "7810003" });
                const scanIris = attendanceService.handleScan("7810001");
                ok("scan étudiant INCLUSE hors groupes → accepted (pas out_of_group)", scanIris.result === "accepted" && scanIris.studentId === iris.id);
                const scanRosa = attendanceService.handleScan("7810002");
                ok("scan étudiant EXCLUE malgré son groupe → out_of_group", scanRosa.result === "out_of_group" && scanRosa.studentId === rosa.id);
                const scanNoe = attendanceService.handleScan("7810003");
                ok("scan étudiant étranger (régression Phase 10) → out_of_group", scanNoe.result === "out_of_group");

                // Marquage manuel : correction explicite, hors portée assumée.
                res = await teacher.call("POST", `/api/sessions/${sF.id}/attendance/manual`, { studentId: rosa.id });
                ok("marquage manuel de l'exclue → 200 (override du roster)", res.status === 200 && res.body.data.result === "manual");
                res = await teacher.call("GET", `/api/sessions/${sF.id}/attendance`);
                ok("régression liste de présence (scanneurs seuls) : Iris + Rosa", (res.body.data as any[]).length === 2);
                res = await teacher.call("GET", `/api/reports/sessions/${sF.id}`);
                const frozenReport = res.body.data;
                ok(
                    "reporting : présent 2 (Iris scan, Rosa manuelle) / absent 1 / total 3 (présence hors roster ajoutée)",
                    frozenReport.summary.present === 2 && frozenReport.summary.absent === 1 && frozenReport.summary.total === 3,
                );

                // Le roster figé survit aux éditions postérieures du groupe.
                await teacher.call("PATCH", `/api/students/${marco.id}`, { groupId: gA.id });
                await teacher.call("PATCH", `/api/students/${iris.id}`, { groupId: gA.id });
                res = await teacher.call("GET", `/api/reports/sessions/${sF.id}`);
                const afterMoves = res.body.data;
                ok(
                    "roster figé autoritaire : Marco/Iris restent planifiés (total 3) même après changement de groupe",
                    afterMoves.summary.total === 3 &&
                        (afterMoves.rows as any[]).find((r) => r.student_id === marco.id)?.group_name === "G-FREEZE" &&
                        (afterMoves.rows as any[]).find((r) => r.student_id === iris.id)?.group_name === null,
                );

                // Export CSV sur le roster figé.
                {
                    const csvRes = await fetch(`${base}/api/reports/sessions/${sF.id}/export`, { headers: { cookie: teacher.cookie! } });
                    const csvText = new TextDecoder("utf-8").decode(await csvRes.arrayBuffer());
                    ok(
                        "régression export CSV sur roster figé : en-têtes stables + 3 lignes (inclusion et hors-roster incluses)",
                        csvRes.status === 200 &&
                            csvText.startsWith("Nom,Prénom,Numéro étudiant,Groupe,Présence,Heure du premier scan") &&
                            csvText.trim().split("\r\n").length === 4 &&
                            csvText.includes("Iris") &&
                            csvText.includes("Rosa") &&
                            csvText.split("\r\n").some((line) => line.includes("Marco") && line.includes("Absent(e)")),
                    );
                }
                res = await borne.call("GET", `/api/reports/sessions/${sF.id}`);
                ok("régression kiosk : lecture du rapport sur session à roster", res.status === 200 && res.body.data.summary.total === 3);

                res = await teacher.call("POST", `/api/sessions/${sF.id}/stop`);
                ok("stop → completed, roster_frozen_at conservé", res.status === 200 && res.body.data.status === "completed" && res.body.data.roster_frozen_at !== null);

                // ── Fallback legacy : session jamais figée (démarrée par la repo) ──
                res = await teacher.call("POST", "/api/groups", { name: "G-LEGACY27" });
                const gLegacy = res.body.data;
                res = await teacher.call("POST", "/api/students", { firstName: "Léa", groupId: gLegacy.id });
                const lea = res.body.data;
                res = await teacher.call("POST", "/api/students", { firstName: "Lou", groupId: gLegacy.id });
                const lou = res.body.data;
                res = await teacher.call("POST", "/api/sessions", { label: "Legacy roster", groupId: gLegacy.id });
                const sLegacy = res.body.data;
                dbMod.sessionRepository.start(sLegacy.id); // chemin brut repository : pas de service
                dbMod.attendanceRepository.recordScan({ sessionId: sLegacy.id, studentId: lea.id, uid: "124" });
                res = await teacher.call("GET", `/api/sessions/${sLegacy.id}`);
                ok("session démarrée par la repository : roster_frozen_at reste NULL", res.status === 200 && res.body.data.roster_frozen_at === null);
                res = await teacher.call("GET", `/api/reports/sessions/${sLegacy.id}`);
                ok(
                    "fallback legacy (aucun roster) : report = UNION live des groupes (2, dont 1 présent)",
                    res.body.data.summary.total === 2 && res.body.data.summary.present === 1 && res.body.data.summary.absent === 1,
                );
                await teacher.call("POST", `/api/sessions/${sLegacy.id}/stop`);

                // ── Rollback atomique : capture interrompue = rien d'écrit ──
                res = await teacher.call("POST", "/api/sessions", { label: "Rollback roster", groupId: gLegacy.id });
                const sRoll = res.body.data;
                dbMod.db.exec(
                    `CREATE TEMP TRIGGER verify_roster_rollback BEFORE INSERT ON session_roster
                     BEGIN SELECT RAISE(ABORT, 'verify_roster_rollback'); END;`,
                );
                try {
                    res = await teacher.call("POST", `/api/sessions/${sRoll.id}/start`);
                } finally {
                    dbMod.db.exec("DROP TRIGGER verify_roster_rollback");
                }
                ok(
                    "start interrompu par une erreur SQLite → erreur propre sans détail interne (400 CONSTRAINT_VIOLATED)",
                    (res.status === 400 && res.body.error.code === "CONSTRAINT_VIOLATED") ||
                        (res.status === 500 && res.body.error.code === "INTERNAL"),
                );
                res = await teacher.call("GET", `/api/sessions/${sRoll.id}`);
                ok(
                    "rollback complet : session restée scheduled, roster_frozen_at NULL, aucune ligne de roster",
                    res.status === 200 &&
                        res.body.data.status === "scheduled" &&
                        res.body.data.roster_frozen_at === null &&
                        dbMod.sessionRosterRepository.countBySession(sRoll.id) === 0,
                );
                ok("aucune boucle de scan lancée pour la transition annulée", (await sessionService.getActive())?.id !== sRoll.id);
                res = await teacher.call("POST", `/api/sessions/${sRoll.id}/start`);
                ok("start rejoué après la panne (sans trigger) → 200", res.status === 200 && res.body.data.status === "running");
                await teacher.call("POST", `/api/sessions/${sRoll.id}/stop`);

                // ── Régression : transitions de session inchangées ──
                res = await teacher.call("POST", "/api/sessions", { label: "Cycle 27", groupId: gLegacy.id });
                const sA = res.body.data;
                res = await teacher.call("POST", "/api/sessions", { label: "Attente 27", groupId: gLegacy.id });
                const sB = res.body.data;
                res = await teacher.call("POST", `/api/sessions/${sA.id}/start`);
                ok("régression start → running", res.status === 200 && res.body.data.status === "running");
                res = await teacher.call("POST", `/api/sessions/${sA.id}/start`);
                ok("régression double start → 409 SESSION_ALREADY_RUNNING", res.status === 409 && res.body.error.code === "SESSION_ALREADY_RUNNING");
                res = await teacher.call("POST", `/api/sessions/${sB.id}/start`);
                ok("régression seconde session → 409 SESSION_ANOTHER_RUNNING (mono-lecteur)", res.status === 409 && res.body.error.code === "SESSION_ANOTHER_RUNNING");
                res = await teacher.call("POST", `/api/sessions/${sA.id}/stop`);
                ok("régression stop → completed", res.status === 200 && res.body.data.status === "completed");
                res = await teacher.call("POST", `/api/sessions/${sA.id}/stop`);
                ok("régression double stop → 409", res.status === 409 && res.body.error.code === "SESSION_NOT_RUNNING");
                res = await teacher.call("POST", `/api/sessions/${sB.id}/cancel`);
                ok("régression cancel scheduled → cancelled", res.status === 200 && res.body.data.status === "cancelled");
            } finally {
                restoreClock();
            }
        }

        console.log("── 28. Scheduler : génération roulante au démarrage/tick, isolation des échecs ──");
        {
            const dbMod = await import("../db");
            const series28 = await import("../services/seriesService");
            const scheduler28 = await import("../services/schedulerService");
            const { setClock } = await import("../core/clock");
            const { FakeClock } = await import("../core/fakeClock");
            const { setLogSink } = await import("../core/logger");
            const root28 = dbMod.userRepository.findByUsername("root")!;

            // Silence total : aucune session en cours/programmée, aucune série
            // active hormis celles créées ici.
            for (const s of sessionService.list()) {
                if (s.status === "running") await teacher.call("POST", `/api/sessions/${s.id}/stop`);
                if (s.status === "scheduled") await teacher.call("POST", `/api/sessions/${s.id}/cancel`);
            }
            for (const s of series28.listSeries()) {
                if (s.status === "active") series28.setSeriesStatus(s.id, "paused");
            }

            const g28 = dbMod.groupRepository.create("G-SCHED28");
            dbMod.studentRepository.create({ firstName: "S28", groupId: g28.id });

            const fake = new FakeClock("2026-07-01T00:00:00.000Z");
            const restoreClock = setClock(fake);
            const captured: Array<{ level: string; record: any }> = [];
            const restoreSink = setLogSink((line, level, record) => captured.push({ level, record }));
            try {
                const sessionsOf = (seriesId: number) => series28.listOccurrences(seriesId);
                const countSessions = () => (dbMod.db.prepare("SELECT COUNT(*) AS c FROM app_sessions").get() as { c: number }).c;

                // 1) Le hook de démarrage matérialise l'horizon… en SCHEDULED seulement.
                const daily28 = series28.createSeries({
                    label: "SCHED28 quotidien",
                    recurrence: "daily",
                    localTime: "07:00",
                    timezone: "UTC",
                    durationMinutes: 10,
                    startsOn: "2026-07-01",
                    groupIds: [g28.id],
                    createdBy: root28.id,
                });
                scheduler28.runSeriesGeneration(); // appelé par startSessionScheduler au boot
                const genDaily = sessionsOf(daily28.id);
                ok(
                    "démarrage : runSeriesGeneration matérialise l'horizon roulant, toutes SCHEDULED, rien de démarré",
                    genDaily.length >= 30 && genDaily.every((r) => r.status === "scheduled") && sessionService.getActive() === null,
                );

                // 2) Le tick génère (fenêtre pas encore ouverte → pas de démarrage).
                const weekly28 = series28.createSeries({
                    label: "SCHED28 lundi",
                    recurrence: "weekly",
                    weekday: 1,
                    localTime: "09:00",
                    timezone: "UTC",
                    durationMinutes: 45,
                    startsOn: "2026-07-01",
                    groupIds: [g28.id],
                    createdBy: root28.id,
                });
                scheduler28.runSchedulerTick();
                const genWeekly = sessionsOf(weekly28.id);
                ok(
                    "tick : les lundis sont générés d'avance (première occurrence 07-06), aucune démarrée",
                    genWeekly.length >= 8 && genWeekly[0].occurrence_date === "2026-07-06" && sessionService.getActive() === null,
                );

                // 3) Fenêtre atteinte → l'occurrence démarre automatiquement, roster figé.
                fake.set("2026-07-06T09:00:00.000Z");
                scheduler28.runSchedulerTick();
                const occStart = sessionsOf(weekly28.id).find((r) => r.occurrence_date === "2026-07-06")!;
                const rowStart = sessionService.get(occStart.id);
                ok(
                    "tick à la fenêtre de l'occurrence : démarrage automatique + roster figé (groupe copié)",
                    rowStart.status === "running" && rowStart.roster_frozen_at !== null && dbMod.sessionRosterRepository.countBySession(occStart.id) === 1,
                );
                ok("mono-lecteur : exactement une running après le tick", sessionService.list().filter((s) => s.status === "running").length === 1);

                // 4) Fin de fenêtre → arrêt automatique (auto_end), toujours sous génération active.
                fake.set("2026-07-06T09:45:00.000Z");
                scheduler28.runSchedulerTick();
                ok("fin de fenêtre : arrêt automatique (auto_end)", sessionService.get(occStart.id).status === "completed");

                // 5) Occurrence générée d'avance dont la fenêtre est déjà passée :
                //    pas de rattrapage, même produite par la génération du tick.
                fake.set("2026-07-13T12:00:00.000Z");
                scheduler28.runSchedulerTick();
                const occ13 = sessionsOf(weekly28.id).find((r) => r.occurrence_date === "2026-07-13");
                ok("pas de rattrapage pour une occurrence déjà écoulée à sa génération", occ13 !== undefined && sessionService.get(occ13.id).status === "scheduled");

                // 6) Isolation des échecs : une série cassée ne bloque JAMAIS le tick.
                const broken = series28.createSeries({
                    label: "SCHED28 cassé",
                    recurrence: "daily",
                    localTime: "08:00",
                    timezone: "UTC",
                    durationMinutes: 30,
                    startsOn: "2026-07-01",
                    groupIds: [g28.id],
                    createdBy: root28.id,
                });
                dbMod.db.prepare("UPDATE session_series SET timezone = ? WHERE id = ?").run("Not/AZone", broken.id); // fuseau invalide (contournement SQL)
                res = await teacher.call("POST", "/api/sessions", { label: "Fenêtre 28", groupId: g28.id, scheduledAt: "2026-07-13T12:00:00.000Z", durationMinutes: 30 });
                const sWindow = res.body.data;
                captured.length = 0;
                scheduler28.runSchedulerTick(); // ne doit PAS lever
                ok(
                    "série cassée (fuseau invalide) : warn series.generation_failed journalisée avec series_id",
                    captured.some((c) => c.level === "warn" && c.record.event === "series.generation_failed" && c.record.series_id === broken.id),
                );
                ok(
                    "tick insensible à la série cassée : la session dans sa fenêtre démarre quand même (mono-lecteur respecté)",
                    sessionService.get(sWindow.id).status === "running" &&
                        sessionService.list().filter((s) => s.status === "running").length === 1,
                );

                // 7) Aucune série active : la génération ne crée AUCUNE session
                //    (le démarrage ne peut donc jamais en inventer ni en démarrer).
                await teacher.call("POST", `/api/sessions/${sWindow.id}/stop`);
                for (const s of series28.listSeries()) {
                    if (s.status === "active") series28.setSeriesStatus(s.id, "paused");
                }
                const countBefore = countSessions();
                scheduler28.runSeriesGeneration();
                ok(
                    "aucune série active : génération = aucune session créée, aucune démarrée (démarrage inerte)",
                    countSessions() === countBefore && sessionService.getActive() === null,
                );
            } finally {
                restoreSink();
                restoreClock();
            }
        }

        console.log("── 29. Phase 4 : contrats du planning hebdomadaire consommés par le client ──");
        {
            const dbMod = await import("../db");
            const series29 = await import("../services/seriesService");
            const { setClock } = await import("../core/clock");
            const { FakeClock } = await import("../core/fakeClock");

            // Silence : rien d'autre ne doit polluer les fenêtres du calendrier.
            for (const s of sessionService.list()) {
                if (s.status === "running") await teacher.call("POST", `/api/sessions/${s.id}/stop`);
                if (s.status === "scheduled") await teacher.call("POST", `/api/sessions/${s.id}/cancel`);
            }
            for (const s of series29.listSeries()) {
                if (s.status === "active") series29.setSeriesStatus(s.id, "paused");
            }

            // Vendredi 20 mars 2026 : le passage à l'heure d'été européen tombe
            // le 29 mars EN PLEIN HORIZON — la navigation du calendrier et
            // l'heure murale doivent rester correctes de part et d'autre.
            const fake = new FakeClock("2026-03-20T12:00:00.000Z");
            const restoreClock = setClock(fake);
            try {
                res = await teacher.call("POST", "/api/groups", { name: "G-CAL29" });
                const g29 = res.body.data;
                res = await teacher.call("POST", "/api/series", {
                    label: "Mercredi 29",
                    recurrence: "weekly",
                    weekday: 3,
                    localTime: "08:30",
                    timezone: "Europe/Paris",
                    durationMinutes: 60,
                    startsOn: "2026-03-04", // passé : l'horizon part d'aujourd'hui
                    groupIds: [g29.id],
                });
                ok("POST /api/series (schéma exact du formulaire Phase 4) → 201", res.status === 201);
                const s29 = res.body.data;
                const gen29 = series29.generateOccurrences(s29.id);
                const occ29 = series29.listOccurrences(s29.id);
                const at = (d: string) => occ29.find((r) => r.occurrence_date === d)!;
                ok(
                    "horizon roulant 12 semaines dès aujourd'hui : 12 mercredis, premier 2026-03-25, tous scheduled",
                    gen29.created.length === 12 &&
                        occ29.length === 12 &&
                        occ29[0].occurrence_date === "2026-03-25" &&
                        occ29.every((r) => r.status === "scheduled"),
                );
                ok(
                    "affichage fuseau : 08:30 heure murale DE PART ET D'AUTRE du passage à l'heure d'été, instants UTC décalés (07:30Z puis 06:30Z)",
                    at("2026-03-25").scheduled_at === "2026-03-25T07:30:00.000Z" &&
                        at("2026-04-01").scheduled_at === "2026-04-01T06:30:00.000Z" &&
                        at("2026-04-01").local_time === "08:30" &&
                        at("2026-04-01").timezone === "Europe/Paris",
                );

                // ── Navigation par semaine (le client envoie lundi…dimanche) ──
                res = await teacher.call("GET", "/api/sessions/calendar?from=2026-03-23&to=2026-03-29");
                const weekA = (res.body.data as any[]).filter((r) => r.series_id === s29.id);
                ok(
                    "navigation semaine inclusive [lun–dim] : exactement le mercredi 25, forme UI (group_ids tableau, participant_count numérique)",
                    res.status === 200 &&
                        weekA.length === 1 &&
                        weekA[0].occurrence_date === "2026-03-25" &&
                        Array.isArray(weekA[0].group_ids) &&
                        typeof weekA[0].participant_count === "number",
                );
                res = await teacher.call("GET", "/api/sessions/calendar?from=2026-03-25&to=2026-03-25");
                ok("navigation : fenêtre d'une seule journée inclut ses deux bornes", (res.body.data as any[]).some((r) => r.id === at("2026-03-25").id));
                res = await teacher.call("GET", "/api/sessions/calendar?from=2026-03-16&to=2026-03-22");
                ok("navigation semaine précédente (avant la première occurrence) : semaine vide côté série", !(res.body.data as any[]).some((r) => r.series_id === s29.id));

                // ── Édition d'UNE occurrence : la géométrie remonte au calendrier ──
                res = await teacher.call("PATCH", `/api/sessions/${at("2026-03-25").id}`, {
                    durationMinutes: 90,
                    label: "Mercredi 29 — prolongé",
                });
                ok("PATCH /api/sessions/:id occurrence scheduled → 200", res.status === 200 && res.body.data.status === "scheduled");
                res = await teacher.call("GET", "/api/sessions/calendar?from=2026-03-23&to=2026-03-29");
                const row25 = (res.body.data as any[]).find((r) => r.id === at("2026-03-25").id);
                ok(
                    "rechargement du calendrier : durée 90 visible, identité de série intacte (série toujours active)",
                    row25.duration_minutes === 90 &&
                        row25.label === "Mercredi 29 — prolongé" &&
                        row25.series_id === s29.id &&
                        row25.occurrence_date === "2026-03-25" &&
                        row25.series_status === "active",
                );

                // ── « Cette occurrence et les suivantes » (PATCH /api/series/:id) ──
                res = await teacher.call("PATCH", `/api/series/${s29.id}`, {
                    fromDate: "2026-03-25", // date de l'occurrence cliquée
                    durationMinutes: 45,
                });
                const rEdit = res.body.data;
                ok(
                    "édition série depuis l'occurrence : les 12 scheduled ≥ ancre réécrites (0 créée, 0 annulée), modèle à 45 min",
                    res.status === 200 &&
                        rEdit.updated.length === 12 &&
                        rEdit.created.length === 0 &&
                        rEdit.cancelled.length === 0 &&
                        rEdit.skipped.length === 0 &&
                        rEdit.series.duration_minutes === 45,
                );
                ok(
                    "aucune occurrence avant l'ancre n'existait (starts_on passé, horizon) : rien de préservé ni d'écrasé",
                    rEdit.preserved.length === 0,
                );
                res = await teacher.call("GET", "/api/sessions/calendar?from=2026-03-30&to=2026-04-05");
                const rowApr1 = (res.body.data as any[]).find((r) => r.id === at("2026-04-01").id);
                ok("l'occurrence suivante vue du calendrier porte la nouvelle durée (45 min, heure murale inchangée)", rowApr1.duration_minutes === 45 && rowApr1.local_time === "08:30");

                // ── Annulation de la série À PARTIR de cette occurrence (body from) ──
                const expectedFuture = occ29.filter((r) => (r.occurrence_date ?? "") >= "2026-04-08").length;
                res = await teacher.call("POST", `/api/series/${s29.id}/cancel`, { from: "2026-04-08" });
                const rCancel = res.body.data;
                ok(
                    "POST /api/series/:id/cancel {from} → modèle annulé ET exactement les scheduled ≥ from annulées",
                    res.status === 200 &&
                        rCancel.series.status === "cancelled" &&
                        rCancel.cancelled.length === expectedFuture &&
                        (rCancel.cancelled as number[]).every((id) => dbMod.sessionRepository.findById(id)!.status === "cancelled"),
                );
                ok(
                    "l'occurrence du 04-01, AVANT la date `from`, reste programmée (annulation à partir de, pas rétroactive)",
                    dbMod.sessionRepository.findById(at("2026-04-01").id)!.status === "scheduled",
                );
                res = await teacher.call("POST", `/api/series/${s29.id}/cancel`);
                ok("seconde annulation de la série → 409 SERIES_CANCELLED (bouton rejoué)", res.status === 409 && res.body.error.code === "SERIES_CANCELLED");
                res = await teacher.call("POST", `/api/series/${s29.id}/resume`);
                ok("reprise après annulation → 409 SERIES_CANCELLED", res.status === 409);

                // ── Autorisation : le compte borne ne planifie pas ──
                res = await borne.call("POST", `/api/series/${s29.id}/pause`);
                ok("POST /api/series/:id/pause avec kiosk → 403 lecture seule", res.status === 403 && res.body.error.code === "FORBIDDEN");

                // ── Régressions : endpoints historiques intacts après Phase 4 ──
                res = await teacher.call("GET", "/api/sessions");
                ok("régression GET /api/sessions : group_ids partout", res.status === 200 && (res.body.data as any[]).every((s) => Array.isArray(s.group_ids)));
                res = await teacher.call("GET", "/api/reports/sessions");
                ok("régression GET /api/reports/sessions : 200 tableau", res.status === 200 && Array.isArray(res.body.data));

                // Rangement : les deux occurrences restées scheduled ne doivent
                // pas pouvoir s'auto-démarrer plus tard.
                for (const o of series29.listOccurrences(s29.id)) {
                    if (o.status === "scheduled") await teacher.call("POST", `/api/sessions/${o.id}/cancel`);
                }
            } finally {
                restoreClock();
            }
        }

        console.log("── 30. Phase 5 : provenance des appartenances, propagation d'édition, resync WS ──");
        {
            const db30 = await import("../db");
            const series30 = await import("../services/seriesService");
            const { setClock } = await import("../core/clock");
            const { FakeClock } = await import("../core/fakeClock");
            const { sessionParticipantRepository: deltas30, sessionRepository: sessRepo30, sessionRosterRepository: roster30 } = db30;

            // Silence : rien d'autre ne doit troubler ticks ni diffusions.
            for (const s of sessionService.list()) {
                if (s.status === "running") await teacher.call("POST", `/api/sessions/${s.id}/stop`);
                if (s.status === "scheduled") await teacher.call("POST", `/api/sessions/${s.id}/cancel`);
            }
            for (const s of series30.listSeries()) {
                if (s.status === "active") series30.setSeriesStatus(s.id, "paused");
            }

            const fake = new FakeClock("2026-06-01T12:00:00.000Z"); // lundi 1er juin 2026
            const restoreClock = setClock(fake);

            // Le point de vue du client du calendrier : on écoute series:changed.
            const { WebSocket } = await import("ws");
            const ws30 = new WebSocket(`ws://127.0.0.1:${httpPort}/ws`, { headers: { cookie: teacher.cookie ?? "" } });
            ws30.on("error", () => { /* la clôture en finally suffit */ });
            const seriesEvents: any[] = [];
            ws30.on("message", (m: Buffer) => {
                const msg = JSON.parse(m.toString());
                if (msg.event === "series:changed") seriesEvents.push(msg.content);
            });
            const eventSeen = (pred: (e: any) => boolean): Promise<any> =>
                new Promise((resolve, reject) => {
                    const t0 = Date.now();
                    const poll = (): void => {
                        const hit = seriesEvents.find(pred);
                        if (hit) resolve(hit);
                        else if (Date.now() - t0 > 3000) reject(new Error("timeout series:changed"));
                        else setTimeout(poll, 25);
                    };
                    poll();
                });
            const generatedCount = (sid: number): number =>
                seriesEvents.filter((e) => e.action === "generated" && e.series_id === sid).length;

            try {
                // Données dédiées
                res = await teacher.call("POST", "/api/groups", { name: "G-P5A" });
                const gA = res.body.data;
                res = await teacher.call("POST", "/api/groups", { name: "G-P5B" });
                const gB = res.body.data;
                res = await teacher.call("POST", "/api/students", { firstName: "Ines", lastName: "P5", groupId: gA.id });
                const ines = res.body.data;
                res = await teacher.call("POST", "/api/students", { firstName: "Nino", lastName: "P5" }); // hors groupe
                const nino = res.body.data;
                res = await teacher.call("POST", "/api/students", { firstName: "Lova", lastName: "P5", groupId: gA.id });
                const lova = res.body.data;

                // ── création + génération : la provenance est écrite ──
                res = await teacher.call("POST", "/api/series", {
                    label: "P5 lundi",
                    recurrence: "weekly",
                    weekday: 1,
                    localTime: "08:00",
                    timezone: "UTC",
                    durationMinutes: 60,
                    startsOn: "2026-06-01",
                    groupIds: [gA.id],
                    participants: [{ studentId: nino.id, included: true }],
                });
                const s30 = res.body.data;
                ok("POST /api/series (schéma Phase 5 avec participants) → 201", res.status === 201);
                const evCreated = await eventSeen((e) => e.action === "created" && e.series_id === s30.id);
                ok("WS series:changed « created » reçu", evCreated.action === "created" && evCreated.series_id === s30.id);

                scheduler.runSchedulerTick();
                const occs30 = series30.listOccurrences(s30.id);
                const atP5 = (d: string) => occs30.find((r) => r.occurrence_date === d)!;
                ok("tick : 13 lundis matérialisés, tous scheduled", occs30.length === 13 && occs30.every((r) => r.status === "scheduled"));
                const occJune1 = atP5("2026-06-01");
                const occJune8 = atP5("2026-06-08");
                const occJune15 = atP5("2026-06-15");
                const grpRows = (sid: number) =>
                    db30.db.prepare("SELECT group_id, inherited FROM session_groups WHERE session_id = ? ORDER BY group_id").all(sid) as Array<{ group_id: number; inherited: number }>;
                const deltaRows = (sid: number) =>
                    db30.db.prepare("SELECT student_id, included, inherited FROM session_participants WHERE session_id = ? ORDER BY student_id").all(sid) as Array<{ student_id: number; included: number; inherited: number }>;
                ok(
                    "génération : groupes et deltas de chaque occurrence portent inherited = 1 (copies de la série)",
                    JSON.stringify(grpRows(occJune1.id)) === JSON.stringify([{ group_id: gA.id, inherited: 1 }]) &&
                        JSON.stringify(deltaRows(occJune1.id)) === JSON.stringify([{ student_id: nino.id, included: 1, inherited: 1 }]),
                );
                const evGen1 = await eventSeen((e) => e.action === "generated" && e.series_id === s30.id);
                ok("WS series:changed « generated » reçu avec le nombre créé", evGen1.occurrences === 13);

                // Idempotence : rien ne se rematchérialise, aucune diffusion superflue.
                const genBefore = generatedCount(s30.id);
                scheduler.runSchedulerTick();
                const genIdem = series30.generateOccurrences(s30.id);
                ok(
                    "idempotence : regénération = 0 créée, 13 existantes, aucun « generated » de plus",
                    genIdem.created.length === 0 && genIdem.existing === 13 && generatedCount(s30.id) === genBefore,
                );

                // ── override explicite par occurrence : survit à l'édition ──
                deltas30.upsert(occJune15.id, nino.id, false); // exclusion explicite (flip inherited → 0)
                res = await teacher.call("PATCH", `/api/series/${s30.id}`, {
                    fromDate: "2026-06-08",
                    groupIds: [gA.id, gB.id],
                    participants: [
                        { studentId: nino.id, included: true },
                        { studentId: ines.id, included: true },
                    ],
                });
                ok(
                    "PATCH série avec portée (groupes + participants) → 200, 12 scheduled ≥ ancre réécrites",
                    res.status === 200 && (res.body.data.updated as number[]).length === 12,
                );
                ok(
                    "avant l'ancre (06-01) : RIEN ne bouge — ni le groupe ajouté, ni le delta ajouté",
                    JSON.stringify(grpRows(occJune1.id)) === JSON.stringify([{ group_id: gA.id, inherited: 1 }]) &&
                        JSON.stringify(deltaRows(occJune1.id)) === JSON.stringify([{ student_id: nino.id, included: 1, inherited: 1 }]),
                );
                ok(
                    "dès l'ancre (06-08) : gB ajouté en hérité, deltas remplacés en hérité (ines + nino)",
                    JSON.stringify(grpRows(occJune8.id)) === JSON.stringify([{ group_id: gA.id, inherited: 1 }, { group_id: gB.id, inherited: 1 }]) &&
                        JSON.stringify(deltaRows(occJune8.id)) === JSON.stringify([
                            { student_id: ines.id, included: 1, inherited: 1 },
                            { student_id: nino.id, included: 1, inherited: 1 },
                        ]),
                );
                ok(
                    "dérogation explicite du 06-15 : l'exclusion de nino SURVIT (inherited = 0) malgré le delta hérité contraire",
                    JSON.stringify(deltaRows(occJune15.id)) === JSON.stringify([
                        { student_id: ines.id, included: 1, inherited: 1 },
                        { student_id: nino.id, included: 0, inherited: 0 },
                    ]),
                );

                // ── doublons soumis : dernier gagne ; liste vide = purge des hérités ──
                res = await teacher.call("PATCH", `/api/series/${s30.id}`, {
                    fromDate: "2026-06-08",
                    participants: [
                        { studentId: lova.id, included: false },
                        { studentId: lova.id, included: true },
                    ],
                });
                ok("participants soumis en doublon : dernier gagne, aucune erreur", res.status === 200);
                res = await teacher.call("GET", `/api/series/${s30.id}`);
                ok(
                    "deltas série remplacés : seul lova inclus subsiste (remplacement complet de la liste)",
                    (res.body.data.participants as any[]).length === 1 &&
                        res.body.data.participants[0].student_id === lova.id &&
                        res.body.data.participants[0].included === 1,
                );
                ok(
                    "propagation : 06-08 porte lova (hérité) ; au 06-15 l'explicite (nino exclu) survit à côté du lova hérité",
                    JSON.stringify(deltaRows(occJune8.id)) === JSON.stringify([{ student_id: lova.id, included: 1, inherited: 1 }]) &&
                        JSON.stringify(deltaRows(occJune15.id)) === JSON.stringify([
                            { student_id: nino.id, included: 0, inherited: 0 },
                            { student_id: lova.id, included: 1, inherited: 1 },
                        ]),
                );

                // ── le roster figé suit la portée propagée ──
                res = await teacher.call("POST", `/api/sessions/${occJune8.id}/start`);
                ok("démarrage manuel anticipé de l'occurrence éditée → 200 running", res.status === 200 && res.body.data.status === "running");
                const rosterRows = roster30.listBySession(occJune8.id);
                ok(
                    "roster figé à la portée propagée : ines et lova, jamais nino (plus dans le schéma d'inclusion)",
                    rosterRows.length === 2 &&
                        rosterRows.every((r) => r.student_id === ines.id || r.student_id === lova.id) &&
                        sessRepo30.findById(occJune8.id)!.roster_frozen_at !== null,
                );
                res = await teacher.call("POST", `/api/sessions/${occJune8.id}/stop`);
                ok("arrêt → completed", res.status === 200 && res.body.data.status === "completed");

                // ── diffusion des changements de statut ──
                res = await teacher.call("POST", `/api/series/${s30.id}/pause`);
                await eventSeen((e) => e.action === "paused" && e.series_id === s30.id);
                ok("POST pause → 200 + WS « paused »", res.status === 200);
                res = await teacher.call("POST", `/api/series/${s30.id}/resume`);
                await eventSeen((e) => e.action === "resumed" && e.series_id === s30.id);
                ok("POST resume → 200 + WS « resumed »", res.status === 200);
                const genIdle = generatedCount(s30.id);
                scheduler.runSchedulerTick();
                ok("tick à horizon déjà plein : AUCUN « generated » superflu (diffusion au réel only)", generatedCount(s30.id) === genIdle);

                // ── horizon roulant : le saut de temps rematérialise avec la portée COURANTE ──
                fake.set("2026-09-07T12:00:00.000Z");
                scheduler.runSchedulerTick();
                const evGen2 = await eventSeen((e) => e.action === "generated" && e.series_id === s30.id && e !== evGen1);
                ok(
                    "WS « generated » reçu pour l'extension d'horizon (diffusion au réel only)",
                    generatedCount(s30.id) === genIdle + 1 && (evGen2.occurrences as number) > 0,
                );
                const occs30b = series30.listOccurrences(s30.id);
                ok("horizon roulant prolongé par le tick (nouveaux lundis)", occs30b.length > 13);
                const lastOcc = occs30b[occs30b.length - 1];
                ok(
                    "nouvelles occurrences = portée courante de la série (gA+gB hérités, écart lova hérité)",
                    JSON.stringify(grpRows(lastOcc.id)) === JSON.stringify([{ group_id: gA.id, inherited: 1 }, { group_id: gB.id, inherited: 1 }]) &&
                        JSON.stringify(deltaRows(lastOcc.id)) === JSON.stringify([{ student_id: lova.id, included: 1, inherited: 1 }]),
                );

                // ── annulation depuis l'occurrence cliquée : le passé survit ──
                const expectedFutureP5 = series30
                    .listOccurrences(s30.id)
                    .filter((r) => r.status === "scheduled" && (r.occurrence_date ?? "") >= "2026-10-05").length;
                res = await teacher.call("POST", `/api/series/${s30.id}/cancel`, { from: "2026-10-05" });
                const rCan = res.body.data;
                const evCancel = await eventSeen((e) => e.action === "cancelled" && e.series_id === s30.id);
                ok(
                    "cancel {from} → scheduled ≥ from annulées + WS « cancelled » avec le compte",
                    res.status === 200 &&
                        rCan.series.status === "cancelled" &&
                        rCan.cancelled.length === expectedFutureP5 &&
                        evCancel.occurrences === expectedFutureP5,
                );
                ok(
                    "occurrence completed (06-08) intacte avec son roster, occurrence avant `from` toujours programmée",
                    sessRepo30.findById(occJune8.id)!.status === "completed" &&
                        roster30.countBySession(occJune8.id) === 2 &&
                        sessRepo30.findById(occJune15.id)!.status === "scheduled",
                );

                // Rangement : rien ne pourra s'auto-démarrer ensuite.
                for (const o of series30.listOccurrences(s30.id)) {
                    if (o.status === "scheduled") await teacher.call("POST", `/api/sessions/${o.id}/cancel`);
                }
            } finally {
                restoreClock();
                ws30.close();
            }
        }
    } finally {
        // Close the database (singleton opened by import): without this Windows
        // keeps the file locked and cleanup fails.
        try {
            const { db } = await import("../db");
            db.close();
        } catch {
            /* already closed */
        }
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            console.warn(`[API:VERIFY] (manual cleanup required: ${tmpDir})`);
        }
    }
}

main()
    .then(() => {
        console.log(`\n[API:VERIFY] ${checks} checks passed ✅`);
        process.exit(0);
    })
    .catch((err) => {
        console.error("\n[API:VERIFY] FAILED:", err);
        process.exit(1);
    });
