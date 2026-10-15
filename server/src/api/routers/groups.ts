// « Groups » routes.

import { Router } from "express";

import { asyncHandler, created, list, noContent, ok } from "../http";
import { parseIdParam, rejectUnknownFields, requireBody, vString } from "../validate";
import * as groupService from "../../services/groupService";

export const groupsRouter = Router();

groupsRouter.get(
    "/",
    asyncHandler(async (_req, res) => {
        list(res, groupService.list());
    }),
);

groupsRouter.post(
    "/",
    asyncHandler(async (req, res) => {
        const body = requireBody(req.body);
        rejectUnknownFields(body, ["name"]);
        const name = vString(body, "name", { required: true, min: 1, max: 100 })!;
        created(res, groupService.create(name));
    }),
);

groupsRouter.patch(
    "/:id",
    asyncHandler(async (req, res) => {
        const id = parseIdParam(req.params.id, "groupe");
        const body = requireBody(req.body);
        rejectUnknownFields(body, ["name"]);
        const name = vString(body, "name", { required: true, min: 1, max: 100 })!;
        ok(res, groupService.rename(id, name));
    }),
);

groupsRouter.delete(
    "/:id",
    asyncHandler(async (req, res) => {
        groupService.remove(parseIdParam(req.params.id, "groupe"));
        noContent(res);
    }),
);
