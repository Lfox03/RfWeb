// Single shared WebSocket connection for the authenticated application.
//
// Mounted once inside the protected layout. It tracks the reader online state
// and the active session from the server status snapshot, exposes the live
// connection status, and lets pages subscribe to domain events. `epoch`
// increments on every (re)connection so pages know to refetch critical state
// after a temporary disconnect.

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import type { ReactNode } from "react";

import { LiveSocket } from "../websocket/client";
import type { ConnectionStatus, ServerEvent } from "../types/websocket";
import type { SessionWithGroups } from "../types/domain";

interface WsContextValue {
    connection: ConnectionStatus;
    readerOnline: boolean | null;
    activeSession: SessionWithGroups | null;
    // Increments on every (re)connection — pages refetch critical data.
    epoch: number;
    subscribe: (listener: (event: ServerEvent) => void) => () => void;
}

const WsContext = createContext<WsContextValue | null>(null);

export function WsProvider({ children }: { children: ReactNode }) {
    const socketRef = useRef<LiveSocket | null>(null);
    const [connection, setConnection] = useState<ConnectionStatus>("connecting");
    const [readerOnline, setReaderOnline] = useState<boolean | null>(null);
    const [activeSession, setActiveSession] = useState<SessionWithGroups | null>(null);
    const [epoch, setEpoch] = useState(0);

    // Stable subscriber list bridging to the (lazily created) socket so
    // `subscribe` keeps a stable identity across renders.
    const listenersRef = useRef(new Set<(event: ServerEvent) => void>());

    useEffect(() => {
        const socket = new LiveSocket();
        socketRef.current = socket;
        const offEvents = socket.subscribe((event) => {
            switch (event.event) {
                case "status":
                    setReaderOnline(event.content.readerOnline);
                    setActiveSession(event.content.session);
                    break;
                case "reader:status":
                    setReaderOnline(event.content.online);
                    break;
                case "session:started":
                    setActiveSession(event.content.session);
                    break;
                case "session:stopped":
                case "session:updated":
                    // Only clear when the lifecycle event targets the session we
                    // currently track: cancelling an unrelated scheduled session
                    // must not blank a running one (Phase 6 kiosk correctness).
                    setActiveSession((prev) => (prev && prev.id === event.content.session.id ? null : prev));
                    break;
                default:
                    break;
            }
            for (const listener of listenersRef.current) {
                try {
                    listener(event);
                } catch (err) {
                    console.debug("[WS] Subscriber error:", err);
                }
            }
        });
        const offStatus = socket.onStatusChange((status) => {
            setConnection(status);
            if (status === "open") {
                setEpoch((n) => n + 1);
                // Ask for a fresh snapshot in case events were missed while
                // disconnected.
                socket.refreshStatus();
            }
        });
        socket.connect();
        return () => {
            offEvents();
            offStatus();
            socket.close();
            socketRef.current = null;
        };
    }, []);

    const subscribe = useCallback((listener: (event: ServerEvent) => void) => {
        listenersRef.current.add(listener);
        return () => listenersRef.current.delete(listener);
    }, []);

    const value = useMemo<WsContextValue>(
        () => ({
            connection,
            readerOnline,
            activeSession,
            epoch,
            subscribe,
        }),
        [connection, readerOnline, activeSession, epoch, subscribe],
    );

    return <WsContext.Provider value={value}>{children}</WsContext.Provider>;
}

export function useWebSocket(): WsContextValue {
    const ctx = useContext(WsContext);
    if (!ctx) throw new Error("useWebSocket must be used inside WsProvider");
    return ctx;
}
