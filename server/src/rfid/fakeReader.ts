// RfidReader test double: deterministic card injection and online/offline
// simulation without any USB hardware. Injected with setReader() (see
// rfid/reader.ts) — used by api:verify, never by production boot.
//
// Behavior mirrors the hardware adapter: readCard() resolves when a card is
// presented (staying armed in the meantime), and losing the connection
// rejects the read that is currently armed.

import type { CardReading, RfidReader } from "./reader";

interface WaitingRead {
    resolve: (reading: CardReading) => void;
    reject: (err: Error) => void;
}

export class FakeRfidReader implements RfidReader {
    private online = false;
    private readonly buffer: CardReading[] = [];
    private readonly waiting: WaitingRead[] = [];
    private beeps = 0;

    // Reads currently armed, waiting for a card (tests wait on this to know
    // the scan loop or a next-card probe has reached the reader).
    get pendingReads(): number {
        return this.waiting.length;
    }

    get beepCount(): number {
        return this.beeps;
    }

    isOnline(): boolean {
        return this.online;
    }

    // Connects/disconnects the simulated reader. Going offline rejects the
    // armed reads, as the real adapter does when the USB link is lost.
    setOnline(online: boolean): void {
        if (this.online === online) return;
        this.online = online;
        if (!online) {
            for (const w of this.waiting.splice(0)) {
                w.reject(new Error("Lecteur RFID déconnecté (simulation)."));
            }
        }
    }

    // Presents a card: served to the armed read if any, otherwise buffered
    // until the next readCard().
    presentCard(decID: string, hexID = `0x${decID}`): void {
        const reading: CardReading = { decID, hexID };
        const next = this.waiting.shift();
        if (next) next.resolve(reading);
        else this.buffer.push(reading);
    }

    readCard(): Promise<CardReading> {
        if (!this.online) return Promise.reject(new Error("Lecteur RFID hors ligne (simulation)."));
        const buffered = this.buffer.shift();
        if (buffered) return Promise.resolve(buffered);
        return new Promise<CardReading>((resolve, reject) => {
            this.waiting.push({ resolve, reject });
        });
    }

    beep(): Promise<void> {
        if (!this.online) return Promise.reject(new Error("Lecteur RFID hors ligne (simulation)."));
        this.beeps += 1;
        return Promise.resolve();
    }
}
