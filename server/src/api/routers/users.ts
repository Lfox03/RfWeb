// « Users » routes — admin-only (account creation, roles).

import { Router } from "express";

import { requireRole } from "../middleware/auth";
import { asyncHandler, created, list, ok } from "../http";
import {
    parseIdParam,
    rejectUnknownFields,
    requireBody,
    vPassword,
    vRole,
    vString,
    vUsername,
} from "../validate";
import { createUser, listUsers, setPassword, updateRole } from "../../services/authService";
import type { UserAccount } from "../../services/authService";

export const usersRouter = Router();

usersRouter.use(requireRole("admin"));

usersRouter.get(
    "/",
    asyncHandler(async (_req, res) => {
        list(res, listUsers());
    }),
);

usersRouter.post(
    "/",
    asyncHandler(async (req, res) => {
        const body = requireBody(req.body);
        rejectUnknownFields(body, ["username", "password", "role"]);
        const username = vUsername(vString(body, "username", { required: true, max: 64 })!);
        const password = vPassword(vString(body, "password", { required: true, max: 200, trim: false })!);
        const role = vRole(body.role ?? "teacher");
        created(res, await createUser({ username, password, role }));
    }),
);

// PATCH {role?, password?} — role change and/or password reset.
usersRouter.patch(
    "/:id",
    asyncHandler(async (req, res) => {
        const id = parseIdParam(req.params.id, "utilisateur");
        const body = requireBody(req.body);
        rejectUnknownFields(body, ["role", "password"]);
        if (body.role === undefined && body.password === undefined) {
            return ok(res, null);
        }
        let user: UserAccount | undefined;
        // requireRole guarantees req.user here; the actor is passed so the
        // service can enforce the self-lockout rule server-side.
        if (body.role !== undefined) user = updateRole(req.user!, id, vRole(body.role));
        if (body.password !== undefined) {
            await setPassword(
                id,
                vPassword(vString(body, "password", { required: true, max: 200, trim: false })!),
                req.authToken,
            );
        }
        ok(res, user ?? null);
    }),
);
