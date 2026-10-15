// Reproducible verification of the database layer (Phase 2).
// Run by `npm run db:verify` — NEVER writes to the development database
// (it works on copies in a temporary directory).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import { openDatabase } from "./database";
import { getSchemaVersion, runMigrations, TARGET_SCHEMA_VERSION } from "./migrations";
import { createAttendanceRepository } from "./repositories/attendances";
import { createAuthSessionRepository } from "./repositories/authSessions";
import { createCardRepository } from "./repositories/cards";
import { createGroupRepository } from "./repositories/groups";
import { createSessionRepository } from "./repositories/sessions";
import { createSessionParticipantRepository } from "./repositories/sessionParticipants";
import { createSessionRosterRepository } from "./repositories/sessionRoster";
import { createSessionSeriesRepository } from "./repositories/sessionSeries";
import { createStudentRepository } from "./repositories/students";
import { createUserRepository } from "./repositories/users";
import { isoNow } from "./types";
import type { DatabaseHandle } from "./database";

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let checks = 0;
function ok(label: string, fn: () => void): void {
    fn();
    checks += 1;
    console.log(`  ✔ ${label}`);
}

function throwsWith(fn: () => unknown, code: string, label: string): void {
    assert.throws(
        fn,
        (err: unknown) => {
            const actual = (err as { code?: string }).code;
            assert.equal(actual, code, `${label} — code attendu ${code}, reçu ${String(actual)}`);
            return true;
        },
        label,
    );
    checks += 1;
    console.log(`  ✔ ${label}`);
}

function count(db: DatabaseHandle, table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number }).c;
}

function tableOrViewExists(db: DatabaseHandle, type: "table" | "view", name: string): boolean {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) !== undefined;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase A — fresh database : migrations → latest schema + behaviors
// ═══════════════════════════════════════════════════════════════════════════════

