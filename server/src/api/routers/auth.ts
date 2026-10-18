// Authentication routes — login (HTTP-only cookie), logout, current session.

import { Router } from "express";

import { buildClearSessionCookie, buildSessionCookie } from "../middleware/auth";
import { loginRateLimit } from "../middleware/loginRateLimit";
import { asyncHandler, ok } from "../http";
import { requireBody, vString } from "../validate";
import { login, logout, resolveToken } from "../../services/authService";
import { AuthenticationError } from "../../core/errors";

export const authRouter = Router();

// loginRateLimit runs before validation: once the caller is locked out,
// every payload (valid, wrong, malformed) answers 429 RATE_LIMITED.
authRouter.post(
    "/login",
    loginRateLimit,
    asyncHandler(async (req, res) => {
        const body = requireBody(req.body);
        const username = vString(body, "username", { required: true, max: 64 });
        const password = vString(body, "password", { required: true, min: 1, max: 200, trim: false })!;

        const { user, token } = await login(username!, password);
        res.setHeader("Set-Cookie", buildSessionCookie(token));
        ok(res, { user });
    }),
);

authRouter.post(
    "/logout",
    asyncHandler(async (req, res) => {
        logout(req.authToken);
        res.setHeader("Set-Cookie", buildClearSessionCookie());
        res.status(204).end();
    }),
);

authRouter.get(
    "/me",
    asyncHandler(async (req, res) => {
        // Local console (attachLocalKiosk): an identity WITHOUT any token —
        // return the kiosk pseudo-user so the client can bootstrap /kiosk on
        // the server screen without logging in. A present-but-invalid cookie
        // never reaches here as anonymous (req.authToken stays set → 401).
        if (!req.authToken && req.user) {
            ok(res, { user: req.user });
            return;
        }
        const resolved = resolveToken(req.authToken);
        if (!resolved || !req.user) throw new AuthenticationError();
        ok(res, { user: resolved.user });
    }),
);
