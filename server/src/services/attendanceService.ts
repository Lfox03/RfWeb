// Attendance service — core of the scan workflow (Phase 2 model).
//
//   UID → normalization → active card → student → active session
//       → group scope (outside session → "out_of_group", not counted)
//       → card_scans journaling (always) → app_attendances state
//         (first presence only) → WebSocket broadcast.
//
// card_scans = raw history (1 scan = 1 row, duplicates and unknown
// cards included) ; app_attendances = current state (1 row per
// session+student, UNIQUE). No HTTP or hardware logic here.

import { ConflictError, NotFoundError, SessionStateError, ValidationError } from "../core/errors";
import { logger } from "../core/logger";
import { attendanceRepository, cardRepository, sessionRepository, studentRepository } from "../db";
import type { ScanResult } from "../db/types";
import { normalizeUid } from "../db/types";
import { broadcastEvent } from "../websocket/hub";

// Scan log fields: numeric identifiers + masked uid ONLY — student names
// never reach the logs (PII), the uid is masked by the logger itself.
const scanLog = logger.child({ component: "attendance" });

export interface ScanHandled {
    result: ScanResult;
    sessionId: number;
    studentId: number | null;
    studentName: string | null;
    uid: string;
    scannedAt: string;
    duplicate: boolean;
}

function fullName(student: { first_name: string; last_name: string | null } | null): string | null {
    if (!student) return null;
    return `${student.first_name}${student.last_name ? ` ${student.last_name}` : ""}`;
}

function broadcastScan(handled: ScanHandled): void {
    broadcastEvent("attendance:scanned", {
        sessionId: handled.sessionId,
        studentId: handled.studentId,
        studentName: handled.studentName,
        uid: handled.uid,
        result: handled.result,
        scannedAt: handled.scannedAt,
    });
}

// Handles a raw card scan (reader decID). Throws ValidationError if
// the UID is invalid, SessionStateError(409) if there is no active session
// (card_scans requires a session — FK NOT NULL).
export function handleScan(rawUid: string): ScanHandled {
    let uid: string;
    try {
        uid = normalizeUid(rawUid);
    } catch {
        throw new ValidationError("UID de carte invalide : entier décimal attendu.");
    }

    const session = sessionRepository.findActive();
    if (!session) {
        throw new SessionStateError("SESSION_NOT_RUNNING", "Aucune session active.");
    }

    const card = cardRepository.findByUid(uid);

    // Card never seen, or seen but never assigned → "unknown".
    if (!card || card.student_id === null) {
        const scan = attendanceRepository.logScan({ sessionId: session.id, uid, result: "unknown" });
        scanLog.warn("scan.unknown_card", { session_id: session.id, uid });
        const handled: ScanHandled = {
            result: "unknown",
            sessionId: session.id,
            studentId: null,
            studentName: null,
            uid,
            scannedAt: scan.scanned_at,
            duplicate: false,
        };
        broadcastScan(handled);
        return handled;
    }

    const student = studentRepository.findById(card.student_id) ?? null;
    const name = fullName(student);

    // Withdrawn card (replaced/lost) → "expired", journaled but no
    // presence recorded.
    if (card.revoked_at !== null) {
        const scan = attendanceRepository.logScan({
            sessionId: session.id,
            studentId: card.student_id,
            cardId: card.id,
            uid,
            result: "expired",
        });
        scanLog.warn("scan.card_revoked", { session_id: session.id, student_id: card.student_id, uid });
        const handled: ScanHandled = {
            result: "expired",
            sessionId: session.id,
            studentId: card.student_id,
            studentName: name,
            uid,
            scannedAt: scan.scanned_at,
            duplicate: false,
        };
        broadcastScan(handled);
        return handled;
    }

    // Session scope (Phase 10, roster-aware since Phase 3): a student outside
    // the session's EXPECTED membership is NOT counted present. The expected
    // membership mirrors the frozen roster — students of the session's groups
    // PLUS explicit inclusions (session_participants.included = 1), MINUS
    // explicit exclusions (= 0, which override group membership). Without any
    // delta this is exactly the historical group check, and a session without
    // groups (predating the rule) still accepts everyone. The scan is
    // journaled as "out_of_group" (no app_attendances state) and broadcast to
    // display a warning (kiosk / session / dashboard).
    if (!sessionRepository.isExpectedParticipant(session.id, card.student_id)) {
        const scan = attendanceRepository.logScan({
            sessionId: session.id,
            studentId: card.student_id,
            cardId: card.id,
            uid,
            result: "out_of_group",
        });
        scanLog.warn("scan.out_of_group", { session_id: session.id, student_id: card.student_id, uid });
        const handled: ScanHandled = {
            result: "out_of_group",
            sessionId: session.id,
            studentId: card.student_id,
            studentName: name,
            uid,
            scannedAt: scan.scanned_at,
            duplicate: false,
        };
        broadcastScan(handled);
        return handled;
    }

    // Nominal path: event + state (first scan accepted, subsequent ones duplicates).
    const outcome = attendanceRepository.recordScan({
        sessionId: session.id,
        studentId: card.student_id,
        uid,
        cardId: card.id,
    });
    const result: ScanResult = outcome.duplicate ? "duplicate" : "accepted";
    scanLog.info(`scan.${result}`, { session_id: session.id, student_id: card.student_id, uid });
    const handled: ScanHandled = {
        result,
        sessionId: session.id,
        studentId: card.student_id,
        studentName: name,
        uid,
        scannedAt: outcome.scan.scanned_at,
        duplicate: outcome.duplicate,
    };
    broadcastScan(handled);
    return handled;
}

