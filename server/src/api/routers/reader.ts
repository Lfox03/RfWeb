// « RFID reader » routes — status (online/offline + active session) and beep.
// The status is also pushed over WebSocket (reader:status): no need to poll.

import { Router } from "express";

import { asyncHandler, ok } from "../http";
import * as readerService from "../../services/readerService";

export const readerRouter = Router();

readerRouter.get(
    "/status",
    asyncHandler(async (_req, res) => {
        ok(res, readerService.getStatus());
    }),
);

readerRouter.post(
    "/beep",
    asyncHandler(async (_req, res) => {
        await readerService.beep();
        ok(res, { beep: "ok" });
    }),
);

// One-shot card read for the card-assignment workflow ("present a card").
// Long-polls until a card is presented, then returns its UID. 409 when the
// scan loop is running, 503 when the reader is offline, 504 on timeout.
readerRouter.post(
    "/next-card",
    asyncHandler(async (_req, res) => {
        const reading = await readerService.nextCard();
        ok(res, { uid: reading.decID, hexId: reading.hexID });
    }),
);
