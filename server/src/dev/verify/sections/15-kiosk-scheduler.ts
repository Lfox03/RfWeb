// Kiosk account and automatic scheduler — api:verify section 15
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { ok } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { admin, borne, g1, sessionService, teacher, userRepository } = ctx;
    let res: ApiResponse;

    console.log("── 15. Kiosk account and automatic scheduler ──");
    // Kiosk account: read-only on the API, never management.
    res = await admin.call("POST", "/api/users", { username: "borne1", password: "borne-pass-123", role: "kiosk" });
    ok("admin crée un compte kiosk → 201 (rôle kiosk)", res.status === 201 && res.body.data.role === "kiosk");
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
    const scheduler = await import("../../../services/schedulerService");
    const { sessionRepository: sessionsRepo } = await import("../../../db");
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
}
