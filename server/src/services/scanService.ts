// Scan loop service — replaces rfid/scanLoop.js (legacy) for the new
// application. Only one loop at a time (single reader): it reads
// cards and hands them to attendanceService; no business logic here.
//
// The reader may be offline: the loop waits/retries without ever
// bringing the server down. Stopping is explicit (session stop,
// server restart) — no automatic duration-based expiration.

import { getReader } from "../rfid/reader";
import { errorFields, logger } from "../core/logger";
import type { SessionRow } from "../db/types";
import { handleScan } from "./attendanceService";

const scanLog = logger.child({ component: "rfid" });

const SCAN_DELAY_MS = 1000;
const SCAN_RETRY_MS = 1500;

interface LoopState {
    running: boolean;
    sessionId: number | null;
    generation: number;
}

let state: LoopState = { running: false, sessionId: null, generation: 0 };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function isRunning(): boolean {
    return state.running;
}

export function currentSessionId(): number | null {
    return state.running ? state.sessionId : null;
}

export function startScan(session: SessionRow): void {
    stopScan();
    const generation = state.generation + 1;
    state = { running: true, sessionId: session.id, generation };
    scanLog.info("scan.loop_started", { session_id: session.id });
    if (!getReader().isOnline()) {
        scanLog.warn("scan.reader_offline", { session_id: session.id });
    }
    void loop(generation, session.id);
}

export function stopScan(): void {
    if (!state.running) return;
    scanLog.info("scan.loop_stopped", { session_id: state.sessionId });
    state.running = false;
    state.sessionId = null;
    state.generation += 1;
}

async function loop(generation: number, sessionId: number): Promise<void> {
    const active = (): boolean => state.running && state.generation === generation && state.sessionId === sessionId;

    while (active()) {
        // Resolved per iteration: a reader swapped via setReader() is picked
        // up by a loop already running.
        const reader = getReader();
        if (!reader.isOnline()) {
            await sleep(SCAN_RETRY_MS);
            continue;
        }

        let uid: string;
        try {
            const reading = await reader.readCard();
            uid = reading.decID;
        } catch (err) {
            if (active()) scanLog.warn("scan.read_error", errorFields(err));
            await sleep(SCAN_RETRY_MS);
            continue;
        }

        if (!active()) break;

        try {
            await handleScan(uid);
        } catch (err) {
            // E.g. session stopped between the read and the processing: normal,
            // nothing must bring the loop down.
            scanLog.warn("scan.unprocessed", { uid, ...errorFields(err) });
        }
        await sleep(SCAN_DELAY_MS);
    }
}