function verifyFreshDatabase(tmpDir: string): void {
    console.log("── A. Fresh database ──");
    const db = openDatabase(path.join(tmpDir, "fresh.db"));

    ok("version de schéma = cible après migrations", () => {
        assert.equal(getSchemaVersion(db), TARGET_SCHEMA_VERSION);
    });

    ok("tables physiques et vues présentes, pas de legacy_*", () => {
        for (const t of [
            "users", "groups", "app_students", "cards", "app_sessions", "session_groups",
            "app_attendances", "card_scans", "auth_sessions",
            "session_series", "session_series_groups", "session_series_participants",
            "session_participants", "session_roster",
        ]) {
            assert.ok(tableOrViewExists(db, "table", t), `table ${t}`);
        }
        for (const v of ["students", "sessions", "attendances"]) {
            assert.ok(tableOrViewExists(db, "view", v), `vue ${v}`);
        }
        assert.equal(tableOrViewExists(db, "table", "legacy_students"), false);
    });

    const groups = createGroupRepository(db);
    const students = createStudentRepository(db);
    const cards = createCardRepository(db);
    const sessions = createSessionRepository(db);
    const attendances = createAttendanceRepository(db);
    const users = createUserRepository(db);
    const authSessions = createAuthSessionRepository(db);

    const group = groups.create("G1");
    const s1 = students.create({ firstName: "Test", lastName: "Un", groupId: group.id });
    const s2 = students.create({ firstName: "Test", lastName: "Deux", groupId: group.id });

    ok("assignation carte + lookup par UID (nombre ET chaîne)", () => {
        cards.assignToStudent(12345, s1.id); // number accepted → normalized to decimal
        assert.equal(students.findByCardUid("12345")?.id, s1.id);
        assert.equal(students.findByCardUid(12345)?.id, s1.id);
    });

    ok("session scheduled → start → running (findActive)", () => {
        const created = sessions.create({ label: "Cours test", scheduledAt: isoNow(), durationMinutes: 30 });
        assert.equal(created.status, "scheduled");
        const running = sessions.start(created.id);
        assert.equal(running.status, "running");
        assert.ok(running.started_at && ISO_RE.test(running.started_at));
        assert.equal(sessions.findActive()?.id, created.id);
    });
    const session = sessions.findActive()!;

    ok("session_groups : plusieurs groupes par session (union + cascade)", () => {
        const gA = groups.create("GA");
        const gB = groups.create("GB");
        const sA = students.create({ firstName: "Union", lastName: "A", groupId: gA.id });
        const sB = students.create({ firstName: "Union", lastName: "B", groupId: gB.id });
        const sNone = students.create({ firstName: "Union", lastName: "Hors" });

        // Create accepts a LIST of groups (duplicates ignored).
        const multi = sessions.create({ label: "Cours commun", scheduledAt: isoNow(), groupIds: [gA.id, gB.id, gB.id] });
        assert.deepEqual(sessions.getGroupIds(multi.id), [gA.id, gB.id]);

        // The session page/report roster is the UNION of the selected groups.
        const roster = attendances.getSessionReport(multi.id, sessions.getGroupIds(multi.id));
        const ids = roster.map((row) => row.student_id);
        assert.ok(ids.includes(sA.id) && ids.includes(sB.id), "les deux groupes sont dans le roster");
        assert.ok(!ids.includes(sNone.id), "les étudiants hors groupes ne sont pas dans le roster");
        assert.ok(roster.every((row) => row.status === "absent"), "personne n'a encore scanné");

        // Deleting a group removes its memberships (FK CASCADE), keeps the others.
        groups.remove(gB.id);
        assert.deepEqual(sessions.getGroupIds(multi.id), [gA.id]);
    });

    ok("recordScan : 1er scan accepté, 2e = doublon, historique conservé", () => {
        const first = attendances.recordScan({ sessionId: session.id, studentId: s1.id, uid: "12345" });
        const second = attendances.recordScan({ sessionId: session.id, studentId: s1.id, uid: "12345" });
        assert.equal(first.duplicate, false);
        assert.equal(second.duplicate, true);
        assert.equal(second.attendance.scanned_at, first.attendance.scanned_at); // state frozen at the 1st scan
        const scans = attendances.listScans(session.id);
        assert.equal(scans.length, 2);
        assert.deepEqual(scans.map((s) => s.result), ["accepted", "duplicate"]);
    });

    ok("état de présence : UNIQUE(session_id, student_id) appliqué", () => {
        throwsWith(
            () => db.prepare("INSERT INTO app_attendances (session_id, student_id, scanned_at) VALUES (?, ?, ?)").run(session.id, s1.id, isoNow()),
            "SQLITE_CONSTRAINT_UNIQUE",
            "second état direct rejeté",
        );
    });

    ok("FK : présence avec étudiant inconnu rejetée", () => {
        throwsWith(
            () => db.prepare("INSERT INTO app_attendances (session_id, student_id, scanned_at) VALUES (?, ?, ?)").run(session.id, 999999, isoNow()),
            "SQLITE_CONSTRAINT_FOREIGNKEY",
            "FK app_attendances.student_id",
        );
    });

    ok("UNIQUE cards.uid", () => {
        cards.issue("777");
        throwsWith(() => cards.issue("777"), "SQLITE_CONSTRAINT_UNIQUE", "UID en double");
    });

    ok("au plus une carte ACTIVE par étudiant (index partiel)", () => {
        throwsWith(
            () => db.prepare("INSERT INTO cards (uid, student_id) VALUES (?, ?)").run("778", s1.id),
            "SQLITE_CONSTRAINT_UNIQUE",
            "2e carte active simultanée",
        );
    });

    ok("remplacement de carte : ancienne retirée, historique conservé", () => {
        const previous = cards.findActiveByStudent(s1.id)!;
        const replacement = cards.assignToStudent("12346", s1.id);
        assert.equal(cards.findActiveByStudent(s1.id)?.id, replacement.id);
        assert.ok(cards.findById(previous.id)!.revoked_at !== null);
        assert.equal(cards.listByStudent(s1.id).length, 2);
    });

    ok("logScan : unknown/expired journalisés SANS état de présence", () => {
        const before = count(db, "app_attendances");
        const unknown = attendances.logScan({ sessionId: session.id, uid: "8888", result: "unknown" });
        const expired = attendances.logScan({ sessionId: session.id, studentId: s2.id, uid: "8889", result: "expired" });
        assert.equal(unknown.result, "unknown");
        assert.equal(expired.result, "expired");
        assert.equal(count(db, "app_attendances"), before);
        const scans = attendances.listScans(session.id);
        assert.deepEqual(scans.slice(-2).map((r) => r.result), ["unknown", "expired"]);
    });

    ok("logScan : la session doit exister (FK card_scans.session_id)", () => {
        throwsWith(
            () => attendances.logScan({ sessionId: 999999, uid: "8890", result: "unknown" }),
            "SQLITE_CONSTRAINT_FOREIGNKEY",
            "scan sans session",
        );
    });

    ok("pont de compatibilité conservé (vues + triggers INSTEAD OF — fallback legacy)", () => {
        for (const t of [
            "students_legacy_insert", "students_legacy_update", "students_legacy_delete",
            "sessions_legacy_insert", "sessions_legacy_update", "sessions_legacy_delete",
            "attendances_legacy_insert", "attendances_legacy_delete",
        ]) {
            assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(t), t);
        }
    });

    ok("users : username UNIQUE + CHECK sur role (admin, teacher, kiosk)", () => {
        users.create({ username: "admin", passwordHash: "!placeholder!", role: "admin" });
        throwsWith(() => users.create({ username: "admin", passwordHash: "x" }), "SQLITE_CONSTRAINT_UNIQUE", "username en double");
        throwsWith(
            () => db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('x','y','root')").run(),
            "SQLITE_CONSTRAINT_CHECK",
            "rôle hors liste",
        );
        // Migration 003 : the kiosk terminal role "kiosk" is part of the list.
        db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('borne','!x!','kiosk')").run();
        db.prepare("DELETE FROM users WHERE username = 'borne'").run();
    });

    ok("users : setPasswordHash (ré-encodage Phase 3)", () => {
        const admin = users.findByUsername("admin")!;
        const updated = users.setPasswordHash(admin.id, "scrypt$16384$8$1$c2FsdA$aGFzaA");
        assert.equal(updated!.password_hash, "scrypt$16384$8$1$c2FsdA$aGFzaA");
        // The creation timestamp comes from the SQL DEFAULT (rounded second), the
        // JS-clock update : tolerance ±2 s, no strict equality.
        assert.ok(
            Date.parse(updated!.updated_at) - Date.parse(admin.updated_at) > -2000,
            `updated_at ${updated!.updated_at} pas antérieure à ${admin.updated_at}`,
        );
    });

    // ─── auth_sessions (migration 006) : persistent login sessions ───────────
    const isoMs = (offsetMs: number): string => new Date(Date.parse(isoNow()) + offsetMs).toISOString();
    const makeSession = (tokenHash: string, userId: number, expiresInMs = 3_600_000) =>
        authSessions.create({
            tokenHash,
            userId,
            createdAt: isoMs(-60_000),
            expiresAt: isoMs(expiresInMs),
            lastSeenAt: isoMs(-60_000),
        });

    ok("auth_sessions : création + lookup par hash (horodatages ISO), JAMAIS le jeton brut", () => {
        const admin = users.findByUsername("admin")!;
        const created = makeSession("a".repeat(64), admin.id);
        assert.equal(created.user_id, admin.id);
        assert.equal(created.token_hash, "a".repeat(64));
        assert.match(created.created_at, ISO_RE);
        assert.match(created.expires_at, ISO_RE);
        assert.match(created.last_seen_at, ISO_RE);
        assert.equal(authSessions.findByTokenHash("a".repeat(64))?.id, created.id);
        assert.equal(authSessions.findByTokenHash("b".repeat(64)), undefined);
        throwsWith(
            () => makeSession("a".repeat(64), admin.id),
            "SQLITE_CONSTRAINT_UNIQUE",
            "deux sessions au même hash de jeton refusées",
        );
    });

    ok("auth_sessions : FK user (inconnu refusé, CASCADE à la suppression)", () => {
        throwsWith(
            () => makeSession("c".repeat(64), 999999),
            "SQLITE_CONSTRAINT_FOREIGNKEY",
            "FK auth_sessions.user_id",
        );
        const temp = users.create({ username: "sessionne", passwordHash: "!x!", role: "teacher" });
        makeSession("d".repeat(64), temp.id);
        assert.equal(authSessions.listTokenHashesByUser(temp.id).length, 1);
        db.prepare("DELETE FROM users WHERE id = ?").run(temp.id);
        assert.equal(authSessions.listTokenHashesByUser(temp.id).length, 0);
    });

    ok("auth_sessions : durée de vie (countActive, purge des expirées, touch, delete)", () => {
        const admin = users.findByUsername("admin")!;
        const t0 = isoMs(0); // one single reference instant for the whole check
        const activeBefore = authSessions.countActive(t0);
        makeSession("e".repeat(63) + "1", admin.id, +60_000); // still live
        makeSession("e".repeat(63) + "2", admin.id, -60_000); // expired
        assert.equal(authSessions.countActive(t0), activeBefore + 1);
        const before = authSessions.count();
        assert.equal(authSessions.purgeExpired(t0), 1);
        assert.equal(authSessions.count(), before - 1);
        assert.equal(authSessions.findByTokenHash("e".repeat(63) + "2"), undefined);

        const live = authSessions.findByTokenHash("e".repeat(63) + "1")!;
        authSessions.touchLastSeen(live.token_hash, t0);
        assert.equal(authSessions.findByTokenHash(live.token_hash)!.last_seen_at, t0);
        assert.ok(authSessions.setExpiresAt(live.token_hash, isoMs(+7_200_000)));
        assert.equal(authSessions.setExpiresAt("f".repeat(64), t0), false);
        assert.ok(authSessions.deleteByTokenHash(live.token_hash));
        assert.equal(authSessions.deleteByTokenHash(live.token_hash), false);
    });

    ok("auth_sessions : deleteByUserExcept (mot de passe réinitialisé — session active préservée)", () => {
        const multi = users.create({ username: "multi", passwordHash: "!x!", role: "teacher" });
        const hashes = ["1", "2", "3"].map((d) => d.repeat(64));
        for (const tokenHash of hashes) makeSession(tokenHash, multi.id);
        assert.deepEqual(authSessions.listTokenHashesByUser(multi.id).sort(), [...hashes].sort());

        // Password reset: everything dies except the ACTING session ("2").
        const destroyed = authSessions.deleteByUserExcept(multi.id, hashes[1]);
        assert.deepEqual([...destroyed].sort(), [hashes[0], hashes[2]].sort());
        assert.deepEqual(authSessions.listTokenHashesByUser(multi.id), [hashes[1]]);

        // No exception → every session of the user dies.
        assert.equal(authSessions.deleteByUserExcept(multi.id).length, 1);
        assert.equal(authSessions.listTokenHashesByUser(multi.id).length, 0);
    });

    // ─── session series & occurrences (migration 008) ────────────────────────
    const series = createSessionSeriesRepository(db);
    const occurrenceParticipants = createSessionParticipantRepository(db);
    const roster = createSessionRosterRepository(db);

    ok("session_series : création (patron, heure locale, fuseau, plage) + groupes + statut", () => {
        const gC = groups.create("GC");
        const created = series.create({
            label: "Mardi 8h",
            recurrence: "weekly",
            weekday: 2,
            localTime: "08:15",
            timezone: "Europe/Paris",
            durationMinutes: 90,
            startsOn: "2026-09-01",
            endsOn: "2026-12-20",
            groupIds: [gC.id, gC.id], // doublon ignoré
        });
        assert.equal(created.recurrence, "weekly");
        assert.equal(created.weekday, 2);
        assert.equal(created.local_time, "08:15");
        assert.equal(created.timezone, "Europe/Paris");
        assert.equal(created.status, "active");
        assert.match(created.created_at, ISO_RE);
        assert.deepEqual(series.getGroupIds(created.id), [gC.id]);
        assert.equal(series.setStatus(created.id, "paused")?.status, "paused");

        // Patron quotidien : jour non requis (CHECK conditional).
        const daily = series.create({ label: "Quotidien", recurrence: "daily", localTime: "23:59", startsOn: "2026-09-01" });
        assert.equal(daily.weekday, null);
        assert.equal(daily.timezone, "UTC"); // défaut honnête : UTC
    });

    ok("session_series : CHECKs (récurrence, jour 0-6, heure, date, plage, statut, fuseau, durée)", () => {
        const ins = (cols: string, vals: string) =>
            throwsWith(
                () => db.prepare(`INSERT INTO session_series (${cols}) VALUES (${vals})`).run(),
                "SQLITE_CONSTRAINT_CHECK",
                cols + " → " + vals,
            );
        ins("label, recurrence, local_time, starts_on", "'x','hourly','08:00','2026-09-01'");
        ins("label, weekday, local_time, starts_on", "'x',7,'08:00','2026-09-01'");
        ins("label, local_time, starts_on", "'x','24:00','2026-09-01'");
        ins("label, local_time, starts_on", "'x','8:00','2026-09-01'");
        ins("label, local_time, starts_on", "'x','08:60','2026-09-01'");
        ins("label, local_time, starts_on", "'x','08:00','2026-13-01'");
        ins("label, local_time, starts_on, ends_on", "'x','08:00','2026-09-10','2026-09-01'");
        ins("label, local_time, starts_on, status", "'x','08:00','2026-09-01','archived'");
        ins("label, recurrence, local_time, starts_on", "'x','weekly','08:00','2026-09-01'"); // weekly sans jour
        ins("label, local_time, starts_on, timezone", "'x','08:00','2026-09-01',''");
        ins("label, local_time, starts_on, duration_minutes", "'x','08:00','2026-09-01',0");
        // Bornes valides acceptées : weekday 0 et 6, ends_on = starts_on.
        db.prepare("INSERT INTO session_series (label, weekday, local_time, starts_on, ends_on) VALUES ('x',0,'00:00','2026-09-01','2026-09-01')").run();
        db.prepare("INSERT INTO session_series (label, weekday, local_time, starts_on) VALUES ('x',6,'23:59','2026-09-01')").run();
    });

    ok("session_series : FK créateur (inconnu refusé, SET NULL à la suppression)", () => {
        const temp = users.create({ username: "serfondeur", passwordHash: "!x!", role: "teacher" });
        const s = series.create({ label: "Par temp", localTime: "10:00", startsOn: "2026-09-01", weekday: 1, createdBy: temp.id });
        assert.equal(s.created_by, temp.id);
        throwsWith(
            () => series.create({ label: "x", localTime: "10:00", startsOn: "2026-09-01", weekday: 1, createdBy: 999999 }),
            "SQLITE_CONSTRAINT_FOREIGNKEY",
            "créateur inconnu",
        );
        db.prepare("DELETE FROM users WHERE id = ?").run(temp.id);
        assert.equal(series.findById(s.id)!.created_by, null);
    });

    ok("session_series_groups : PK UNIQUE + FK + CASCADE (série comme groupe)", () => {
        const g1 = groups.create("GS1");
        const g2 = groups.create("GS2");
        const s = series.create({ label: "Cascade", localTime: "09:00", startsOn: "2026-09-01", weekday: 3, groupIds: [g1.id, g2.id] });
        throwsWith(
            () => db.prepare("INSERT INTO session_series_groups (series_id, group_id) VALUES (?, ?)").run(s.id, g1.id),
            "SQLITE_CONSTRAINT_PRIMARYKEY",
            "appartenance en double",
        );
        throwsWith(
            () => db.prepare("INSERT INTO session_series_groups (series_id, group_id) VALUES (999999, ?)").run(g1.id),
            "SQLITE_CONSTRAINT_FOREIGNKEY",
            "série inconnue",
        );
        groups.remove(g2.id); // le groupe meurt → l'appartenance suit (CASCADE)
        assert.deepEqual(series.getGroupIds(s.id), [g1.id]);
        db.prepare("DELETE FROM session_series WHERE id = ?").run(s.id);
        assert.equal((db.prepare("SELECT COUNT(*) c FROM session_series_groups WHERE series_id = ?").get(s.id) as { c: number }).c, 0);
    });

    ok("session_series_participants : deltas 0/1, upsert, FK et CASCADE étudiant", () => {
        const gP = groups.create("GP");
        const horsGroupe = students.create({ firstName: "Inclus", lastName: "HorsGroupe" });
        const duGroupe = students.create({ firstName: "Exclu", lastName: "DuGroupe", groupId: gP.id });
        const s = series.create({ label: "Deltas", localTime: "11:00", startsOn: "2026-09-01", weekday: 4, groupIds: [gP.id] });
        series.upsertParticipant(s.id, horsGroupe.id, true); // included = 1
        series.upsertParticipant(s.id, duGroupe.id, false); // included = 0
        assert.deepEqual(series.listParticipants(s.id).map((r) => [r.student_id, r.included]), [
            [horsGroupe.id, 1],
            [duGroupe.id, 0],
        ]);
        series.upsertParticipant(s.id, horsGroupe.id, false); // upsert : une seule ligne par (série, étudiant)
        assert.equal(series.listParticipants(s.id).length, 2);
        throwsWith(
            () => db.prepare("INSERT INTO session_series_participants (series_id, student_id, included) VALUES (?,?,1)").run(s.id, duGroupe.id),
            "SQLITE_CONSTRAINT_PRIMARYKEY",
            "delta en double sur (série, étudiant)",
        );
        throwsWith(
            () => db.prepare("INSERT INTO session_series_participants (series_id, student_id, included) VALUES (?,?,2)").run(s.id, duGroupe.id),
            "SQLITE_CONSTRAINT_CHECK",
            "included hors 0/1",
        );
        throwsWith(
            () => db.prepare("INSERT INTO session_series_participants (series_id, student_id, included) VALUES (?,?,1)").run(s.id, 999999),
            "SQLITE_CONSTRAINT_FOREIGNKEY",
            "étudiant inconnu",
        );
        assert.ok(series.removeParticipant(s.id, horsGroupe.id));
        db.prepare("DELETE FROM app_students WHERE id = ?").run(duGroupe.id);
        assert.equal(series.listParticipants(s.id).length, 0); // CASCADE
    });

    ok("app_sessions : session ordinaire = autonome (series_id/occurrence NULL, timezone 'UTC')", () => {
        const s = sessions.create({ label: "Autonome", scheduledAt: isoNow(), durationMinutes: 55 });
        assert.equal(s.series_id, null);
        assert.equal(s.occurrence_date, null);
        assert.equal(s.local_time, null);
        assert.equal(s.timezone, "UTC");
        assert.equal(s.roster_frozen_at, null);
    });

    ok("app_sessions : occurrence — FK série, UNIQUE(series_id, occurrence_date), CHECK formats", () => {
        const ser = series.create({ label: "Occurrences", localTime: "10:00", startsOn: "2026-09-01", weekday: 1 });
        const other = series.create({ label: "Autre série", localTime: "10:00", startsOn: "2026-09-01", weekday: 1 });
        const insOcc = db.prepare(
            `INSERT INTO app_sessions (label, scheduled_at, series_id, occurrence_date, local_time, timezone)
             VALUES (?, ?, ?, ?, ?, ?)`,
        );
        throwsWith(
            () => insOcc.run("orpheline", isoNow(), 999999, "2026-09-01", "10:00", "UTC"),
            "SQLITE_CONSTRAINT_FOREIGNKEY",
            "série inconnue",
        );
        insOcc.run("occ1", isoNow(), ser.id, "2026-09-01", "10:00", "Europe/Paris");
        throwsWith(
            () => insOcc.run("occ1-bis", isoNow(), ser.id, "2026-09-01", "10:00", "UTC"),
            "SQLITE_CONSTRAINT_UNIQUE",
            "deux occurrences le même jour de la même série",
        );
        insOcc.run("occ2", isoNow(), ser.id, "2026-09-08", "10:00", "Europe/Paris"); // jour suivant OK
        insOcc.run("occ-autre-serie", isoNow(), other.id, "2026-09-01", "10:00", "UTC"); // autre série OK
        insOcc.run("autonome daté", isoNow(), null, "2026-09-01", null, "UTC"); // hors index partiel
        insOcc.run("autonome daté bis", isoNow(), null, "2026-09-01", null, "UTC"); // sans série → jamais en conflit
        throwsWith(
            () => insOcc.run("date invalide", isoNow(), ser.id, "2026-13-01", "10:00", "UTC"),
            "SQLITE_CONSTRAINT_CHECK",
            "occurrence_date non calendaire",
        );
        throwsWith(
            () => insOcc.run("heure invalide", isoNow(), ser.id, "2026-09-01", "25:00", "UTC"),
            "SQLITE_CONSTRAINT_CHECK",
            "local_time invalide",
        );
        throwsWith(
            () => insOcc.run("fuseau vide", isoNow(), ser.id, "2026-09-01", "10:00", ""),
            "SQLITE_CONSTRAINT_CHECK",
            "timezone vide",
        );
        // Supprimer le modèle n'efface jamais l'historique : les occurrences
        // restent en base, simplement orphelines (FK SET NULL).
        db.prepare("DELETE FROM session_series WHERE id = ?").run(ser.id);
        const orphan = db.prepare("SELECT series_id FROM app_sessions WHERE label = 'occ1'").get() as { series_id: number | null };
        assert.equal(orphan.series_id, null);
    });

    ok("session_participants : deltas par occurrence (PK, CHECK, FK, CASCADE)", () => {
        const s = sessions.create({ label: "Deltas occurrence", scheduledAt: isoNow() });
        occurrenceParticipants.upsert(s.id, s1.id, true);
        occurrenceParticipants.upsert(s.id, s2.id, false);
        occurrenceParticipants.upsert(s.id, s1.id, false); // upsert, pas de doublon
        assert.deepEqual(occurrenceParticipants.listBySession(s.id).map((r) => [r.student_id, r.included]), [
            [s1.id, 0],
            [s2.id, 0],
        ]);
        throwsWith(
            () => db.prepare("INSERT INTO session_participants (session_id, student_id, included) VALUES (?,?,5)").run(s.id, s2.id),
            "SQLITE_CONSTRAINT_CHECK",
            "included hors 0/1",
        );
        throwsWith(
            () => occurrenceParticipants.upsert(999999, s1.id, true),
            "SQLITE_CONSTRAINT_FOREIGNKEY",
            "session inconnue",
        );
        assert.ok(occurrenceParticipants.remove(s.id, s2.id));
        db.prepare("DELETE FROM app_sessions WHERE id = ?").run(s.id);
        assert.equal(occurrenceParticipants.listBySession(s.id).length, 0); // CASCADE
    });

    ok("migration 009 : colonne inherited (défaut 0, CHECK 0/1) sur session_groups ET session_participants", () => {
        for (const t of ["session_groups", "session_participants"]) {
            const col = (db.prepare(`PRAGMA table_info("${t}")`).all() as Array<{
                name: string; notnull: number; dflt_value: string | null;
            }>).find((c) => c.name === "inherited");
            assert.ok(col, `colonne inherited sur ${t}`);
            assert.equal(col!.notnull, 1, `${t}.inherited NOT NULL`);
            assert.equal(col!.dflt_value, "0", `${t}.inherited défaut 0`);
        }
        const s = sessions.create({ label: "CHECK inherited", scheduledAt: isoNow(), groupIds: [group.id] });
        // Ligne par défaut = explicite (0).
        assert.equal(
            (db.prepare("SELECT inherited FROM session_groups WHERE session_id = ?").get(s.id) as { inherited: number }).inherited,
            0,
        );
        throwsWith(
            () => db.prepare("INSERT INTO session_groups (session_id, group_id, inherited) VALUES (?,?,5)").run(s.id, group.id),
            "SQLITE_CONSTRAINT_CHECK",
            "inherited hors 0/1 (session_groups)",
        );
        throwsWith(
            () => db.prepare("INSERT INTO session_participants (session_id, student_id, included, inherited) VALUES (?,?,1,5)").run(s.id, s1.id),
            "SQLITE_CONSTRAINT_CHECK",
            "inherited hors 0/1 (session_participants)",
        );
    });

    ok("migration 009 : occurrence = appartenances héritées (1) via sessions.create, autonomes = explicites (0)", () => {
        const gI1 = groups.create("GINH1");
        const gI2 = groups.create("GINH2");
        const ser = series.create({ label: "Héritées", localTime: "08:00", startsOn: "2026-09-01", weekday: 1, groupIds: [gI1.id] });
        const occ = sessions.create({
            label: "occ héritée",
            scheduledAt: isoNow(),
            seriesId: ser.id,
            occurrenceDate: "2026-09-07",
            localTime: "08:00",
            groupIds: [gI1.id, gI2.id],
        });
        assert.deepEqual(
            db.prepare("SELECT group_id, inherited FROM session_groups WHERE session_id = ? ORDER BY group_id").all(occ.id) as Array<{ group_id: number; inherited: number }>,
            [{ group_id: gI1.id, inherited: 1 }, { group_id: gI2.id, inherited: 1 }],
        );
        const standalone = sessions.create({ label: "autonome inh", scheduledAt: isoNow(), groupIds: [gI1.id] });
        assert.equal(
            (db.prepare("SELECT inherited FROM session_groups WHERE session_id = ?").get(standalone.id) as { inherited: number }).inherited,
            0,
        );
    });

    ok("migration 009 : replaceInheritedGroupIds / syncInherited — les lignes explicites gagnent toujours", () => {
        const gR1 = groups.create("GREP1");
        const gR2 = groups.create("GREP2");
        const gR3 = groups.create("GREP3");
        const s = sessions.create({ label: "Sync inherited", scheduledAt: isoNow(), groupIds: [gR1.id, gR2.id] });
        db.prepare("UPDATE session_groups SET inherited = 1 WHERE session_id = ?").run(s.id); // comme générée

        sessions.replaceInheritedGroupIds(s.id, [gR1.id, gR3.id]);
        assert.deepEqual(sessions.getGroupIds(s.id).sort((a, b) => a - b), [gR1.id, gR3.id].sort((a, b) => a - b));

        // Une appartenance EXPLICITE survit et interdit la réinsertion héritée.
        db.prepare("INSERT INTO session_groups (session_id, group_id, inherited, created_at) VALUES (?,?,0,?)").run(s.id, gR2.id, isoNow());
        sessions.replaceInheritedGroupIds(s.id, [gR1.id, gR2.id]);
        assert.deepEqual(
            db.prepare("SELECT group_id, inherited FROM session_groups WHERE session_id = ? ORDER BY group_id").all(s.id) as Array<{ group_id: number; inherited: number }>,
            [{ group_id: gR1.id, inherited: 1 }, { group_id: gR2.id, inherited: 0 }],
        );

        // Participants : l'override explicite flip la ligne et survit à syncInherited.
        occurrenceParticipants.upsert(s.id, s1.id, true, true); // copie héritée
        occurrenceParticipants.upsert(s.id, s2.id, true); // explicite
        occurrenceParticipants.syncInherited(s.id, [
            { studentId: s1.id, included: false },
            { studentId: s2.id, included: false },
        ]);
        assert.deepEqual(
            occurrenceParticipants.listBySession(s.id).map((r) => [r.student_id, r.included, r.inherited]),
            [
                [s1.id, 0, 1],
                [s2.id, 1, 0],
            ],
        );
    });

    ok("session_roster : instantané figé UNIQUE et immuable (UPDATE/DELETE explicites refusés)", () => {
        const s = sessions.create({ label: "Roster", scheduledAt: isoNow() });
        const gR = groups.create("GR");
        const future = students.create({ firstName: "Anne", lastName: "Face", groupId: gR.id });
        const frozenAt = isoNow();
        assert.equal(
            roster.capture(s.id, frozenAt, [
                { studentId: s1.id, fullName: "Test Un", groupName: "G1" },
                { studentId: future.id, fullName: "Anne Face", groupName: "GR" },
            ]),
            2,
        );
        assert.equal(roster.countBySession(s.id), 2);
        assert.ok(roster.listBySession(s.id).every((r) => r.frozen_at === frozenAt));
        throwsWith(
            () => db.prepare("INSERT INTO session_roster (session_id, student_id, full_name, frozen_at) VALUES (?,?,?,?)").run(s.id, s1.id, "doublon", frozenAt),
            "SQLITE_CONSTRAINT_UNIQUE",
            "deux lignes pour (session, étudiant)",
        );
        throwsWith(
            () => db.prepare("UPDATE session_roster SET full_name = 'réécriture' WHERE session_id = ?").run(s.id),
            "SQLITE_CONSTRAINT_TRIGGER",
            "UPDATE explicite refusé",
        );
        throwsWith(
            () => db.prepare("UPDATE session_roster SET student_id = NULL WHERE session_id = ? AND student_id = ?").run(s.id, s1.id),
            "SQLITE_CONSTRAINT_TRIGGER",
            "effacement explicite du lien étudiant refusé",
        );
        throwsWith(
            () => db.prepare("DELETE FROM session_roster WHERE session_id = ? AND student_id = ?").run(s.id, s1.id),
            "SQLITE_CONSTRAINT_TRIGGER",
            "DELETE explicite refusé",
        );
        // Les actions de FK traversent néanmoins le garde-fou : supprimer
        // l'étudiant passe student_id à NULL SANS effacer la ligne (nom
        // dénormalisé conservé).
        db.prepare("DELETE FROM app_students WHERE id = ?").run(future.id);
        const kept = roster.listBySession(s.id).find((r) => r.full_name === "Anne Face")!;
        assert.equal(kept.student_id, null);
        // La suppression de la session emporte l'instantané (CASCADE).
        db.prepare("DELETE FROM app_sessions WHERE id = ?").run(s.id);
        assert.equal(roster.countBySession(s.id), 0);
    });

    ok("migration 008 : index et triggers immuabilité déclarés", () => {
        for (const idx of [
            "idx_app_sessions_series",
            "ux_app_sessions_series_occurrence",
            "idx_session_series_groups_group",
            "idx_session_series_participants_student",
            "idx_session_participants_student",
            "idx_session_roster_student",
        ]) {
            assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(idx), idx);
        }
        for (const tr of ["session_roster_immutable_update", "session_roster_immutable_delete"]) {
            assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(tr), tr);
        }
    });

    ok("CHECK statut de session", () => {
        throwsWith(
            () => db.prepare("INSERT INTO app_sessions (label, scheduled_at, status) VALUES ('x','2026-01-01T00:00:00.000Z','open')").run(),
            "SQLITE_CONSTRAINT_CHECK",
            "statut hors liste",
        );
    });

    ok("horodatages ISO-8601 UTC (millisecondes, suffixe Z)", () => {
        const row = students.findById(s2.id)!;
        assert.match(row.created_at, ISO_RE);
        assert.match(row.updated_at, ISO_RE);
    });

    // Legacy compatibility on a fresh database.
    ok("vues legacy : INSERT/SELECT/UNIQUE sur un schéma neuf", () => {
        db.prepare("INSERT INTO sessions (label, scheduled_at, duration_minutes) VALUES (?, ?, ?)")
            .run("Cours legacy", isoNow(), 55);
        const legacySession = db.prepare("SELECT * FROM sessions WHERE label = 'Cours legacy'").get() as { id: number; status: string; rfid_enabled: number };
        assert.equal(legacySession.status, "pending");

        db.prepare("UPDATE sessions SET status = 'active', rfid_enabled = 1 WHERE id = ?").run(legacySession.id);
        assert.equal((db.prepare("SELECT status FROM sessions WHERE id = ?").get(legacySession.id) as { status: string }).status, "active");

        db.prepare("INSERT INTO students (name, card_uid, group_name, email) VALUES (?, ?, ?, ?)").run("Léo", "9190864", "G1", null);
        const found = db.prepare("SELECT * FROM students WHERE card_uid = ?").get("9190864") as { name: string; group_name: string };
        assert.equal(found.name, "Léo");
        assert.equal(found.group_name, "G1");

        const studentId = (db.prepare("SELECT id FROM students WHERE card_uid = ?").get("9190864") as { id: number }).id;
        db.prepare("INSERT INTO attendances (session_id, student_id, is_valid) VALUES (?, ?, 1)").run(legacySession.id, studentId);
        throwsWith(
            () => db.prepare("INSERT INTO attendances (session_id, student_id, is_valid) VALUES (?, ?, 1)").run(legacySession.id, studentId),
            "SQLITE_CONSTRAINT_UNIQUE",
            "2e scan legacy → contrainte attendue par record()",
        );
    });

    ok("migrations idempotentes (2e exécution = no-op)", () => {
        assert.deepEqual(runMigrations(db), []);
    });

    ok("intégrité : PRAGMA foreign_key_check / integrity_check", () => {
        assert.deepEqual(db.pragma("foreign_key_check"), []);
        assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
    });

    db.close();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase B — copy of the existing development database : lossless migration
