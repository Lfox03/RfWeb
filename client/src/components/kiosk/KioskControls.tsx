// Kiosk control buttons shown in the header menu: fullscreen (enhancement
// only), audio feedback, and a way back to the dashboard. The dashboard entry
// is hidden for real kiosk accounts — they have exactly one screen, and the
// route guard would bounce them right back here. It stays visible for the
// loopback pseudo-kiosk session (the local console, id 0): the guard sends it
// to /login so an admin can sign in and reach the dashboard.
import { useNavigate } from "react-router-dom";

import { useAuth } from "../../hooks/useAuth";
import type { KioskSound } from "../../hooks/useKioskSound";
import type { Fullscreen } from "../../hooks/useFullscreen";

interface KioskControlsProps {
    fullscreen: Fullscreen;
    sound: KioskSound;
}

export function KioskControls({ fullscreen, sound }: KioskControlsProps) {
    const navigate = useNavigate();
    const { isKiosk, isLocalKiosk } = useAuth();
    const canLeave = !isKiosk || isLocalKiosk;

    return (
        <div className="kiosk__controls">
            {/* Honest hint while the browser autoplay policy still locks audio. */}
            {sound.enabled && !sound.unlocked && (
                <span className="kiosk__controls-hint">Touchez l'écran pour activer le son</span>
            )}

            <button
                type="button"
                className="btn kiosk__btn"
                onClick={() => sound.setEnabled(!sound.enabled)}
                aria-pressed={sound.enabled}
            >
                {sound.enabled ? "Son activé" : "Son coupé"}
            </button>

            <button
                type="button"
                className="btn kiosk__btn"
                onClick={fullscreen.toggle}
                disabled={!fullscreen.supported}
                aria-pressed={fullscreen.active}
                title={fullscreen.supported ? undefined : "Plein écran non disponible dans ce navigateur"}
            >
                {fullscreen.active ? "Quitter le plein écran" : "Plein écran"}
            </button>

            {canLeave && (
                <>
                    <span className="kiosk__controls-separator" aria-hidden="true" />
                    <button type="button" className="btn kiosk__btn" onClick={() => navigate("/")}>
                        Tableau de bord
                    </button>
                </>
            )}
        </div>
    );
}
