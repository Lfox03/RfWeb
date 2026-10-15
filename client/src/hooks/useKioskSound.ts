// Browser-side audio feedback for the kiosk (Phase 6).
//
// Purely additive: visual feedback is ALWAYS the authoritative channel. The
// WebAudio context is created lazily and stays locked ("suspended") under the
// browser autoplay policy until the user interacts with the kiosk; scans
// before that unlock simply play no sound. No audio files: short oscillator
// blips. This is NOT the RFID reader hardware beep (backend concern).

import { useCallback, useEffect, useRef, useState } from "react";

import type { ScanResult } from "../types/domain";

const STORAGE_KEY = "kiosk.sound.enabled";

export interface KioskSound {
    enabled: boolean;
    setEnabled: (on: boolean) => void;
    // False while the browser autoplay policy has locked audio output.
    unlocked: boolean;
    play: (result: ScanResult) => void;
}

function readEnabled(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) !== "0";
    } catch {
        return true; // private mode: default on, never throw
    }
}

function storeEnabled(on: boolean): void {
    try {
        localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
    } catch {
        /* not persistable: keep in-memory only */
    }
}

export function useKioskSound(): KioskSound {
    const ctxRef = useRef<AudioContext | null>(null);
    const [enabled, setEnabledState] = useState(readEnabled);
    const [unlocked, setUnlocked] = useState(false);

    // Autoplay policy: any pointer/key interaction may unlock audio. Listeners
    // are removed on unmount; enabling audio via the toggle also attempts it.
    useEffect(() => {
        const unlock = (): void => {
            const ctx = ctxRef.current;
            if (!ctx) return;
            if (ctx.state === "running") {
                setUnlocked(true);
                return;
            }
            void ctx
                .resume()
                .then(() => setUnlocked(true))
                .catch(() => setUnlocked(false));
        };
        window.addEventListener("pointerdown", unlock);
        window.addEventListener("keydown", unlock);
        return () => {
            window.removeEventListener("pointerdown", unlock);
            window.removeEventListener("keydown", unlock);
        };
    }, []);

    useEffect(
        () => () => {
            void ctxRef.current?.close().catch(() => {});
            ctxRef.current = null;
        },
        [],
    );

    const setEnabled = useCallback((on: boolean) => {
        setEnabledState(on);
        storeEnabled(on);
        // The click itself counts as a user gesture: try to unlock right away.
        const ctx = ctxRef.current;
        if (on && ctx && ctx.state === "suspended") {
            void ctx
                .resume()
                .then(() => setUnlocked(true))
                .catch(() => {});
        }
    }, []);

    const play = useCallback(
        (result: ScanResult) => {
            if (!enabled) return;
            let ctx = ctxRef.current;
            try {
                if (!ctx) {
                    ctx = new AudioContext();
                    ctxRef.current = ctx;
                }
            } catch {
                return; // WebAudio unavailable: visuals carry the feedback
            }
            if (ctx.state !== "running") {
                // Still locked by the autoplay policy: this scan stays silent.
                void ctx.resume().catch(() => {});
                return;
            }

            const tone = (freq: number, start: number, duration: number, type: OscillatorType, gainValue: number): void => {
                const osc = ctx!.createOscillator();
                const gain = ctx!.createGain();
                osc.type = type;
                osc.frequency.value = freq;
                const t0 = ctx!.currentTime + start;
                gain.gain.setValueAtTime(0, t0);
                gain.gain.linearRampToValueAtTime(gainValue, t0 + 0.01);
                gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
                osc.connect(gain).connect(ctx!.destination);
                osc.start(t0);
                osc.stop(t0 + duration + 0.02);
            };

            switch (result) {
                case "accepted":
                    tone(660, 0, 0.12, "sine", 0.08);
                    tone(880, 0.12, 0.18, "sine", 0.08);
                    break;
                case "duplicate":
                    tone(520, 0, 0.16, "triangle", 0.07);
                    break;
                case "unknown":
                case "expired":
                    tone(300, 0, 0.16, "square", 0.04);
                    tone(220, 0.18, 0.22, "square", 0.04);
                    break;
                case "out_of_group":
                    tone(392, 0, 0.14, "triangle", 0.06);
                    tone(330, 0.16, 0.2, "triangle", 0.06);
                    break;
            }
        },
        [enabled],
    );

    return { enabled, setEnabled, unlocked, play };
}
