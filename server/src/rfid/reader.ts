// RFID reader abstraction: the RfidReader interface + the hardware adapter
// (rfid/rfidApi.js, node-hid worker) behind an injectable accessor.
//
// Only layer allowed to touch the hardware. Imports ONLY rfidApi.js
// (readCard/beep/isOnline) — never rfid/scanLoop.js, whose application logic
// is replaced by services/scanService.ts. The legacy side effect (starting
// the USB worker at import time) is deliberately deferred: lazy require() on
// first access, and RFID_DISABLED=1 short-circuits it entirely (offline
// stub — server and API usable without hardware).
//
// Services never import the hardware directly: they resolve the ACTIVE reader
// through getReader() on every operation, and tests swap the implementation
// with setReader() (FakeRfidReader — see rfid/fakeReader.ts). Production
// wiring is the default: hardware adapter, or offline stub when RFID_DISABLED.

import { RFID_DISABLED } from "../config/env";
import { logger } from "../core/logger";

const rfidLog = logger.child({ component: "rfid" });

export interface CardReading {
    decID: string; // UID in decimal (string) — the only stored representation
    hexID: string;
}

export interface RfidReader {
    isOnline(): boolean;
    readCard(): Promise<CardReading>;
    beep(): Promise<void>;
}

interface RfidApiModule {
    readCard(): Promise<CardReading>;
    beep(): Promise<void>;
    isReaderOnline(): boolean;
}

function createRealReader(): RfidReader {
    // Lazy loading: only starts the USB worker when it is actually used.
    let api: RfidApiModule | null = null;
    const load = (): RfidApiModule => {
        if (!api) {
            rfidLog.info("rfid.loading");
            api = require("../../../rfid/rfidApi.js") as RfidApiModule;
        }
        return api;
    };
    return {
        isOnline: () => load().isReaderOnline(),
        readCard: () => load().readCard(),
        beep: () => load().beep(),
    };
}

// Offline stub (tests, CI, dev without a reader): never online, reads that
// never resolve, beep refused — no hardware dependency.
function createStubReader(): RfidReader {
    return {
        isOnline: () => false,
        readCard: () => new Promise<CardReading>(() => undefined),
        beep: () => Promise.reject(new Error("RFID reader disabled (RFID_DISABLED).")),
    };
}

// ─── Dependency injection ─────────────────────────────────────────────────────
// The active reader is resolved through getReader() on EVERY operation, so a
// setReader() swap is honored immediately — even by a scan loop already
// running. Production keeps the default below (unchanged boot behavior).

let activeReader: RfidReader = RFID_DISABLED ? createStubReader() : createRealReader();

export function getReader(): RfidReader {
    return activeReader;
}

// Replaces the active reader (test seam). Returns a function restoring the
// previously active one.
export function setReader(reader: RfidReader): () => void {
    const previous = activeReader;
    activeReader = reader;
    return () => {
        activeReader = previous;
    };
}

if (RFID_DISABLED) {
    rfidLog.info("rfid.disabled");
}
