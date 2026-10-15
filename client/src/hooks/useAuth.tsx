// Authentication state for the React tree.
//
// The session lives ONLY in the HTTP-only cookie set by the backend; this
// context holds the resolved user (or nothing) and never any token. On boot we
// call /api/auth/me to restore the authenticated UI; a 401 from any protected
// endpoint drops us back to the login screen.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import * as authApi from "../api/auth";
import { ApiError, setUnauthorizedHandler } from "../api/client";
import type { AuthUser } from "../types/domain";

type AuthStatus = "loading" | "anonymous" | "authenticated";

interface AuthContextValue {
    status: AuthStatus;
    user: AuthUser | null;
    isAdmin: boolean;
    isKiosk: boolean;
    // Returns the authenticated user so callers can branch on the role (the
    // « kiosk » account must land directly on /kiosk).
    login: (username: string, password: string) => Promise<AuthUser>;
    logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
    const [status, setStatus] = useState<AuthStatus>("loading");
    const [user, setUser] = useState<AuthUser | null>(null);

    // Restore the session on boot (or after a full reload).
    useEffect(() => {
        let cancelled = false;
        authApi
            .fetchCurrentUser()
            .then((u) => {
                if (cancelled) return;
                if (u) {
                    setUser(u);
                    setStatus("authenticated");
                } else {
                    setStatus("anonymous");
                }
            })
            .catch((err) => {
                if (cancelled) return;
                if (err instanceof ApiError && err.status === 401) {
                    setStatus("anonymous");
                } else {
                    console.debug("[AUTH] Failed to restore session:", err);
                    setStatus("anonymous");
                }
            });
        return () => {
            cancelled = true;
        };
    }, []);

    // Any protected 401 mid-session invalidates the local state; RequireAuth
    // then redirects to /login.
    useEffect(() => {
        setUnauthorizedHandler(() => {
            setUser(null);
            setStatus("anonymous");
        });
        return () => setUnauthorizedHandler(null);
    }, []);

    const login = useCallback(async (username: string, password: string): Promise<AuthUser> => {
        const u = await authApi.login(username, password);
        setUser(u);
        setStatus("authenticated");
        return u;
    }, []);

    const logout = useCallback(async () => {
        try {
            await authApi.logout();
        } catch (err) {
            // The cookie is being dropped anyway; a failed call must not
            // trap the user inside the app.
            console.debug("[AUTH] Logout request failed:", err);
        }
        setUser(null);
        setStatus("anonymous");
    }, []);

    const value = useMemo<AuthContextValue>(
        () => ({
            status,
            user,
            isAdmin: user?.role === "admin",
            isKiosk: user?.role === "kiosk",
            login,
            logout,
        }),
        [status, user, login, logout],
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
    return ctx;
}
