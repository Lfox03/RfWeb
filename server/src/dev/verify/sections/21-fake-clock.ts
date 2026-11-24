// Horloge injectable : scheduler et transitions déterministes (FakeClock) — api:verify section 21
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { ok } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { g1, sessionService, teacher } = ctx;
    let res: ApiResponse;
    const scheduler = await import("../../../services/schedulerService"); // same tick driver as section 15

    console.log("── 21. Horloge injectable : scheduler et transitions déterministes (FakeClock) ──");
    {
        const { getClock, setClock, systemClock } = await import("../../../core/clock");
        const { FakeClock } = await import("../../../core/fakeClock");
        const { isoNow } = await import("../../../db/types");

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
}
