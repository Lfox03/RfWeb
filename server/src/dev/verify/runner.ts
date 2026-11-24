// Orchestrator of `npm run api:verify`: boots the suite's own app + WS server
// on ephemeral ports, runs the 32 sections in order (they share state through
// the explicit VerifyContext), then tears everything down. Entry point stays
// server/src/dev/verifyApi.ts (environment must load first).
import fs from "node:fs";
import http from "node:http";

import { tmpDir } from "./environment";
import { Client } from "./helpers";
import type { VerifyContext } from "./context";

import { run as s01 } from "./sections/01-health";
import { run as s02 } from "./sections/02-auth";
import { run as s03 } from "./sections/03-roles";
import { run as s04 } from "./sections/04-groups";
import { run as s05 } from "./sections/05-students";
import { run as s06 } from "./sections/06-cards";
import { run as s07 } from "./sections/07-sessions-lifecycle";
import { run as s08 } from "./sections/08-attendance";
import { run as s09 } from "./sections/09-reader-offline";
import { run as s10 } from "./sections/10-error-formats";
import { run as s11 } from "./sections/11-websocket";
import { run as s12 } from "./sections/12-password-logout";
import { run as s13 } from "./sections/13-accounts";
import { run as s14 } from "./sections/14-reports";
import { run as s15 } from "./sections/15-kiosk-scheduler";
import { run as s16 } from "./sections/16-csv-import";
import { run as s17 } from "./sections/17-rate-limit";
import { run as s18 } from "./sections/18-fake-reader";
import { run as s19 } from "./sections/19-backup";
import { run as s20 } from "./sections/20-restore";
import { run as s21 } from "./sections/21-fake-clock";
import { run as s22 } from "./sections/22-logging";
import { run as s23 } from "./sections/23-persistent-sessions";
import { run as s24 } from "./sections/24-logs-api";
import { run as s25 } from "./sections/25-series-service";
import { run as s26 } from "./sections/26-series-api";
import { run as s27 } from "./sections/27-frozen-roster";
import { run as s28 } from "./sections/28-scheduler-generation";
import { run as s29 } from "./sections/29-phase4-calendar";
import { run as s30 } from "./sections/30-phase5-provenance";
import { run as s31 } from "./sections/31-local-kiosk";
import { run as s32 } from "./sections/32-one-off-participants";

export async function runSuite(): Promise<void> {
    try {
        const { createApp } = await import("../../app");
        const { attachWebSocketServer, startWebSocketServer } = await import("../../websocket/server");
        const { userRepository } = await import("../../db");
        const { hashPassword } = await import("../../auth/password");
        const attendanceService = await import("../../services/attendanceService");
        const sessionService = await import("../../services/sessionService");
        const { getStatus: readerStatus } = await import("../../services/readerService");

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
        const borne = new Client(base); // kiosk account, logged in by section 15

        const ctx: VerifyContext = {
            base,
            httpPort,
            wsPort,
            anon,
            admin,
            teacher,
            borne,
            sessionService,
            attendanceService,
            userRepository,
            g1: null,
            ada: null,
            alan: null,
        };

        const sections: Array<(ctx: VerifyContext) => Promise<void>> = [
            s01, s02, s03, s04, s05, s06, s07, s08, s09, s10,
            s11, s12, s13, s14, s15, s16, s17, s18, s19, s20,
            s21, s22, s23, s24, s25, s26, s27, s28, s29, s30,
            s31, s32,
        ];
        for (const run of sections) await run(ctx);
    } finally {
        // Close the database (singleton opened by import): without this Windows
        // keeps the file locked and cleanup fails.
        try {
            const { db } = await import("../../db");
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
