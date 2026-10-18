// HTTP authentication/authorization middleware.
//
// The session token only lives in the HTTP-only cookie (never in the body nor
// the URL). attachAuth enriches the request if the cookie is valid;
// authRequired / requireRole respectively require a session and a role.

import type { NextFunction, Request, Response } from "express";

import { readCookie } from "../../auth/cookie";
import { LOCAL_KIOSK_USER, resolveToken } from "../../services/authService";
import type { AuthUser } from "../../services/authService";
import { AuthorizationError, AuthenticationError } from "../../core/errors";
import { isLocalRequest } from "../../core/loopback";
import { COOKIE_NAME, COOKIE_SECURE, SESSION_TTL_HOURS } from "../../config/env";

// req.user / req.authToken are populated by attachAuth.
declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            user?: AuthUser;
            authToken?: string;
        }
    }
}

// Reads the session cookie and attaches req.user/req.authToken if valid.
// Never rejects: authRequired/requireRole are the ones deciding.
export function attachAuth(req: Request, _res: Response, next: NextFunction): void {
    const token = readCookie(req.headers.cookie, COOKIE_NAME);
    const resolved = resolveToken(token);
    if (resolved) {
        req.user = resolved.user;
        req.authToken = resolved.token;
    }
    next();
}

export function authRequired(req: Request, _res: Response, next: NextFunction): void {
    if (!req.user) {
        next(new AuthenticationError());
        return;
    }
    next();
}

// Local console (the kiosk opened on the server screen): a request with NO
// « sid » cookie at all, arriving from the loopback address, acts as the
// read-only kiosk account. Deliberate limits of this exception:
//   - GET/HEAD only — writes never borrow this identity (they stay
//     401 NOT_AUTHENTICATED, and the kiosk read-only middleware still applies
//     to any other route);
//   - loopback only — a remote caller is refused exactly as before
//     (X-Forwarded-For honored only under TRUST_PROXY, core/loopback.ts);
//   - a cookie that is PRESENT but invalid/expired is never silently demoted
//     to the kiosk identity: it keeps answering 401 (the « sid= » left by a
//     logout counts as present, hence the undefined check on readCookie).
export function attachLocalKiosk(req: Request, _res: Response, next: NextFunction): void {
    if (
        !req.user &&
        (req.method === "GET" || req.method === "HEAD") &&
        readCookie(req.headers.cookie, COOKIE_NAME) === undefined &&
        isLocalRequest(req.headers, req.socket.remoteAddress)
    ) {
        req.user = LOCAL_KIOSK_USER;
    }
    next();
}

export function requireRole(role: "admin" | "teacher") {
    return (req: Request, _res: Response, next: NextFunction): void => {
        if (!req.user) {
            next(new AuthenticationError());
            return;
        }
        // Simple hierarchy: admin also satisfies « teacher ».
        if (req.user.role !== role && !(role === "teacher" && req.user.role === "admin")) {
            next(new AuthorizationError(`Rôle « ${role} » requis.`));
            return;
        }
        next();
    };
}

// Session cookie serialization (HTTP-only, same-origin).
// SameSite=Lax: the application is same-origin (the React client served by
// the same server, Vite proxy in dev); "Secure" applies behind HTTPS.
export function buildSessionCookie(token: string): string {
    const parts = [
        `${COOKIE_NAME}=${token}`,
        "HttpOnly",
        "Path=/",
        "SameSite=Lax",
        `Max-Age=${Math.round(SESSION_TTL_HOURS * 3_600)}`,
    ];
    if (COOKIE_SECURE) parts.push("Secure");
    return parts.join("; ");
}

export function buildClearSessionCookie(): string {
    return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}
