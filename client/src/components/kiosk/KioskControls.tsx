// Kiosk control buttons shown in the header menu: fullscreen (enhancement
// only) and audio feedback. No exit control by design — the kiosk page and
// the admin dashboard are separate surfaces; leaving the kiosk is a
// navigation concern, not a kiosk one.
import type { KioskSound } from "../../hooks/useKioskSound";
import type { Fullscreen } from "../../hooks/useFullscreen";

interface KioskControlsProps {
    fullscreen: Fullscreen;
    sound: KioskSound;
}

export function KioskControls({ fullscreen, sound }: KioskControlsProps) {
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
        </div>
    );
}
