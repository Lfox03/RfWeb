const { parentPort } = require("worker_threads");
const HID = require("node-hid");

// ─── USB config ────────────────────────
const VID = 0x6688;
const PID = 0x6850;

// ─── scanner protocol ──────────────────
const MSG_START  = 0x01;
const MSG_END    = 0x04;
const DIR_CLIENT = 0x03;
const DIR_DEVICE = 0x05;

const CMD_EM4100_READ = [0x10];
const CMD_CARRIER     = [0x14];
const CMD_BELL        = [0x03];


// ─── connections ───────────────────────
const RECONNECT_INTERVAL = 5000;
const MAX_RETRIES = Infinity;

let reconnectTimer = null;
let connectionAttempts = 0;

let dev = null;

// ─── Low level ────────────────────────────────────────────────────────────────

function calcChecksum(bytes) {
    return bytes.reduce((crc, b) => crc ^ b, 0);
}

function buildPacket(cmd, params = []) {
    const length = params.length + 5;
    const body   = [MSG_START, length, ...cmd, ...params];
    return [...body, calcChecksum(body), MSG_END];
}

function send(dev, cmd, params = []) {
    dev.write([DIR_CLIENT, ...buildPacket(cmd, params)]);
}

function receive(dev) {
    const raw = dev.readSync();
    if (raw && raw.length > 2 && raw[0] === DIR_DEVICE) {
        return raw.slice(1, raw[2] + 1);
    }
    return [];
}

function parseCardId(rsp) {
    const data = rsp.slice(3, rsp[1] - 2);
    return data.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
}

// ─── Scanner connection init ─────────────────────────────────────────────────

function attemptConnection() {
    try {
        dev = new HID.HID(VID, PID);
        connectionAttempts = 0;
        parentPort.postMessage({ event: "ready" });
        console.log("[RFID Worker] Connected to reader");
        return true;
    } catch (e) {
        connectionAttempts++;
        const retryMsg = MAX_RETRIES === Infinity 
            ? `(new attempt in ${RECONNECT_INTERVAL / 1000}s)`
            : `(attempt ${connectionAttempts}/${MAX_RETRIES})`;
        console.warn(`[RFID Worker] Connection failed ${retryMsg}: ${e.message}`);
        
        if (connectionAttempts === 1) {
            parentPort.postMessage({ event: "error", message: `Connexion lecteur impossible : ${e.message}` });
        }
        
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
            console.log("[RFID Worker] Reconnection attempt...");
            attemptConnection();
        }, RECONNECT_INTERVAL);
        
        return false;
    }
}

attemptConnection();

// ─── Main thread link ─────────────────────────────────────────────────────────

parentPort.on("message", ({ cmd }) => {
    if (!dev) {
        parentPort.postMessage({ event: "error", message: "Lecteur non connecté." });
        return;
    }

    if (cmd === "beep") {
        try {
            send(dev, CMD_BELL, [0x03]);
            receive(dev);
            parentPort.postMessage({ event: "beep_ok" });
        } catch (e) {
            console.error("[RFID Worker] Beep error:", e.message);
            dev = null;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            attemptConnection();
            parentPort.postMessage({ event: "beep_error", message: `${e}` });
        }
        return;
    }

    if (cmd === "read") {
        try {
            send(dev, CMD_CARRIER, [0x03]);   // RF field ON
            receive(dev);

            let rsp = [];
            while (true) {
                send(dev, CMD_EM4100_READ);
                rsp = receive(dev);
                if (rsp.length > 6) break;
            }

            send(dev, CMD_CARRIER, [0x02]);   // RF field OFF
            receive(dev);

            const id = parseCardId(rsp);
            parentPort.postMessage({
                event: "result",
                decID: id.toString(10),
                hexID: id.toString(16).toUpperCase(),
            });
        } catch (e) {
            console.error("[RFID Worker] Read error:", e.message);
            dev = null;
            try { send(dev, CMD_CARRIER, [0x02]); receive(dev); } catch (_) {}
            if (reconnectTimer) clearTimeout(reconnectTimer);
            attemptConnection();
            parentPort.postMessage({ event: "error", message: `${e}` });
        }
        return;
    }
});