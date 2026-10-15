// WebSocket protocol types — mirrors server/src/websocket/hub.ts.
// Server → client messages are always { event, content }.

import type { ScanResult, SessionWithGroups } from "./domain";

export interface WsStatusSnapshot {
    readerOnline: boolean;
    session: SessionWithGroups | null;
}

export interface WsAttendanceScanned {
    sessionId: number;
    studentId: number | null;
    studentName: string | null;
    uid: string;
    result: ScanResult;
    scannedAt: string;
}

export type SeriesChangedAction =
    | "created"
    | "edited"
    | "paused"
    | "resumed"
    | "cancelled"
    | "generated";

export type ServerEvent =
    | { event: "status"; content: WsStatusSnapshot }
    | { event: "reader:status"; content: { online: boolean } }
    | { event: "session:started"; content: { session: SessionWithGroups } }
    | { event: "session:stopped"; content: { session: SessionWithGroups; reason: string } }
    | { event: "session:updated"; content: { session: SessionWithGroups } }
    | { event: "attendance:scanned"; content: WsAttendanceScanned }
    | { event: "attendance:reset"; content: { sessionId: number } }
    | {
          event: "series:changed";
          content: { action: SeriesChangedAction; series_id: number; occurrences?: number };
      }
    | { event: "error"; content: { message: string } };

export type ClientCommand = { cmd: "get_status" };

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";
