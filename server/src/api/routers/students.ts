// « Students » routes.

import express, { Router } from "express";

import { asyncHandler, created, list, noContent, ok } from "../http";
import {
    parseIdParam,
    parseUidParam,
    rejectUnknownFields,
    requireBody,
    vEmail,
    vInt,
    vString,
    vUid,
} from "../validate";
import { ValidationError } from "../../core/errors";
import * as studentService from "../../services/studentService";
import * as cardService from "../../services/cardService";

export const studentsRouter = Router();

studentsRouter.get(
    "/",
    asyncHandler(async (_req, res) => {
        list(res, studentService.list());
    }),
);

// Lookup by RFID card UID (routed before the numeric /:id).
studentsRouter.get(
    "/by-card/:uid",
    asyncHandler(async (req, res) => {
        ok(res, studentService.getByCardUid(parseUidParam(req.params.uid)));
    }),
);

studentsRouter.get(
    "/:id",
    asyncHandler(async (req, res) => {
        ok(res, studentService.get(parseIdParam(req.params.id, "étudiant")));
    }),
);

// Card history of a student (active + revoked).
studentsRouter.get(
    "/:id/cards",
    asyncHandler(async (req, res) => {
        list(res, cardService.listByStudent(parseIdParam(req.params.id, "étudiant")));
    }),
);

studentsRouter.post(
    "/",
    asyncHandler(async (req, res) => {
        const body = requireBody(req.body);
        rejectUnknownFields(body, ["firstName", "lastName", "studentNumber", "groupId", "email"]);
        created(
            res,
            studentService.create({
                firstName: vString(body, "firstName", { required: true, min: 1, max: 100 })!,
                lastName: vString(body, "lastName", { max: 100 }) ?? null,
                studentNumber: vString(body, "studentNumber", { max: 50 }) ?? null,
                groupId: vInt(body, "groupId", { min: 1 }) ?? null,
                email: vEmail(body, "email") ?? null,
            }),
        );
    }),
);

// Import a student list from a raw CSV file (content-type
// text/csv) — structure: prénom, nom, groupe, email, id (first and last name
// alone are required, id = RFID card UID to assign). The file is limited to
// 2 MB; parsing server-side.
studentsRouter.post(
    "/import",
    express.text({ type: ["text/csv", "text/plain"], limit: "2mb" }),
    asyncHandler(async (req, res) => {
        if (typeof req.body !== "string" || req.body.trim() === "") {
            throw new ValidationError("Fichier CSV attendu : envoyez le contenu du fichier en text/csv.");
        }
        ok(res, studentService.importCsv(req.body));
    }),
);

// Partial PATCH: an explicit null clears the field (except firstName, NOT NULL).
studentsRouter.patch(
    "/:id",
    asyncHandler(async (req, res) => {
        const id = parseIdParam(req.params.id, "étudiant");
        const body = requireBody(req.body);
        rejectUnknownFields(body, ["firstName", "lastName", "studentNumber", "groupId", "email"]);
        if (Object.keys(body).length === 0) {
            throw new ValidationError("Au moins un champ à modifier est requis.");
        }
        const patch: Parameters<typeof studentService.update>[1] = {};
        if (body.firstName !== undefined) {
            patch.firstName = vString(body, "firstName", { required: true, min: 1, max: 100 })!;
        }
        if ("lastName" in body) {
            patch.lastName = body.lastName === null ? null : vString(body, "lastName", { required: true, max: 100 })!;
        }
        if ("studentNumber" in body) {
            patch.studentNumber =
                body.studentNumber === null ? null : vString(body, "studentNumber", { required: true, max: 50 })!;
        }
        if ("groupId" in body) {
            patch.groupId = body.groupId === null ? null : vInt(body, "groupId", { required: true, min: 1 })!;
        }
        if ("email" in body) {
            patch.email = body.email === null ? null : vEmail(body, "email", { required: true })!;
        }
        ok(res, studentService.update(id, patch));
    }),
);

// Assign a card to a student (creates the card if unknown, replaces
// the previous active card when applicable).
studentsRouter.post(
    "/:id/card",
    asyncHandler(async (req, res) => {
        const studentId = parseIdParam(req.params.id, "étudiant");
        const body = requireBody(req.body);
        rejectUnknownFields(body, ["uid"]);
        ok(res, cardService.assignToStudent(vUid(body, "uid", { required: true })!, studentId));
    }),
);

studentsRouter.delete(
    "/:id",
    asyncHandler(async (req, res) => {
        studentService.remove(parseIdParam(req.params.id, "étudiant"));
        noContent(res);
    }),
);
