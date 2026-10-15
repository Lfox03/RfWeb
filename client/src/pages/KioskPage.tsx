// Kiosk mode (Phase 6): a full-screen projection of the ACTIVE session for
// students to scan their RFID cards.
//
// Strictly a projection of backend state over the SHARED WebSocket connection
// (the route lives inside its own WsProvider): no session control, no RFID
// access, no second scan loop. Leaving this page never stops the session.
//
// The controls (sound, fullscreen) live in a small menu opened from the
// header (no exit button: the dashboard and the kiosk are distinct
// surfaces).

import { useEffect, useRef } from "react";

import { useKioskState } from "../hooks/useKioskState";
import { useKioskSound } from "../hooks/useKioskSound";
import { useFullscreen } from "../hooks/useFullscreen";
import { KioskHeader } from "../components/kiosk/KioskHeader";
import { KioskStatus } from "../components/kiosk/KioskStatus";
import { KioskAttendanceFeedback } from "../components/kiosk/KioskAttendanceFeedback";
import { KioskAttendanceSummary } from "../components/kiosk/KioskAttendanceSummary";
import { KioskRecentScans } from "../components/kiosk/KioskRecentScans";
import { KioskControls } from "../components/kiosk/KioskControls";

export function KioskPage() {
    const kiosk = useKioskState();
    const sound = useKioskSound();
    const fullscreen = useFullscreen();

    // Sound is purely additive over the authoritative visual feedback; held in
    // a ref so toggling sound never re-triggers playback for past scans.
    const playRef = useRef(sound.play);
    useEffect(() => {
        playRef.current = sound.play;
    }, [sound.play]);

    useEffect(() => {
        if (kiosk.feedback) playRef.current(kiosk.feedback.result);
        // A new feedback object per scan (monotonic key) → one sound per scan.
    }, [kiosk.feedback]);

    // Phase priority (spec): "no session" / "reader offline" / "stopped"
    // override the transient scan overlay.
    const showFeedback = kiosk.feedback !== null && kiosk.phase === "waiting";

    return (
        <div className="kiosk">
            <KioskHeader
                session={kiosk.session}
                groupName={kiosk.groupName}
                readerOnline={kiosk.readerOnline}
                connection={kiosk.connection}
            >
                <KioskControls fullscreen={fullscreen} sound={sound} />
            </KioskHeader>

            {kiosk.syncError && (
                <div className="kiosk__banner" role="alert">
                    <span>
                        Synchronisation incomplète : {kiosk.syncError} Les données affichées peuvent être
                        obsolètes.
                    </span>
                    <button type="button" className="btn" onClick={kiosk.retry}>
                        Réessayer
                    </button>
                </div>
            )}

            <main className="kiosk__main">
                <section className="kiosk__stage" aria-live="polite">
                    {showFeedback && kiosk.feedback ? (
                        <KioskAttendanceFeedback key={kiosk.feedback.key} feedback={kiosk.feedback} />
                    ) : (
                        <KioskStatus phase={kiosk.phase} endedSessionLabel={kiosk.endedSession?.label ?? null} />
                    )}
                </section>

                <aside className="kiosk__side">
                    <KioskAttendanceSummary roster={kiosk.roster} />
                    <KioskRecentScans scans={kiosk.recentScans} />
                </aside>
            </main>
        </div>
    );
}
