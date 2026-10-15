// Application root: providers, routing, auth guard.
//
// /login is public; everything else is wrapped by RequireAuth (redirects to
// /login when anonymous) + WsProvider (single shared WebSocket). The admin
// shell adds AppLayout; /kiosk stays chromeless (full-screen presentation).
// Kiosk accounts (role « kiosk ») are bounced from the admin shell to /kiosk
// and land there directly after login.

import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";

import { AuthProvider, useAuth } from "./hooks/useAuth";
import { WsProvider } from "./hooks/useWebSocket";
import { ToastProvider } from "./hooks/useToast";
import { AppLayout } from "./components/layout/AppLayout";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { StudentsPage } from "./pages/StudentsPage";
import { StudentPage } from "./pages/StudentPage";
import { GroupsPage } from "./pages/GroupsPage";
import { SessionsPage } from "./pages/SessionsPage";
import { SessionPage } from "./pages/SessionPage";
import { UsersPage } from "./pages/UsersPage";
import { DatabasePage } from "./pages/DatabasePage";
import { LogsPage } from "./pages/LogsPage";
import { KioskPage } from "./pages/KioskPage";

function RequireAuth({ children }: { children: ReactNode }) {
    const { status } = useAuth();
    if (status === "loading") {
        return (
            <div className="splash" role="status">
                Chargement…
            </div>
        );
    }
    if (status === "anonymous") {
        return <Navigate to="/login" replace />;
    }
    return <>{children}</>;
}

// Admin-only gate. Renders only inside RequireAuth (so status is already
// "authenticated"): a teacher hitting the route is bounced to the dashboard
// without ever rendering the administration UI. The API stays the real
// enforcement point (requireRole("admin") on /api/users).
function RequireAdmin({ children }: { children: ReactNode }) {
    const { isAdmin } = useAuth();
    if (!isAdmin) {
        return <Navigate to="/" replace />;
    }
    return <>{children}</>;
}

// Kiosk accounts have exactly one screen: /kiosk. Inside the admin shell they
// are redirected to the kiosk before anything renders (the API additionally
// refuses them every non-GET request).
function RequireNotKiosk({ children }: { children: ReactNode }) {
    const { isKiosk } = useAuth();
    if (isKiosk) {
        return <Navigate to="/kiosk" replace />;
    }
    return <>{children}</>;
}

function ProtectedLayout() {
    return (
        <RequireAuth>
            <RequireNotKiosk>
                <WsProvider>
                    <AppLayout />
                </WsProvider>
            </RequireNotKiosk>
        </RequireAuth>
    );
}

// Kiosk mode: authenticated and WebSocket-connected, but deliberately OUTSIDE
// AppLayout — a full-screen presentation with no admin sidebar/topbar chrome.
function KioskRoute() {
    return (
        <RequireAuth>
            <WsProvider>
                <KioskPage />
            </WsProvider>
        </RequireAuth>
    );
}

export default function App() {
    return (
        <ToastProvider>
            <AuthProvider>
                <BrowserRouter>
                    <Routes>
                        <Route path="/login" element={<LoginPage />} />
                        <Route element={<ProtectedLayout />}>
                            <Route path="/" element={<DashboardPage />} />
                            <Route path="/students" element={<StudentsPage />} />
                            <Route path="/students/:id" element={<StudentPage />} />
                            <Route path="/groups" element={<GroupsPage />} />
                            <Route path="/sessions" element={<SessionsPage />} />
                            <Route path="/sessions/:id" element={<SessionPage />} />
                            {/* Reporting was merged into /sessions (filters +
                                per-session report + CSV export). */}
                            <Route path="/reports" element={<Navigate to="/sessions" replace />} />
                            <Route
                                path="/users"
                                element={
                                    <RequireAdmin>
                                        <UsersPage />
                                    </RequireAdmin>
                                }
                            />
                            <Route
                                path="/database"
                                element={
                                    <RequireAdmin>
                                        <DatabasePage />
                                    </RequireAdmin>
                                }
                            />
                            <Route
                                path="/logs"
                                element={
                                    <RequireAdmin>
                                        <LogsPage />
                                    </RequireAdmin>
                                }
                            />
                        </Route>
                        <Route path="/kiosk" element={<KioskRoute />} />
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                </BrowserRouter>
            </AuthProvider>
        </ToastProvider>
    );
}
