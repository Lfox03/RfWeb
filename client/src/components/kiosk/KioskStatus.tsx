// Central kiosk status panel: one big deterministic state, never two
// contradictory ones. Feedback (scan results) is rendered by the parent
// instead of this component while it is visible.
import type { KioskPhase } from "../../hooks/useKioskState";

interface KioskStatusProps {
    phase: KioskPhase;
    endedSessionLabel: string | null;
}

const CARD_GLYPH = (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
        <path d="M2.5 9.5h19" />
        <path d="M6 14.5h4" />
    </svg>
);

export function KioskStatus({ phase, endedSessionLabel }: KioskStatusProps) {
    switch (phase) {
        case "connecting":
            return (
                <div className="kiosk__state" role="status" aria-live="polite">
                    <p className="kiosk__state-title">Connexion en cours…</p>
                    <p className="kiosk__state-sub">Initialisation du mode borne.</p>
                </div>
            );

        case "no_session":
            return (
                <div className="kiosk__state" role="status" aria-live="polite">
                    <p className="kiosk__state-title">Aucune session en cours</p>
                </div>
            );

        case "session_stopped":
            return (
                <div className="kiosk__state" role="status" aria-live="polite">
                    <p className="kiosk__state-title">Session terminée</p>
                    <p className="kiosk__state-sub">
                        {endedSessionLabel ? `« ${endedSessionLabel} » est terminée.` : "Le pointage est terminé."}{" "}
                        Aucune présence ne peut plus être enregistrée.
                    </p>
                </div>
            );

        case "reader_offline":
            return (
                <div className="kiosk__state kiosk__state--alert" role="status" aria-live="polite">
                    <span className="kiosk__state-symbol" aria-hidden="true">
                        ⚠
                    </span>
                    <p className="kiosk__state-title">Lecteur RFID déconnecté</p>
                    <p className="kiosk__state-sub">
                        Rebranchez le lecteur : le pointage reprendra automatiquement, sans intervention.
                    </p>
                </div>
            );

        case "waiting":
        default:
            return (
                <div className="kiosk__state kiosk__state--ready" role="status" aria-live="polite">
                    <span className="kiosk__state-icon" aria-hidden="true">
                        {CARD_GLYPH}
                    </span>
                    <p className="kiosk__state-title">Présentez votre carte</p>
                </div>
            );
    }
}
