// HTTP helpers: consistent JSON response format + centralized propagation of
// async errors (handlers no longer need repetitive try/catch).

import type { NextFunction, Request, RequestHandler, Response } from "express";

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>;

export function asyncHandler(handler: AsyncHandler): RequestHandler {
    return (req, res, next) => {
        void Promise.resolve(handler(req, res, next)).catch(next);
    };
}

export function ok(res: Response, data: unknown): void {
    res.status(200).json({ data });
}

export function created(res: Response, data: unknown): void {
    res.status(201).json({ data });
}

export function noContent(res: Response): void {
    res.status(204).end();
}

export function list<T>(res: Response, rows: T[], meta: Record<string, unknown> = {}): void {
    res.status(200).json({ data: rows, meta: { total: rows.length, ...meta } });
}
