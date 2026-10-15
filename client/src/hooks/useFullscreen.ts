// Fullscreen presentation helper (Phase 6 kiosk).
//
// Fullscreen is a presentation ENHANCEMENT only: the browser may refuse the
// request (permissions policy, no user gesture, unsupported) and the kiosk
// must keep working in a normal tab/window when that happens. No deprecated
// window manipulation is attempted — only the standard Fullscreen API.

import { useCallback, useEffect, useState } from "react";

export interface Fullscreen {
    supported: boolean;
    active: boolean;
    toggle: () => void;
}

export function useFullscreen(): Fullscreen {
    const [active, setActive] = useState<boolean>(() => document.fullscreenElement !== null);

    // Feature detection once — old engines without requestFullscreen simply
    // get a disabled button instead of an exception.
    const [supported] = useState<boolean>(
        () => typeof document.documentElement.requestFullscreen === "function",
    );

    // Keep in sync with any fullscreen change (button, F11, Esc key, …).
    useEffect(() => {
        const onChange = (): void => setActive(document.fullscreenElement !== null);
        document.addEventListener("fullscreenchange", onChange);
        document.addEventListener("fullscreenerror", onChange);
        return () => {
            document.removeEventListener("fullscreenchange", onChange);
            document.removeEventListener("fullscreenerror", onChange);
        };
    }, []);

    // Leaving the kiosk route must never leave the browser stuck fullscreen.
    useEffect(
        () => () => {
            if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        },
        [],
    );

    const toggle = useCallback((): void => {
        try {
            if (document.fullscreenElement) {
                void document.exitFullscreen().catch(() => {});
            } else {
                // A rejected request (refusal) is silently ignored: the kiosk
                // simply stays in its current window.
                void document.documentElement.requestFullscreen()?.catch(() => {});
            }
        } catch {
            /* presentation-only: never break navigation */
        }
    }, []);

    return { supported, active, toggle };
}
