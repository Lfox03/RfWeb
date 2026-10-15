// Main server entry point (new TypeScript architecture).
// Phase 3: NO legacy left in the execution path — no db/queries.js,
// no legacy scanLoop, no web/socket.js, and ABOVE ALL no session
// automatically created at startup. The server starts AT REST:
// migrated DB → HTTP → WebSocket → reader monitoring → waits for the API.

import "./config/env";

// Opens the database and applies migrations before the repositories.
import "./db";

import { HTTP_HOST, HTTP_PORT, WS_PORT } from "./config/env";
import { createApp } from "./app";
import { errorFields, logger } from "./core/logger";
import { authService, sessionService } from "./services";
import { startReaderMonitor, stopReaderMonitor, getStatus as getReaderStatus } from "./services/readerService";
import { startSessionScheduler, stopSessionScheduler } from "./services/schedulerService";
import { attachWebSocketServer, startWebSocketServer } from "./websocket/server";

const log = logger.child({ component: "http" });

log.debug("http.starting");

// Login sessions are persistent (auth_sessions): sweep the ones that expired
// while the server was down. Silent — expired rows are rejected on lookup
// even without this cleanup.
authService.purgeExpiredSessions();

const app = createApp();

const httpServer = HTTP_HOST ? app.listen(HTTP_PORT, HTTP_HOST, onListening) : app.listen(HTTP_PORT, onListening);

function onListening(): void {
    log.info("http.listening", { host: HTTP_HOST || "127.0.0.1", port: HTTP_PORT });
}

httpServer.on("error", (err: NodeJS.ErrnoException) => {
    log.error("http.listen_error", { port: HTTP_PORT, ...errorFields(err) });
    process.exit(1);
});

// WebSocket: domain events only (protocol in websocket/hub.ts).
// The same hub is additionally mounted on the HTTP server at /ws so the React
// client can open a same-origin WebSocket in production without learning any
// port (the standalone WS_PORT transport stays available for compatibility).
const getStatusSnapshot = () => ({
    readerOnline: getReaderStatus().online,
    session: sessionService.getActive(),
});

// A WS_PORT clash (e.g. another local service squatting on 8080) must NOT
// take the whole server down: the HTTP-mounted /ws transport below is what
// the React client (dev proxy included) actually uses.
const wsHandle = startWebSocketServer(getStatusSnapshot).catch((err: Error) => {
    logger.warn("ws.standalone_unavailable", {
        port: WS_PORT,
        fallback: `/ws (HTTP port ${HTTP_PORT})`,
        ...errorFields(err),
    });
    return null;
});
attachWebSocketServer(httpServer, getStatusSnapshot);

// The reader is monitored independently of the API (online/offline → WS).
startReaderMonitor();

// Automatic start/stop of sessions at the scheduled time (window
// scheduled_at → scheduled_at + duration) + rolling generation of the active
// recurring series (once at boot, then at every tick — scheduled occurrences
// only). No session is ever invented nor started by the boot itself.
startSessionScheduler();

let shuttingDown = false;
function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("http.shutdown", { signal });
    stopSessionScheduler();
    stopReaderMonitor();
    void (async () => {
        try {
            const handle = await wsHandle;
            if (handle) handle.close();
        } catch {
            /* already closed */
        }
        httpServer.close(() => process.exit(0));
        // Safety net: do not stay blocked on a keep-alive connection.
        setTimeout(() => process.exit(0), 2_000).unref();
    })();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
