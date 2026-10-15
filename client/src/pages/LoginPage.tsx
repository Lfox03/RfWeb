import { useState } from "react";
import type { FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";

import { ApiError, toUiMessage } from "../api/client";
import { useAuth } from "../hooks/useAuth";
import type { UserRole } from "../types/domain";

// Landing page per role: the kiosk account has no dashboard, only /kiosk.
export function homeFor(role: UserRole | undefined): string {
    return role === "kiosk" ? "/kiosk" : "/";
}

export function LoginPage() {
    const { status, user, login } = useAuth();
    const navigate = useNavigate();
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    // Already authenticated (e.g. after a reload): skip the form.
    if (status === "authenticated") {
        return <Navigate to={homeFor(user?.role)} replace />;
    }

    const handleSubmit = async (e: FormEvent): Promise<void> => {
        e.preventDefault();
        if (!username.trim() || !password) {
            setError("Renseignez votre nom d'utilisateur et votre mot de passe.");
            return;
        }
        setError(null);
        setBusy(true);
        try {
            const u = await login(username.trim(), password);
            navigate(homeFor(u.role), { replace: true });
        } catch (err) {
            setError(err instanceof ApiError && err.code === "INVALID_CREDENTIALS" ? "Identifiants invalides." : toUiMessage(err));
            setBusy(false);
        }
    };

    return (
        <div className="login">
            <form className="login__card" onSubmit={(e) => void handleSubmit(e)}>
                <h1 className="login__title">RFID Attendance</h1>
                <p className="login__subtitle">Pointage des présences</p>

                <div className="field">
                    <label htmlFor="login-username">Nom d'utilisateur</label>
                    <input
                        id="login-username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        autoComplete="username"
                        autoFocus
                    />
                </div>
                <div className="field">
                    <label htmlFor="login-password">Mot de passe</label>
                    <input
                        id="login-password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="current-password"
                    />
                </div>

                {error && (
                    <p className="form-error" role="alert">
                        {error}
                    </p>
                )}
                <br />
                <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
                    {busy ? "Connexion…" : "Se connecter"}
                </button>
            </form>
        </div>
    );
}
