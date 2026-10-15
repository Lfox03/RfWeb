// « RFID cards » routes. Card assignment (POST /api/students/:id/card) lives
// on studentsRouter (see routers/students.ts).

import { Router } from "express";

import { asyncHandler, created, ok } from "../http";
import { parseUidParam, rejectUnknownFields, requireBody, vUid } from "../validate";
import * as cardService from "../../services/cardService";

export const cardsRouter = Router();

cardsRouter.get(
    "/:uid",
    asyncHandler(async (req, res) => {
        ok(res, cardService.getByUid(parseUidParam(req.params.uid)));
    }),
);

// Registers a card in stock (unassigned).
cardsRouter.post(
    "/",
    asyncHandler(async (req, res) => {
        const body = requireBody(req.body);
        rejectUnknownFields(body, ["uid"]);
        created(res, cardService.register(vUid(body, "uid", { required: true })!));
    }),
);

cardsRouter.post(
    "/:uid/revoke",
    asyncHandler(async (req, res) => {
        ok(res, cardService.revokeByUid(parseUidParam(req.params.uid)));
    }),
);
