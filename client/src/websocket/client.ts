// Shared WebSocket transport for the authenticated app.
//
// URL is derived from the page location only (wss?://same-host/ws) — never a
// hardcoded host or port. In dev the Vite proxy maps /ws to the WS server;
// in production the backend serves the hub at /ws on the HTTP port itself.
//
// One instance for the whole application (created by WsProvider): reconnects
// with capped backoff, keeps debug logs in English and quiet.

import type { ConnectionStatus, ServerEvent } from "../types/websocket";

const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 15_000;

export type EventListener = (event: ServerEvent) => void;
export type StatusListener = (status: ConnectionStatus) => void;

export class LiveSocket {
    private ws: WebSocket | null = null;
    private closed = false;
    private attempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private eventListeners = new Set<EventListener>();
    private statusListeners = new Set<StatusListener>();
    private status: ConnectionStatus = "connecting";

    connect(): void {
        this.closed = false;
        this.open();
    }

    private open(): void {
        const proto = window.location.protocol === "https:" ? "wss" : "ws";
        const url = `${proto}://${window.location.host}/ws`;
        let ws: WebSocket;
        try {
            ws = new WebSocket(url);
        } catch (err) {
            console.debug("[WS] Connection failed, will retry:", err);
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;

        ws.onopen = () => {
            this.attempt = 0;
            console.debug("[WS] Connected");
            this.setStatus("open");
        };

        ws.onmessage = (msg) => {
            let event: ServerEvent;
            try {
                event = JSON.parse(String(msg.data)) as ServerEvent;
            } catch {
                console.debug("[WS] Ignored malformed message");
                return;
            }
            for (const listener of this.eventListeners) {
                try {
                    listener(event);
                } catch (err) {
                    console.debug("[WS] Listener error:", err);
                }
            }
        };

        ws.onclose = () => {
            this.ws = null;
            if (this.closed) {
                this.setStatus("closed");
                return;
            }
            console.debug("[WS] Disconnected, reconnecting…");
            this.scheduleReconnect();
        };

        // The close event always follows an error: nothing else to log here
        // (avoids double console noise on failed connections).
        ws.onerror = () => {
            /* handled by onclose */
        };
    }

    private scheduleReconnect(): void {
        this.setStatus("reconnecting");
        if (this.reconnectTimer) return;
        const delay = Math.min(INITIAL_RECONNECT_MS * 2 ** this.attempt, MAX_RECONNECT_MS);
        this.attempt += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.closed) this.open();
        }, delay);
    }

    // Ask the server for a fresh status snapshot (used after reconnects).
    refreshStatus(): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ cmd: "get_status" }));
        }
    }

    subscribe(listener: EventListener): () => void {
        this.eventListeners.add(listener);
        return () => this.eventListeners.delete(listener);
    }

    onStatusChange(listener: StatusListener): () => void {
        this.statusListeners.add(listener);
        listener(this.status);
        return () => this.statusListeners.delete(listener);
    }

    private setStatus(status: ConnectionStatus): void {
        this.status = status;
        for (const listener of this.statusListeners) listener(status);
    }

    close(): void {
        this.closed = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.ws?.close();
        this.ws = null;
    }
}
