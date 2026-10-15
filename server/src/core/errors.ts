// Typed application errors — translated into clean HTTP responses by the
// centralized error middleware (api/middleware/error.ts). The message is
// meant for the client (French, no internal details); the code is stable and
// consumable by the frontend.

export class AppError extends Error {
    readonly status: number;
    readonly code: string;

    constructor(status: number, code: string, message: string) {
        super(message);
        this.name = new.target.name;
        this.status = status;
        this.code = code;
    }
}

export class ValidationError extends AppError {
    constructor(message: string) {
        super(400, "VALIDATION_ERROR", message);
    }
}

export class NotFoundError extends AppError {
    constructor(what: string) {
        super(404, "NOT_FOUND", `${what} introuvable.`);
    }
}

export class ConflictError extends AppError {
    constructor(code: string, message: string) {
        super(409, code, message);
    }
}

export class AuthenticationError extends AppError {
    constructor(message = "Authentification requise.", code = "NOT_AUTHENTICATED") {
        super(401, code, message);
    }
}

// Too many failed login attempts (rate limiter, api/middleware/loginRateLimit).
// retryAfterSeconds drives the Retry-After response header.
export class RateLimitError extends AppError {
    readonly retryAfterSeconds: number;

    constructor(retryAfterSeconds: number, message = "Trop de tentatives de connexion. Réessayez plus tard.") {
        super(429, "RATE_LIMITED", message);
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

export class AuthorizationError extends AppError {
    constructor(message = "Droits insuffisants.") {
        super(403, "FORBIDDEN", message);
    }
}

export class ReaderOfflineError extends AppError {
    constructor(message = "Lecteur RFID hors ligne.") {
        super(503, "READER_OFFLINE", message);
    }
}

// One-shot card read (POST /api/reader/next-card) timed out: no card was
// presented within the allowed window.
export class ReaderTimeoutError extends AppError {
    constructor(message = "Aucune carte présentée dans le délai imparti.") {
        super(504, "READER_TIMEOUT", message);
    }
}

// The reader cannot serve this request right now (scan loop busy or another
// card read still pending).
export class ReaderBusyError extends ConflictError {
    constructor(message = "Le lecteur RFID est déjà occupé.") {
        super("READER_BUSY", message);
        this.name = "ReaderBusyError";
    }
}

// An administrator must not be able to change their own role: the only
// self-role change an admin could make is a demotion, which would lock them
// out of user management (and eventually of every admin-only screen).
export class SelfRoleChangeError extends ConflictError {
    constructor(message = "Vous ne pouvez pas modifier votre propre rôle.") {
        super("SELF_ROLE_CHANGE", message);
        this.name = "SelfRoleChangeError";
    }
}

// Invalid session state transition (e.g. completed → running) or
// session conflict (already active, another one active…).
export class SessionStateError extends ConflictError {
    constructor(code: string, message: string) {
        super(code, message);
        this.name = "SessionStateError";
    }
}

// SQLite online backup failed (services/backupService). The underlying error
// is logged server-side only — never returned to the client.
export class BackupError extends AppError {
    constructor(message = "La sauvegarde de la base de données a échoué. Réessayez.") {
        super(500, "BACKUP_FAILED", message);
        this.name = "BackupError";
    }
}
