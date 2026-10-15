import { NavLink, Outlet, useNavigate } from "react-router-dom";

import { useAuth } from "../../hooks/useAuth";
import { useWebSocket } from "../../hooks/useWebSocket";
import { ROLE_LABEL } from "../../lib/format";

// Authenticated application shell: header (identity, reader + realtime
// indicators, logout), sidebar navigation, content outlet.
export function AppLayout() {
    const { user, isAdmin, logout } = useAuth();
    const { connection, readerOnline } = useWebSocket();
    const navigate = useNavigate();

    const handleLogout = async (): Promise<void> => {
        await logout();
        navigate("/login", { replace: true });
    };

    return (
        <div className="shell">
            <header className="topbar">
                <div className="topbar__brand">RFID Attendance</div>

                <div className="topbar__indicators">
                    <span
                        className={`indicator ${readerOnline ? "indicator--ok" : "indicator--off"}`}
                        title="État du lecteur RFID"
                    >
                        <span className="indicator__dot" aria-hidden="true" />
                        Lecteur : {readerOnline === null ? "…" : readerOnline ? "connecté" : "déconnecté"}
                    </span>
                    <span
                        className={`indicator ${connection === "open" ? "indicator--ok" : "indicator--warn"}`}
                        title="État de la connexion temps réel"
                    >
                        <span className="indicator__dot" aria-hidden="true" />
                        {connection === "open"
                            ? "Temps réel actif"
                            : connection === "reconnecting"
                              ? "Reconnexion temps réel…"
                              : "Temps réel hors ligne"}
                    </span>
                </div>

                <div className="topbar__user">
                    {user && (
                        <span className="topbar__identity">
                            <strong>{user.username}</strong>
                            <span className="topbar__role"> · {ROLE_LABEL[user.role]}</span>
                        </span>
                    )}
                    <button className="btn btn--ghost" onClick={handleLogout}>
                        Déconnexion
                    </button>
                </div>
            </header>

                <nav className="sidebar" aria-label="Navigation principale">
                    <NavLink to="/" end className="sidebar__link">
                        Tableau de bord
                    </NavLink>
                    <NavLink to="/students" className="sidebar__link">
                        Étudiants
                    </NavLink>
                    <NavLink to="/groups" className="sidebar__link">
                        Groupes
                    </NavLink>
                    <NavLink to="/sessions" className="sidebar__link">
                        Sessions
                    </NavLink>
                    <NavLink to="/kiosk" className="sidebar__link">
                        Mode borne
                    </NavLink>
                    {isAdmin && (
                        <>
                            <NavLink to="/users" className="sidebar__link">
                                Utilisateurs
                            </NavLink>
                            <NavLink to="/database" className="sidebar__link">
                                Base de données
                            </NavLink>
                            <NavLink to="/logs" className="sidebar__link">
                                Journaux
                            </NavLink>
                        </>
                    )}
                </nav>

                <main className="content">
                    <Outlet />
                </main>
        </div>
    );
}
