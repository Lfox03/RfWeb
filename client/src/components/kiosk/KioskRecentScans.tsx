// Compact recent-scan history for the kiosk sidebar.
import { formatTime, SCAN_RESULT_LABEL } from "../../lib/format";
import type { ScanResult, SessionScanRow } from "../../types/domain";

interface KioskRecentScansProps {
    scans: SessionScanRow[];
}

// Text symbol in addition to color: results must never be conveyed by color
// only (accessibility).
const RESULT_SYMBOL: Record<ScanResult, string> = {
    accepted: "✓",
    duplicate: "!",
    unknown: "?",
    expired: "✕",
    out_of_group: "⚠",
    manual: "✎",
};

export function KioskRecentScans({ scans }: KioskRecentScansProps) {
    return (
        <section className="kiosk__panel kiosk__recent" aria-label="Scans récents">
            <h2 className="kiosk__panel-title">Scans récents</h2>
            {scans.length === 0 ? (
                <p className="kiosk__recent-empty">Aucun scan pour le moment.</p>
            ) : (
                <ul className="kiosk__recent-list">
                    {scans.map((row, i) => (
                        <li
                            key={`${row.scanned_at}-${row.uid ?? "?"}-${row.result}-${i}`}
                            className={`kiosk__recent-item kiosk__recent-item--${row.result}`}
                        >
                            <span className="kiosk__recent-symbol" aria-hidden="true">
                                {RESULT_SYMBOL[row.result]}
                            </span>
                            <span className="kiosk__recent-who">{row.student_name ?? `Carte ${row.uid ?? "?"}`}</span>
                            <span className="kiosk__recent-result">{SCAN_RESULT_LABEL[row.result]}</span>
                            <span className="kiosk__recent-time">{formatTime(row.scanned_at)}</span>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
