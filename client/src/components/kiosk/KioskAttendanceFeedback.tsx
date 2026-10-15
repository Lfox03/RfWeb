// Transient scan-result overlay (the heart of the kiosk UX).
// Rendered INSTEAD of KioskStatus while visible; the parent remounts it with
// a fresh key per scan so the entry animation always replays.
import { formatTime } from "../../lib/format";
import type { KioskFeedback } from "../../hooks/useKioskState";
import type { ScanResult } from "../../types/domain";

interface KioskAttendanceFeedbackProps {
    feedback: KioskFeedback;
}

// French user-facing copy per backend scan result (never raw error codes).
const COPY: Record<ScanResult, { symbol: string; title: string }> = {
    accepted: {
        symbol: "✓",
        title: "Présence enregistrée",
    },
    duplicate: {
        symbol: "!",
        title: "Déjà présent",
    },
    unknown: {
        symbol: "?",
        title: "Carte inconnue",
    },
    expired: {
        symbol: "✕",
        title: "Carte désactivée",
    },
    out_of_group: {
        symbol: "⚠",
        title: "Hors de cette session",
    },
    // Never displayed by the kiosk (manual marking triggers no student-facing
    // overlay) — present to cover the entire type.
    manual: {
        symbol: "✓",
        title: "Présence enregistrée",
    },
};

export function KioskAttendanceFeedback({ feedback }: KioskAttendanceFeedbackProps) {
    const copy = COPY[feedback.result];
    return (
        <div
            className={`kiosk__feedback kiosk__feedback--${feedback.result}`}
            role="status"
            aria-live="assertive"
        >
            <span className="kiosk__feedback-symbol" aria-hidden="true">
                {copy.symbol}
            </span>
            <p className="kiosk__feedback-title">{copy.title}</p>
            {feedback.studentName && (
                <p className="kiosk__feedback-name">
                    {feedback.result === "expired"
                        ? `${feedback.studentName} — carte retirée`
                        : feedback.result === "out_of_group"
                          ? `${feedback.studentName} — groupe hors session`
                          : feedback.studentName}
                </p>
            )}
            <p className="kiosk__feedback-time">{formatTime(feedback.scannedAt)}</p>
        </div>
    );
}
