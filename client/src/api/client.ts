// Typed fetch wrapper around the Phase 3 API.
//
// Rules (AGENTS.md): relative URLs ONLY ("/api/...") — never a hostname or a
// port. The dev proxy (Vite) and the production static serving both route
// /api to the backend. The HTTP-only session cookie carries authentication,
// so every request must send credentials.

import type { DataEnvelope, ErrorEnvelope, ListEnvelope, ListResult } from "../types/api";

// Normalized API failure: every thrown error in the app is an ApiError, so
// components never re-parse response bodies.
export class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = "ApiError";
    }
}

// Global hook invoked when a protected endpoint answers 401: the auth
// provider uses it to drop the session and redirect to /login.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null): void {
    onUnauthorized = handler;
}

const NETWORK_ERROR_CODE = "NETWORK_ERROR";

function fallbackMessage(status: number): string {
    if (status === 401) return "Session expirée. Reconnectez-vous.";
    if (status === 403) return "Droits insuffisants pour cette action.";
    if (status === 404) return "Ressource introuvable.";
    if (status >= 500) return "Erreur interne du serveur. Réessayez.";
    return "Une erreur est survenue.";
}

// Shared response handling: envelope parsing + 401 propagation + ApiError.
async function handleResponse<T>(res: Response, path: string): Promise<T> {
    let payload: unknown = null;
    if (res.status !== 204) {
        try {
            payload = await res.json();
        } catch {
            /* empty or non-JSON body */
        }
    }

    if (!res.ok) {
        const err = (payload as ErrorEnvelope | null)?.error;
        const code = err?.code ?? NETWORK_ERROR_CODE;
        const message = err?.message ?? fallbackMessage(res.status);
        // 401 on a protected route means the cookie died mid-session; auth
        // endpoints (login/me) answer 401 with expected "wrong credentials"
        // or "anonymous" flows, so they are excluded.
        if (res.status === 401 && !path.startsWith("/auth/")) {
            onUnauthorized?.();
        }
        throw new ApiError(res.status, code, message);
    }

    return ((payload as DataEnvelope<T> | null)?.data ?? (null as T));
}

// Core request: parses the { data } / { data, meta } / { error } envelopes.
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
        res = await fetch(`/api${path}`, {
            method,
            headers: body !== undefined ? { "content-type": "application/json" } : undefined,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            credentials: "same-origin",
        });
    } catch {
        throw new ApiError(0, NETWORK_ERROR_CODE, "Serveur injoignable. Vérifiez que l'application est démarrée.");
    }
    return handleResponse<T>(res, path);
}

// POST with a raw (non-JSON) body — e.g. a CSV file uploaded as text/csv or a
// SQLite .db file uploaded as application/octet-stream (Blob/File body). The
// response is still a JSON envelope.
export async function postRaw<T>(path: string, contentType: string, body: string | Blob): Promise<T> {
    let res: Response;
    try {
        res = await fetch(`/api${path}`, {
            method: "POST",
            headers: { "content-type": contentType },
            body,
            credentials: "same-origin",
        });
    } catch {
        throw new ApiError(0, NETWORK_ERROR_CODE, "Serveur injoignable. Vérifiez que l'application est démarrée.");
    }
    return handleResponse<T>(res, path);
}

export function get<T>(path: string): Promise<T> {
    return request<T>("GET", path);
}

export async function getList<T>(path: string): Promise<ListResult<T>> {
    const res = await fetch(`/api${path}`, { method: "GET", credentials: "same-origin" });
    let payload: ListEnvelope<T> | ErrorEnvelope | null = null;
    try {
        payload = (await res.json()) as ListEnvelope<T> | ErrorEnvelope;
    } catch {
        /* non-JSON body */
    }
    if (!res.ok) {
        const err = (payload as ErrorEnvelope | null)?.error;
        if (res.status === 401 && !path.startsWith("/auth/")) onUnauthorized?.();
        throw new ApiError(
            res.status,
            err?.code ?? NETWORK_ERROR_CODE,
            err?.message ?? fallbackMessage(res.status),
        );
    }
    const list = payload as ListEnvelope<T>;
    return { rows: list.data ?? [], total: list.meta?.total ?? (list.data?.length ?? 0) };
}

export function post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>("POST", path, body ?? {});
}

export function patch<T>(path: string, body: object): Promise<T> {
    return request<T>("PATCH", path, body);
}

// POST endpoints without a body (start/stop/cancel/revoke/beep…).
export function postEmpty<T>(path: string): Promise<T> {
    return request<T>("POST", path);
}

export function del<T = undefined>(path: string): Promise<T> {
    return request<T>("DELETE", path);
}

// File download (CSV export, Phase 7). Same authentication and error-envelope
// semantics as JSON requests, then hands the blob to a temporary anchor click.
function filenameFromDisposition(header: string | null): string | null {
    if (!header) return null;
    const match = /filename="?([^";]+)"?/i.exec(header);
    return match?.[1] ?? null;
}

export async function downloadFile(path: string, fallbackName = "export.csv"): Promise<void> {
    let res: Response;
    try {
        res = await fetch(`/api${path}`, { method: "GET", credentials: "same-origin" });
    } catch {
        throw new ApiError(0, NETWORK_ERROR_CODE, "Serveur injoignable. Vérifiez que l'application est démarrée.");
    }
    if (!res.ok) {
        let code = NETWORK_ERROR_CODE;
        let message = fallbackMessage(res.status);
        try {
            const err = ((await res.json()) as ErrorEnvelope | null)?.error;
            if (err) {
                code = err.code;
                message = err.message;
            }
        } catch {
            /* non-JSON error body */
        }
        if (res.status === 401 && !path.startsWith("/auth/")) onUnauthorized?.();
        throw new ApiError(res.status, code, message);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filenameFromDisposition(res.headers.get("content-disposition")) ?? fallbackName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
}

// Translate any thrown value into a concise French UI message. Backend
// messages are already French; only internal/unknown cases get a generic
// message (never leak code or SQL details to the user).
export function toUiMessage(err: unknown): string {
    if (err instanceof ApiError) {
        switch (err.code) {
            case "INTERNAL":
                return "Une erreur est survenue. Réessayez.";
            case "NETWORK_ERROR":
                return "Serveur injoignable. Vérifiez votre connexion.";
            case "NOT_AUTHENTICATED":
                return "Session expirée. Reconnectez-vous.";
            default:
                return err.message || "Une erreur est survenue.";
        }
    }
    if (err instanceof Error) return err.message || "Une erreur est survenue.";
    return "Une erreur est survenue.";
}
