const { Worker } = require("worker_threads");
const path = require("path");
 
// ─── Worker ───────────────────────────────────────────────────────────────────
 
console.log("[RFID] loading...");
 
const worker = new Worker(path.join(__dirname, "/rfidWorker.js"));
 
// ─── Connection state ─────────────────────────────────────────────────────────
let readerOnline = false;
const readyCallbacks = [];
let wasEverOnline = false;

 
const pending = {
    read: null,   // { resolve, reject } | null
    beep: null,
};
 
worker.on("message", (msg) => {
    switch (msg.event) {
        case "ready":
            if (!readerOnline) {
                if (wasEverOnline) {
                    console.log("[RFID] Scanner reconnected.");
                } else {
                    console.log("[RFID] Scanner ready.");
                    wasEverOnline = true;
                }
            }
            readerOnline = true;
            // Notify pending callbacks
            readyCallbacks.forEach(cb => cb());
            readyCallbacks.length = 0;
            break;
 
        case "result":
            if (pending.read) {
                pending.read.resolve({ decID: msg.decID, hexID: msg.hexID });
                pending.read = null;
            }
            break;
 
        case "beep_ok":
            if (pending.beep) {
                pending.beep.resolve();
                pending.beep = null;
            }
            break;
 
        case "error":
            if (readerOnline) {
                console.warn("[RFID] Reader connection lost. Attempting to reconnect...");
                readerOnline = false;
            }
            if (pending.read) {
                pending.read.reject(new Error(msg.message));
                pending.read = null;
            } else if (pending.beep) {
                pending.beep.reject(new Error(msg.message));
                pending.beep = null;
            } else {
                console.error("[RFID worker]", msg.message);
            }
            break;
 
        case "beep_error":
            if (pending.beep) {
                pending.beep.reject(new Error(msg.message));
                pending.beep = null;
            }
            break;
    }
});
 
worker.on("error", (e) => console.error("[RFID worker]", e));
worker.on("exit", (c) => console.warn(`[RFID worker] exited (code ${c})`));
 
// ─── Public API ───────────────────────────────────────────────────────────────
 
/**
 * Reads an RFID card.
 * @returns {Promise<{ decID: string, hexID: string }>}
 */
function readCard() {
    if (pending.read) {
        return Promise.reject(new Error("Un scan est déjà en cours."));
    }
    return new Promise((resolve, reject) => {
        pending.read = { resolve, reject };
        worker.postMessage({ cmd: "read" });
    });
}
 
/**
 * Triggers the scanner beep.
 * @returns {Promise<void>}
 */
function beep() {
    if (pending.beep) {
        return Promise.reject(new Error("Un beep est déjà en cours."));
    }
    return new Promise((resolve, reject) => {
        pending.beep = { resolve, reject };
        worker.postMessage({ cmd: "beep" });
    });
}

/**
 * Checks whether the reader is online.
 * @returns {boolean}
 */
function isReaderOnline() {
    return readerOnline;
}

/**
 * Waits for the reader to be ready (callback called when connected).
 * If already online, calls immediately. Otherwise, waits for the "ready" message.
 * @param {Function} callback - Function to call when the reader is ready
 * @returns {Promise<void>}
 */
function onReaderReady(callback) {
    if (readerOnline) {
        callback();
        return Promise.resolve();
    }
    readyCallbacks.push(callback);
    return new Promise((resolve) => {
        readyCallbacks.push(resolve);
    });
}

module.exports = { readCard, beep, isReaderOnline, onReaderReady };