// Kiosk presentation state machine (Phase 6).
//
// This hook is a PROJECTION of authoritative backend state — it never starts
// or stops a session, never touches the RFID device and never invents an
// attendance record. It combines:
//   - the shared WebSocket snapshot (active session + reader online state),
//   - targeted HTTP fetches for the roster counts / recent scan history,
//   - live WebSocket events (attendance:scanned / attendance:reset / reader:*).
//
// The result is a single deterministic `phase` the kiosk UI renders, plus the
// transient scan feedback. Everything resyncs from the server on reconnect
// (epoch change) and when the tab becomes visible again, so the kiosk can
// never drift from the backend.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { listAttendance, listScans } from "../api/sessions";
import { listGroups } from "../api/groups";
import { listStudents } from "../api/students";
import { toUiMessage } from "../api/client";
import { useWebSocket } from "./useWebSocket";
import type { ScanResult, SessionRow, SessionScanRow } from "../types/domain";
import type { ConnectionStatus, ServerEvent } from "../types/websocket";

// Deterministic presentation phases (spec §2). "No active session" and
// "reader offline" take priority over the transient scan overlay.
// "session_stopped" shows the just-ended session for STOPPED_DISPLAY_MS, then
// reverts automatically to "no_session" (the kiosk must not advertise a dead
// session indefinitely).
export type KioskPhase =
    | "connecting" // WebSocket not open yet / initial snapshot pending
    | "no_session" // connected, authenticated, nothing running
    | "session_stopped" // a session was running and ended while the kiosk is open
    | "reader_offline" // active session but the reader is disconnected
    | "waiting"; // active session + reader online → present a card

export interface KioskFeedback {
    key: number; // monotonic id (entry animation + dedup-free auto-dismiss)
    result: ScanResult;
    studentName: string | null;
    uid: string;
    scannedAt: string;
}

export interface KioskRoster {
    present: number;
    // Expected roster size when derivable from the session groups (union);
    // null when the session has no group (roster size then unknown).
    total: number | null;
}

export interface KioskState {
    phase: KioskPhase;
    session: SessionRow | null;
    // The session that just ended (only meaningful in the session_stopped phase).
    endedSession: SessionRow | null;
    groupName: string | null;
    roster: KioskRoster | null;
    recentScans: SessionScanRow[];
    feedback: KioskFeedback | null;
    readerOnline: boolean | null;
    connection: ConnectionStatus;
    // French UI message when the authoritative HTTP resync fails (never a raw
    // backend error code), or null when everything is fine.
    syncError: string | null;
    retry: () => void;
}

const RECENT_LIMIT = 8;
const FEEDBACK_TIMEOUT_MS = 4_500; // long enough for a student to read the result
const STOPPED_DISPLAY_MS = 120_000; // "session terminée" → "aucune session" after 2 min

// Dedup key for WebSocket events: the same attendance event delivered twice
// (e.g. replayed after a reconnect) must never double-count a presence.
function eventKey(c: { sessionId: number; uid: string; result: string; scannedAt: string }): string {
    return `${c.sessionId}|${c.uid}|${c.result}|${c.scannedAt}`;
}

