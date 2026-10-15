// Kiosk header: session identity (label + group) and reader/realtime status.
// Intentionally minimal — the kiosk is a presentation mode. The old « Pointage
// RFID » brand is replaced by the menu button that reveals the kiosk controls
// (sound, fullscreen) in a small dropdown; the menu closes on Escape or on any
// click outside.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { SessionRow } from "../../types/domain";
import type { ConnectionStatus } from "../../types/websocket";

interface KioskHeaderProps {
    session: SessionRow | null;
    groupName: string | null;
    readerOnline: boolean | null;
    connection: ConnectionStatus;
    // Controls shown in the dropdown (KioskControls).
    children?: ReactNode;
}

export function KioskHeader({ session, groupName, readerOnline, connection, children }: KioskHeaderProps) {
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!menuOpen) return;
        const onKeyDown = (e: KeyboardEvent): void => {
            if (e.key === "Escape") setMenuOpen(false);
        };
        const onPointerDown = (e: MouseEvent): void => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
        };
        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("mousedown", onPointerDown);
        return () => {
            document.removeEventListener("keydown", onKeyDown);
            document.removeEventListener("mousedown", onPointerDown);
        };
    }, [menuOpen]);

    const readerLabel = readerOnline === null ? "État inconnu" : readerOnline ? "Lecteur connecté" : "Lecteur déconnecté";
    const readerClass = readerOnline ? "indicator--ok" : "indicator--off";
    const connLabel =
        connection === "open" ? "Temps réel actif" : connection === "reconnecting" ? "Reconnexion…" : "Hors ligne";
    const connClass = connection === "open" ? "indicator--ok" : "indicator--warn";

    return (
        <header className="kiosk__header">
            <div className="kiosk__identity">
                <div className="kiosk__menu" ref={menuRef}>
                    <button
                        type="button"
                        className="kiosk__menu-button"
                        onClick={() => setMenuOpen((open) => !open)}
                        aria-haspopup="true"
                        aria-expanded={menuOpen}
                        aria-label="Ouvrir le menu de la borne"
                        title="Menu de la borne"
                    >
                        <span aria-hidden="true">≡</span> Menu
                    </button>
                    {menuOpen && (
                        <div className="kiosk__menu-panel" role="group" aria-label="Contrôles de la borne">
                            {children}
                        </div>
                    )}
                </div>
                <h1 className="kiosk__session">{session ? session.label : "Mode borne"}</h1>
                {session && <p className="kiosk__group">{groupName ?? "Tous les étudiants"}</p>}
            </div>

            <div className="kiosk__status-pills" aria-hidden="true">
                <span className={`indicator ${readerClass}`}>
                    <span className="indicator__dot" />
                    {readerLabel}
                </span>
                <span className={`indicator ${connClass}`}>
                    <span className="indicator__dot" />
                    {connLabel}
                </span>
            </div>
        </header>
    );
}
