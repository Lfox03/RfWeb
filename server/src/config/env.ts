import fs from "node:fs";
import path from "node:path";

// Repository root: folders at the same depth in dev (server/src/config)
// as in prod (dist/server/config), so this calculation is identical in both cases.
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");

// Loads .env at the repository root if it exists (before any import that reads
// process.env — WebSocket port, database path, etc.).
const envPath = path.join(PROJECT_ROOT, ".env");
if (fs.existsSync(envPath)) {
    process.loadEnvFile(envPath);
}

function flag(value: string | undefined): boolean {
    return /^(1|true|yes|on)$/i.test(value ?? "");
}

export const HTTP_HOST = process.env.HTTP_HOST ?? "";
export const HTTP_PORT = Number(process.env.HTTP_PORT ?? 3000);

// TypeScript WebSocket server (domain events — server/src/websocket).
export const WS_PORT = Number(process.env.WS_PORT ?? 8080);

// Authentication sessions (HTTP-only cookie, persistent SQLite store).
export const COOKIE_NAME = process.env.COOKIE_NAME ?? "sid";
export const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS ?? 12);
// Enable only behind an HTTPS reverse proxy ("Secure" cookie).
export const COOKIE_SECURE = flag(process.env.COOKIE_SECURE);

// Set to 1 ONLY when the server sits behind a reverse proxy (nginx, IIS…):
// then req.ip is taken from X-Forwarded-For. Without it the socket address is
// the only trusted source, so forwarded headers cannot forge a client IP.
export const TRUST_PROXY = flag(process.env.TRUST_PROXY);

// Brute-force protection on POST /api/auth/login (in-memory, per process).
// A bucket (per IP and per normalized username) that accumulates more than
// LOGIN_FAIL_LIMIT_* failed attempts inside the window gets progressively
// locked out: backoff = BASE × 2^(failures − limit), capped at MAX. A
// successful login clears the caller's buckets.
export const LOGIN_FAIL_LIMIT_PER_IP = Number(process.env.LOGIN_FAIL_LIMIT_PER_IP ?? 10);
export const LOGIN_FAIL_LIMIT_PER_USER = Number(process.env.LOGIN_FAIL_LIMIT_PER_USER ?? 5);
export const LOGIN_RATE_WINDOW_MINUTES = Number(process.env.LOGIN_RATE_WINDOW_MINUTES ?? 15);
export const LOGIN_BACKOFF_BASE_SECONDS = Number(process.env.LOGIN_BACKOFF_BASE_SECONDS ?? 30);
export const LOGIN_BACKOFF_MAX_MINUTES = Number(process.env.LOGIN_BACKOFF_MAX_MINUTES ?? 15);

// Without a reader (CI, dev machine): RFID_DISABLED=1 replaces the hardware by
// an offline stub — the server starts and the API stays fully testable.
export const RFID_DISABLED = flag(process.env.RFID_DISABLED);

// Directory where the admin « Base de données » backups (.db) are written
// (created on demand). CWD-relative like DB_PATH; use an absolute path in prod.
export const BACKUP_DIR = process.env.BACKUP_DIR ?? "./backups";

// Maximum uploaded size (Mo) for a full-database restore (POST /api/backups/restore).
export const BACKUP_RESTORE_MAX_MB = Number(process.env.BACKUP_RESTORE_MAX_MB ?? 100);

// How many of the most recent log lines the in-memory tail keeps for the admin
// « Journaux » screen (core/logBuffer.ts). Volatile — never persisted. Lines are
// buffered post-redaction, so a smaller value only shortens the visible tail.
export const LOG_BUFFER_SIZE = Number(process.env.LOG_BUFFER_SIZE ?? 500);

// Rolling horizon (in weeks) over which the recurring-series generation service
// (services/seriesService) materializes occurrences into app_sessions.
// Generation is idempotent, so a larger horizon only pushes more scheduled
// occurrences further ahead of the current date.
export const SERIES_HORIZON_WEEKS = Number(process.env.SERIES_HORIZON_WEEKS ?? 12);
