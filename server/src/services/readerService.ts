// Reader service — reader state and beep, exposed to the API and to the
// WebSocket. The scan loop lives in scanService; the reader itself is the
// ACTIVE reader resolved through getReader() (rfid/reader.ts), never the
// hardware directly.
//
// The legacy rfidApi.js only publishes isReaderOnline()/onReaderReady():
// monitoring is therefore a lightweight periodic probe (2 s) that broadcasts a
// reader:status only on CHANGE — no HTTP polling on the client side.

import { ReaderBusyError, ReaderOfflineError, ReaderTimeoutError } from "../core/errors";
import { logger } from "../core/logger";
import { sessionRepository } from "../db";
import { getReader, type CardReading } from "../rfid/reader";
import { broadcastEvent } from "../websocket/hub";
import { currentSessionId, isRunning } from "./scanService";

const readerLog = logger.child({ component: "rfid" });

const MONITOR_INTERVAL_MS = 2_000;

export interface ReaderStatus {
    online: boolean;
    scanRunning: boolean;
    sessionId: number | null;
    activeSession: { id: number; label: string } | null;
}

export function getStatus(): ReaderStatus {
    const active = sessionRepository.findActive();
    return {
        online: safeOnline(),
        scanRunning: isRunning(),
        sessionId: currentSessionId(),
        activeSession: active ? { id: active.id, label: active.label } : null,
    };
}

export async function beep(): Promise<void> {
    if (!safeOnline()) throw new ReaderOfflineError();
    try {
        await getReader().beep();
    } catch (err) {
        throw new ReaderOfflineError(`Bip impossible : ${(err as Error).message}`);
    }
}

// ─── One-shot card read ("present a card" card-assignment workflow) ─────────
//
// Used by POST /api/reader/next-card so the browser can capture a card UID
// without ever touching the hardware (and without a running session). Guards:
// the scan loop owns the reader while a session runs (409), the reader must be
// online (503), and a timed-out read is reported as 504.
//
// CAVEAT (hardware API limitation, rfid/rfidApi.js keeps one pending read
// until a card answers): after a timeout the underlying read stays armed
// server-side; the next presented card satisfies it and is silently consumed
// (logged below). The busy guard then clears by itself.
const PROBE_TIMEOUT_MS = 45_000;

let pendingProbe: Promise<CardReading> | null = null;

export async function nextCard(timeoutMs = PROBE_TIMEOUT_MS): Promise<CardReading> {
    if (isRunning()) {
        throw new ReaderBusyError("Une session est en cours : le lecteur est occupé par le pointage.");
    }
    if (pendingProbe) {
        throw new ReaderBusyError("Une lecture de carte est déjà en attente côté lecteur.");
    }
    if (!safeOnline()) throw new ReaderOfflineError();

    const read = getReader().readCard();
    pendingProbe = read;
    read.then(
        () => {
            pendingProbe = null;
        },
        () => {
            pendingProbe = null;
        },
    );

    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            read,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new ReaderTimeoutError()), timeoutMs);
            }),
        ]);
    } catch (err) {
        if (err instanceof ReaderTimeoutError) {
            // Swallow the orphaned read: it will consume the next presented
            // card; make that visible in the server log.
            read.then(
                (reading) => readerLog.info("reader.probe_card_ignored", { uid: reading.decID }),
                () => {
                    /* underlying read rejected: nothing to swallow */
                },
            );
            throw err;
        }
        throw new ReaderOfflineError(`Lecture impossible : ${(err as Error).message}`);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function safeOnline(): boolean {
    try {
        return getReader().isOnline();
    } catch {
        return false; // a crashing adapter must never bring the server down
    }
}

let monitorTimer: NodeJS.Timeout | null = null;
let lastOnline: boolean | null = null;

// Watches reader connect/disconnect and broadcasts reader:status.
export function startReaderMonitor(): void {
    if (monitorTimer) return;
    const tick = (): void => {
        const online = safeOnline();
        if (online === lastOnline) return;
        const first = lastOnline === null;
        lastOnline = online;
        if (first) return; // the initial state is given by the snapshot on WS connection
        readerLog.info(online ? "reader.connected" : "reader.disconnected");
        broadcastEvent("reader:status", { online });
    };
    tick();
    monitorTimer = setInterval(tick, MONITOR_INTERVAL_MS);
    monitorTimer.unref(); // does not hold the process (tests, clean shutdown)
}

export function stopReaderMonitor(): void {
    if (monitorTimer) {
        clearInterval(monitorTimer);
        monitorTimer = null;
    }
}
