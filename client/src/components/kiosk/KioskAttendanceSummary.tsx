// Big attendance counter: "Présents : X / Y". Both numbers are server-derived
// (X from the attendance state, Y from the group roster); null renders "—".
import type { KioskRoster } from "../../hooks/useKioskState";

interface KioskAttendanceSummaryProps {
    roster: KioskRoster | null;
}

export function KioskAttendanceSummary({ roster }: KioskAttendanceSummaryProps) {
    return (
        <section className="kiosk__panel kiosk__summary" aria-label="Résumé des présences">
            <p className="kiosk__panel-title">Présents</p>
            <p className="kiosk__summary-count">
                {roster ? roster.present : "—"}
                {roster && roster.total !== null && (
                    <span className="kiosk__summary-total"> / {roster.total}</span>
                )}
            </p>
            {!roster && <p className="kiosk__summary-hint">Chargement…</p>}
        </section>
    );
}
