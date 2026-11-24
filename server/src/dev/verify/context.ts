// Shared state of the api:verify suite, made explicit: sections run
// SEQUENTIALLY (runner.ts) and a section may read what earlier sections
// left behind. Everything else stays local to its section's file.
import type { Client } from "./helpers";

export interface VerifyContext {
    /** Base URL of the suite's own HTTP server (loopback, ephemeral port). */
    base: string;
    /** HTTP port — also hosts the mounted same-origin /ws transport. */
    httpPort: number;
    /** Port of the standalone WS transport (startWebSocketServer). */
    wsPort: number;

    /** Suite-wide HTTP clients (each keeps its own `sid` cookie). */
    anon: Client;
    admin: Client;
    teacher: Client;
    /** Kiosk client — created here, logged in as « borne1 » by section 15. */
    borne: Client;

    /** Services resolved at boot (the very singletons the routers use). */
    sessionService: typeof import("../../services/sessionService");
    attendanceService: typeof import("../../services/attendanceService");
    /**
     * Repository snapshot taken at boot — used by sections 7/12/13 only,
     * i.e. BEFORE sections 19–23 swap the underlying connection (restore,
     * simulated restart). Later sections re-import the module fresh to get
     * the live bindings back (see their « dbXX » aliases).
     */
    userRepository: typeof import("../../db")["userRepository"];

    /** Entity rows shared across sections (created by sections 4 and 5). */
    g1: any;
    ada: any;
    alan: any;
}