// ═══════════════════════════════════════════════════════════════════════════════

function copyDbFiles(sourceDb: string, targetDir: string): string {
    const target = path.join(targetDir, "attendance.db");
    for (const suffix of ["", "-wal", "-shm"]) {
        const from = `${sourceDb}${suffix}`;
        if (fs.existsSync(from)) fs.copyFileSync(from, `${target}${suffix}`);
    }
    return target;
}

function verifyExistingDatabase(tmpDir: string, devDbPath: string): void {
    console.log(`── B. Existing database (${path.basename(devDbPath)}, working copy) ──`);
    const copy = copyDbFiles(devDbPath, tmpDir);

    // State BEFORE migration (read-only on the copy).
    const raw = new Database(copy, { readonly: true });
    const preVersion = raw.pragma("user_version", { simple: true }) as number;
    // "pre-migration" = before migration 001 (physical legacy tables,
    // views absent). A database already at v1 is completed ONLY by
    // migration 002 (session_groups) : the strict archives↔views comparisons
    // no longer hold, hence this explicit distinction (do NOT compare to
    // TARGET_SCHEMA_VERSION, which moves with each new migration).
    const preMigration = preVersion < 1;
    const legacyCounts = {
        students: count(raw as DatabaseHandle, "students"),
        sessions: count(raw as DatabaseHandle, "sessions"),
        attendances: count(raw as DatabaseHandle, "attendances"),
    };
    // Already migrated database : the legacy_* archives are frozen since migration
    // 001 — the reference for "no data lost" is their own value
    // before the run, NOT the views (which may have decreased since : presence
    // resets, student/session cascade deletions).
    const archiveCounts = preMigration
        ? null
        : {
              students: count(raw as DatabaseHandle, "legacy_students"),
              sessions: count(raw as DatabaseHandle, "legacy_sessions"),
              attendances: count(raw as DatabaseHandle, "legacy_attendances"),
          };
    const legacyActiveSessions = (raw.prepare("SELECT COUNT(*) c FROM sessions WHERE status='active'").get() as { c: number }).c;
    const legacyCardByStudent = new Map<number, string>(
        (raw.prepare("SELECT id, card_uid FROM students").all() as Array<{ id: number; card_uid: string }>).map((r) => [r.id, r.card_uid]),
    );
    // Already migrated (v1+) : frozen snapshot of app_sessions BEFORE the run —
    // migration 008 must preserve every row, every field, without inventing
    // any series link.
    interface SessionSnapshotRow {
        id: number;
        label: string;
        scheduled_at: string;
        status: string;
        created_by: number | null;
    }
    const sessionSnapshot: SessionSnapshotRow[] | null = preMigration
        ? null
        : (raw
              .prepare("SELECT id, label, scheduled_at, status, created_by FROM app_sessions ORDER BY id")
              .all() as SessionSnapshotRow[]);
    raw.close();

    const db = openDatabase(copy); // triggers the migration on the copy

    ok("version de schéma = cible", () => {
        assert.equal(getSchemaVersion(db), TARGET_SCHEMA_VERSION);
    });

    ok("migration 006 : table auth_sessions en place sur la base migrée", () => {
        // A version < 6 copy gains the table from the migration (auth
        // sessions are persistent since then) ; a copy already at the
        // target version has it and nothing may have touched it.
        assert.ok(tableOrViewExists(db, "table", "auth_sessions"));
        if (preVersion < 6) {
            assert.equal(count(db, "auth_sessions"), 0, "table neuve : aucune session inventée");
        }
    });

    ok("migration 008 : tables série/participants/roster en place, vides si base < v8", () => {
        const newTables = [
            "session_series",
            "session_series_groups",
            "session_series_participants",
            "session_participants",
            "session_roster",
        ];
        for (const t of newTables) {
            assert.ok(tableOrViewExists(db, "table", t), `table ${t}`);
            if (preVersion < 8) {
                assert.equal(count(db, t), 0, `table neuve ${t} : aucune donnée inventée`);
            }
        }
        if (preVersion < 8) {
            for (const idx of ["idx_app_sessions_series", "ux_app_sessions_series_occurrence"]) {
                assert.ok(
                    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(idx),
                    idx,
                );
            }
        }
    });

    ok("migration 008 : sessions existantes conservées à l'identique et autonomes", () => {
        const rows = db
            .prepare(
                `SELECT id, label, scheduled_at, status, created_by,
                        series_id, occurrence_date, local_time, timezone, roster_frozen_at
                 FROM app_sessions ORDER BY id`,
            )
            .all() as Array<{
            id: number; label: string; scheduled_at: string; status: string;
            created_by: number | null; series_id: number | null;
            occurrence_date: string | null; local_time: string | null;
            timezone: string; roster_frozen_at: string | null;
        }>;
        if (sessionSnapshot) {
            // Aucune perte, aucune invention, aucun champ historique déplacé.
            assert.equal(rows.length, sessionSnapshot.length);
            for (let i = 0; i < rows.length; i += 1) {
                const after = rows[i];
                const expected: SessionSnapshotRow = sessionSnapshot[i];
                assert.deepEqual(
                    [after.id, after.label, after.scheduled_at, after.status, after.created_by],
                    [expected.id, expected.label, expected.scheduled_at, expected.status, expected.created_by],
                    `session ${expected.id} inchangée`,
                );
            }
        }
        if (preVersion < 8) {
            // Toutes les sessions pré-existantes restent autonomes ; le
            // fuseau par défaut 'UTC' est le reflet honnête des horodatages
            // stockés en UTC.
            for (const row of rows) {
                assert.equal(row.series_id, null, `session ${row.id} : series_id NULL`);
                assert.equal(row.occurrence_date, null, `session ${row.id} : occurrence_date NULL`);
                assert.equal(row.local_time, null, `session ${row.id} : local_time NULL`);
                assert.equal(row.roster_frozen_at, null, `session ${row.id} : roster non figé`);
                assert.equal(row.timezone, "UTC", `session ${row.id} : timezone UTC`);
            }
        }
    });

    ok("migration 009 : colonnes inherited en place, reprise conservatrice (toute ligne existante = explicite 0)", () => {
        for (const t of ["session_groups", "session_participants"]) {
            const col = (db.prepare(`PRAGMA table_info("${t}")`).all() as Array<{ name: string }>).find(
                (c) => c.name === "inherited",
            );
            assert.ok(col, `colonne inherited sur ${t}`);
        }
        if (preVersion < 9) {
            // Reprise conservatrice : AUCUNE ligne pré-existante ne devient
            // héritable — les appartenances/deltas antérieurs restent des
            // décisions explicites qu'aucune édition de série ne réécrit.
            for (const t of ["session_groups", "session_participants"]) {
                const bad = (db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE inherited <> 0`).get() as { c: number }).c;
                assert.equal(bad, 0, `${t} : ${bad} ligne(s) inherited ≠ 0 inventée(s)`);
            }
        }
    });

    ok("archives legacy_* conservées (aucune donnée supprimée)", () => {
        if (preMigration) {
            // Pre-migration copy : the archive is the exact copy of the legacy tables.
            assert.equal(count(db, "legacy_students"), legacyCounts.students);
            assert.equal(count(db, "legacy_sessions"), legacyCounts.sessions);
            assert.equal(count(db, "legacy_attendances"), legacyCounts.attendances);
        } else {
            // Already migrated database : the migration (a no-op here) must remove nothing
            // from the archives, which must stay identical to themselves before the run.
            assert.ok(archiveCounts);
            assert.equal(count(db, "legacy_students"), archiveCounts.students);
            assert.equal(count(db, "legacy_sessions"), archiveCounts.sessions);
            assert.equal(count(db, "legacy_attendances"), archiveCounts.attendances);
        }
    });

    ok("reprise complète des lignes", () => {
        assert.equal(count(db, "app_students"), legacyCounts.students);
        assert.equal(count(db, "app_sessions"), legacyCounts.sessions);
        assert.equal(count(db, "app_attendances"), legacyCounts.attendances);
        if (preMigration) {
            assert.equal(count(db, "card_scans"), legacyCounts.attendances);
        } else {
            // Post-migration scans (unknown/duplicate) add up to the history.
            assert.ok(count(db, "card_scans") >= legacyCounts.attendances);
        }
    });

    ok("session_groups : backfill du groupe historique sans perte", () => {
        // Any historical session carrying a group (legacy column group_id)
        // must have its membership taken over in the association table.
        const orphan = db
            .prepare(
                `SELECT COUNT(*) AS c FROM app_sessions s
                  WHERE s.group_id IS NOT NULL
                    AND NOT EXISTS (
                        SELECT 1 FROM session_groups sg
                        WHERE sg.session_id = s.id AND sg.group_id = s.group_id
                    )`,
            )
            .get() as { c: number };
        assert.equal(orphan.c, 0, `${orphan.c} sessions sans appartenance`);
    });

    ok("mapping des statuts de session (active→running)", () => {
        const running = count(db, "app_sessions") && (db.prepare("SELECT COUNT(*) c FROM app_sessions WHERE status='running'").get() as { c: number }).c;
        assert.equal(running, legacyActiveSessions);
        const cancelled = (db.prepare("SELECT COUNT(*) c FROM app_sessions WHERE status NOT IN ('scheduled','running','completed')").get() as { c: number }).c;
        if (preMigration) {
            // The legacy only knows pending/active/closed → the migration
            // can NEVER produce a "cancelled" session.
            assert.equal(cancelled, 0);
        }
        // Already migrated database : "cancelled" is legitimate data created by
        // the new server since the migration — nothing to assert about it.
    });

    ok("cartes : UID legacy repris à l'identique, carte active par étudiant", () => {
        const students = createStudentRepository(db);
        for (const [studentId, uid] of legacyCardByStudent) {
            const row = students.findWithCardById(studentId);
            assert.ok(row, `étudiant ${studentId} présent`);
            assert.equal(row.card_uid, uid, `carte de l'étudiant ${studentId} = ${uid}`);
        }
    });

    ok("Phase 3 : lecture des données migrées via les dépôts (états de présence)", () => {
        const attendances = createAttendanceRepository(db);
        if (legacyCounts.attendances > 0) {
            const first = db.prepare("SELECT session_id FROM app_attendances ORDER BY session_id LIMIT 1").get() as { session_id: number };
            const rows = attendances.getSessionAttendance(first.session_id);
            assert.ok(rows.length > 0, "au moins un état de présence lisible");
            assert.ok(rows.every((r) => ISO_RE.test(r.scanned_at)), "horodatages ISO");
        }
    });

    ok("horodatages migrés au format ISO-8601 UTC", () => {
        const bad = db.prepare(
            `SELECT COUNT(*) AS c FROM app_sessions WHERE scheduled_at NOT LIKE '____-__-__T__:__:__.___Z'`,
        ).get() as { c: number };
        assert.equal(bad.c, 0);
    });

    ok("vues legacy : lecture des données migrées", () => {
        const leos = db.prepare("SELECT name, group_name FROM students WHERE card_uid = ?").get("9190864") as { name: string; group_name: string } | undefined;
        if (leos) {
            // Names and group names are MUTABLE dev data (renames, students moved
            // between groups): assert the view join matches the CURRENT physical
            // tables (same name expression as the view) instead of hardcoded
            // historical values.
            const physical = db.prepare(
                `SELECT TRIM(s.first_name || COALESCE(' ' || s.last_name, '')) AS name,
                        g.name AS group_name
                 FROM cards c
                 JOIN app_students s ON s.id = c.student_id
                 LEFT JOIN groups g ON g.id = s.group_id
                 WHERE c.uid = ? AND c.revoked_at IS NULL`,
            ).get("9190864") as { name: string; group_name: string | null } | undefined;
            assert.equal(leos.name, physical?.name ?? null);
            assert.equal(leos.group_name, physical?.group_name ?? null);
        }
        const activeViewCount = (db.prepare("SELECT COUNT(*) c FROM sessions WHERE status='active'").get() as { c: number }).c;
        assert.equal(activeViewCount, legacyActiveSessions);
        assert.equal(count(db, "attendances"), legacyCounts.attendances);
    });

    ok("chemin legacy complet : scan dupliqué → SQLITE_CONSTRAINT_UNIQUE (record() → null)", () => {
        const existing = db.prepare("SELECT session_id, student_id FROM app_attendances LIMIT 1").get() as { session_id: number; student_id: number };
        throwsWith(
            () => db.prepare("INSERT INTO attendances (session_id, student_id, is_valid) VALUES (?, ?, 1)").run(existing.session_id, existing.student_id),
            "SQLITE_CONSTRAINT_UNIQUE",
            `re-scan étudiant ${existing.student_id} dans session ${existing.session_id}`,
        );
    });

    ok("cycle legacy complet sur la copie (create/activate/close/reset)", () => {
        db.prepare("INSERT INTO sessions (label, scheduled_at, duration_minutes) VALUES (?,?,?)")
            .run("Vérif cycle", isoNow(), 5);
        const sessions = db.prepare("SELECT id FROM sessions ORDER BY id DESC LIMIT 1").get() as { id: number };
        db.prepare("UPDATE sessions SET status='active', rfid_enabled=1 WHERE id=?").run(sessions.id);
        assert.equal((db.prepare("SELECT rfid_enabled FROM sessions WHERE id=?").get(sessions.id) as { rfid_enabled: number }).rfid_enabled, 1);

        const student = db.prepare("SELECT id FROM students WHERE card_uid IS NOT NULL LIMIT 1").get() as { id: number };
        db.prepare("INSERT INTO attendances (session_id, student_id, is_valid) VALUES (?,?,1)").run(sessions.id, student.id);
        assert.equal((db.prepare("SELECT COUNT(*) c FROM attendances WHERE session_id=?").get(sessions.id) as { c: number }).c, 1);

        // Legacy reset() : DELETE then re-activation — the card_scans history survives.
        db.prepare("DELETE FROM attendances WHERE session_id = ?").run(sessions.id);
        assert.equal((db.prepare("SELECT COUNT(*) c FROM attendances WHERE session_id=?").get(sessions.id) as { c: number }).c, 0);
        assert.equal((db.prepare("SELECT COUNT(*) c FROM card_scans WHERE session_id=?").get(sessions.id) as { c: number }).c, 1);

        db.prepare("UPDATE sessions SET status='closed', rfid_enabled=0 WHERE id=?").run(sessions.id);
        const closed = db.prepare("SELECT status, ended_at FROM app_sessions WHERE id=?").get(sessions.id) as { status: string; ended_at: string | null };
        assert.equal(closed.status, "completed");
        assert.ok(closed.ended_at);
    });

    ok("cycle legacy étudiants (insert/update carte/delete)", () => {
        db.prepare("INSERT INTO students (name, card_uid, group_name, email) VALUES (?,?,?,?)").run("Ada Z", "9500001", "G9", "ada@test");
        const row = db.prepare("SELECT id, group_name FROM students WHERE card_uid='9500001'").get() as { id: number; group_name: string };
        assert.equal(row.group_name, "G9"); // group created on the fly

        db.prepare("UPDATE students SET card_uid='9500002' WHERE id=?").run(row.id);
        assert.equal((db.prepare("SELECT card_uid FROM students WHERE id=?").get(row.id) as { card_uid: string }).card_uid, "9500002");
        assert.equal((db.prepare("SELECT COUNT(*) c FROM cards WHERE uid='9500001' AND revoked_at IS NOT NULL").get() as { c: number }).c, 1);

        db.prepare("DELETE FROM students WHERE id=?").run(row.id);
        assert.equal((db.prepare("SELECT COUNT(*) c FROM app_students WHERE id=?").get(row.id) as { c: number }).c, 0);
        assert.equal((db.prepare("SELECT student_id IS NULL FROM cards WHERE uid='9500002'").get() as { "student_id IS NULL": number })["student_id IS NULL"], 1);
    });

    ok("intégrité après migration : foreign_key_check / integrity_check", () => {
        assert.deepEqual(db.pragma("foreign_key_check"), []);
        assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
    });

    db.close();
}

// ═══════════════════════════════════════════════════════════════════════════════

export function runDatabaseVerification(devDatabasePath: string): void {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rfweb-db-verify-"));
    try {
        verifyFreshDatabase(tmpDir);
        if (fs.existsSync(devDatabasePath)) {
            verifyExistingDatabase(tmpDir, devDatabasePath);
        } else {
            console.log(`── B. Existing database : ${devDatabasePath} not found, phase skipped ──`);
        }
        console.log(`\n[DB:VERIFY] ${checks} checks passed ✅`);
    } finally {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            console.warn(`[DB:VERIFY] (manual cleanup required : ${tmpDir})`);
        }
    }
}