// Presence entered manually by a teacher during a running session
// (student without a card, broken kiosk…): sets the app_attendances state,
// journals the "manual" event (no card, empty uid) and broadcasts
// attendance:scanned like a scan — all clients (session, dashboard,
// kiosk) resynchronize. The group scope is NOT enforced:
// manual entry is the teacher's explicit correction. Refused
// (409) if the session is not running or the student is already present.
export function markPresentManually(sessionId: number, studentId: number): ScanHandled {
    const session = sessionRepository.findById(sessionId);
    if (!session) {
        throw new SessionStateError("SESSION_NOT_FOUND", "Session introuvable.");
    }
    if (session.status !== "running") {
        throw new SessionStateError(
            "SESSION_NOT_RUNNING",
            "La session doit être en cours pour marquer une présence manuellement.",
        );
    }
    const student = studentRepository.findById(studentId);
    if (!student) throw new NotFoundError("Étudiant");

    const outcome = attendanceRepository.markPresentManually(sessionId, studentId);
    if (!outcome.created) {
        throw new ConflictError("ALREADY_PRESENT", "Cet étudiant est déjà marqué présent pour cette session.");
    }

    const name = fullName(student);
    scanLog.info("scan.manual_presence", { session_id: sessionId, student_id: studentId });
    const handled: ScanHandled = {
        result: "manual",
        sessionId,
        studentId,
        studentName: name,
        uid: "",
        scannedAt: outcome.attendance.scanned_at,
        duplicate: false,
    };
    broadcastScan(handled);
    return handled;
}

// Attendance state of a session (modern equivalent of the legacy report).
export function listAttendance(sessionId: number) {
    assertSession(sessionId);
    return attendanceRepository.getSessionAttendance(sessionId);
}

// Full scan history of a session (duplicates/unknowns included).
export function listScans(sessionId: number) {
    assertSession(sessionId);
    return attendanceRepository.listScans(sessionId);
}

// Resets the attendance STATE (scans remain in card_scans).
export function resetAttendance(sessionId: number): void {
    assertSession(sessionId);
    attendanceRepository.resetSession(sessionId);
    // Phase 6 (kiosk): broadcast so every live client (kiosk or dashboard)
    // resyncs its attendance counters from the server instead of drifting.
    broadcastEvent("attendance:reset", { sessionId });
    scanLog.info("attendance.reset", { session_id: sessionId });
}

function assertSession(sessionId: number): void {
    if (!sessionRepository.findById(sessionId)) {
        throw new SessionStateError("SESSION_NOT_FOUND", "Session introuvable.");
    }
}