export function useKioskState(): KioskState {
    const { activeSession, readerOnline, connection, epoch, subscribe } = useWebSocket();

    const [roster, setRoster] = useState<KioskRoster | null>(null);
    const [recentScans, setRecentScans] = useState<SessionScanRow[]>([]);
    const [feedback, setFeedback] = useState<KioskFeedback | null>(null);
    const [groupName, setGroupName] = useState<string | null>(null);
    const [endedSession, setEndedSession] = useState<SessionRow | null>(null);
    // Once STOPPED_DISPLAY_MS after a session ended, the "session terminée"
    // message reverts to the default "aucune session" screen (the kiosk must
    // not advertise a dead session indefinitely). Cleared by the next session.
    const [stoppedHidden, setStoppedHidden] = useState(false);
    const [syncError, setSyncError] = useState<string | null>(null);
    const [reloadToken, setReloadToken] = useState(0);

    const feedbackKey = useRef(0);
    const seenRef = useRef(new Set<string>());
    const everActiveRef = useRef(false);
    const lastActiveRef = useRef<SessionRow | null>(null);

    const retry = useCallback(() => setReloadToken((n) => n + 1), []);

    // Observe session transitions: once a session has been active in this
    // view, a later null means "stopped while open" (vs "never started").
    useEffect(() => {
        if (activeSession) {
            everActiveRef.current = true;
            lastActiveRef.current = activeSession;
            // A new session re-arms the "session terminée" display.
            setStoppedHidden(false);
        }
    }, [activeSession]);

    // Drop the transient overlay as soon as the session identity changes.
    useEffect(() => {
        setFeedback(null);
    }, [activeSession?.id]);

    // Authoritative roster + recent scan history for the active session.
    // Re-runs on session change, on every epoch bump (reconnect snapshot), on
    // tab re-visibility and on manual retry — always from the server, never
    // from client-side scan memory.
    useEffect(() => {
        if (!activeSession) {
            // Keep the ended session label for the "session terminée" message,
            // then clear all live data so nothing stale lingers on screen.
            if (everActiveRef.current) setEndedSession(lastActiveRef.current);
            setRoster(null);
            setRecentScans([]);
            setGroupName(null);
            setSyncError(null);
            return;
        }
        const sessionId = activeSession.id;
        const groupIds = activeSession.group_ids;
        setEndedSession(null);
        setRoster(null);

        let cancelled = false;
        void (async () => {
            try {
                const [att, scans, groups, students] = await Promise.all([
                    listAttendance(sessionId),
                    listScans(sessionId),
                    groupIds.length > 0 ? listGroups() : Promise.resolve(null),
                    groupIds.length > 0 ? Promise.resolve(null) : listStudents(),
                ]);
                if (cancelled) return;

                let total: number | null;
                if (groupIds.length > 0) {
                    // A student belongs to only one group: the sum of the
                    // checked groups' headcounts = roster size.
                    total = groupIds.reduce(
                        (sum, id) => sum + (groups?.rows.find((row) => row.id === id)?.student_count ?? 0),
                        0,
                    );
                } else {
                    total = students?.total ?? null;
                }

                setRoster({ present: att.rows.length, total });
                setRecentScans([...scans.rows].reverse().slice(0, RECENT_LIMIT));
                setGroupName(
                    groupIds.length > 0
                        ? groupIds
                              .map((id) => groups?.rows.find((row) => row.id === id)?.name ?? `Groupe ${id}`)
                              .join(", ")
                        : null,
                );
                setSyncError(null);
            } catch (err) {
                // Counters stay "unknown" (—) rather than showing a number that
                // might be wrong; the banner explains it in French (no raw code).
                if (!cancelled) {
                    console.debug("[KIOSK] Roster resync failed:", err);
                    setRoster(null);
                    setSyncError(toUiMessage(err));
                }
            }
        })();
        return () => {
            cancelled = true;
        };
        // Deliberately keyed on activeSession?.id (not the object): WS status
        // snapshots re-send an equal-but-new session object and must not
        // trigger a reload storm; `epoch` already covers reconnections.
    }, [activeSession?.id, epoch, reloadToken]);

    // Background tabs may have missed events; resync when becoming visible.
    useEffect(() => {
        const onVisible = (): void => {
            if (document.visibilityState === "visible") setReloadToken((n) => n + 1);
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => document.removeEventListener("visibilitychange", onVisible);
    }, []);

    // Live events. The scan loop lives exclusively on the server; the kiosk
    // only reacts (and ignores events for sessions other than the current one).
    useEffect(() => {
        const unsub = subscribe((event: ServerEvent) => {
            if (event.event === "attendance:scanned") {
                const c = event.content;
                // Stale event from another/past session → never displayed.
                if (!activeSession || c.sessionId !== activeSession.id) return;

                const key = eventKey(c);
                if (seenRef.current.has(key)) return;
                seenRef.current.add(key);
                if (seenRef.current.size > 200) seenRef.current.clear();

                // A manual presence mark (teacher correction) is NOT a student
                // scan: no overlay, no sound — only the counters/history update.
                feedbackKey.current += 1;
                if (c.result !== "manual") {
                    setFeedback({
                        key: feedbackKey.current,
                        result: c.result,
                        studentName: c.studentName,
                        uid: c.uid,
                        scannedAt: c.scannedAt,
                    });
                }

                setRecentScans((prev) => {
                    const row: SessionScanRow = {
                        scan_id: -feedbackKey.current,
                        student_id: c.studentId,
                        student_name: c.studentName,
                        uid: c.uid,
                        result: c.result,
                        scanned_at: c.scannedAt,
                    };
                    return [row, ...prev].slice(0, RECENT_LIMIT);
                });

                // The server is the source of truth; only a fresh accepted
                // presence (scan or manual mark) increments the counter
                // (deltas corrected on resync).
                if (c.result === "accepted" || c.result === "manual") {
                    setRoster((r) => (r ? { ...r, present: r.present + 1 } : r));
                }
            } else if (event.event === "attendance:reset") {
                if (activeSession && event.content.sessionId === activeSession.id) {
                    // Attendance STATE cleared elsewhere (admin reset) → clear
                    // feedback and refetch the authoritative count.
                    setFeedback(null);
                    setReloadToken((n) => n + 1);
                }
            }
        });
        return unsub;
    }, [subscribe, activeSession]);

    // Auto-dismiss the feedback overlay back to the waiting state.
    useEffect(() => {
        if (!feedback) return;
        const timer = setTimeout(() => setFeedback(null), FEEDBACK_TIMEOUT_MS);
        return () => clearTimeout(timer);
    }, [feedback]);

    // The "session terminée" screen is transient: 2 minutes after the session
    // ended (and while no new session is running), fall back to the default
    // "aucune session" presentation.
    useEffect(() => {
        if (activeSession || stoppedHidden || !everActiveRef.current) return;
        const timer = setTimeout(() => {
            setStoppedHidden(true);
            setEndedSession(null);
        }, STOPPED_DISPLAY_MS);
        return () => clearTimeout(timer);
    }, [activeSession, stoppedHidden]);

    const phase = useMemo<KioskPhase>(() => {
        // Until the FIRST status snapshot arrives, the real state is unknown.
        // Afterwards, the last known snapshot stays on screen during a WS
        // reconnect (the header shows "reconnexion") — the epoch mechanism
        // resyncs everything from the server once the socket is back.
        if (readerOnline === null) return "connecting";
        if (activeSession) return readerOnline === false ? "reader_offline" : "waiting";
        return everActiveRef.current && !stoppedHidden ? "session_stopped" : "no_session";
    }, [readerOnline, activeSession, stoppedHidden]);

    return {
        phase,
        session: activeSession,
        endedSession: activeSession ? null : endedSession,
        groupName,
        roster,
        recentScans,
        feedback,
        readerOnline,
        connection,
        syncError,
        retry,
    };
}
