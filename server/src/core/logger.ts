// Structured application logger — ONE exit point for every runtime log line.
//
// Format : une ligne JSON par événement, toujours les mêmes clés réservées en
// tête — { "timestamp": ISO-8601 UTC, "level", "event", ...champs contexte }.
// Le `event` est un identifiant stable en pointillés (`auth.login_failed`,
// `scan.accepted`, …) ; le texte humain ne vit ni dans le message ni dans un
// champ libre sensible : ce sont les champs typés qui portent le contexte.
//
// Confidentialité (jamais dans une ligne de log) : mots de passe, tokens de
// session / cookies, en-têtes d'autorisation, et UID RFID complets (les champs
// `uid`/`decid`/`hexid` sont masqués aux 4 derniers chiffres), noms de
// personnes (identifiants numériques uniquement). La sanitation est
// appliquée à ÉCHAQUE écriture (clé sensible → "[redacted]", récursif) :
// un appel fautif ne peut pas fuiter, la politique est dans un seul fichier.
//
// Les stack traces ne sont journalisées QUE pour les erreurs internes (500) —
// décidée par l'appelant (middleware d'erreur HTTP), jamais automatiquement.
// Rien de tout ceci ne quitte le serveur : les réponses API restent
// l'enveloppe { error: { code, message } } (api/middleware/error.ts).
//
// Le niveau minimal vient de LOG_LEVEL (debug|info|warn|error, défaut info)
// lu à chaud. La sortie par défaut va sur stdout (debug/info) et stderr
// (warn/error) ; setLogSink() remplace la destination (même patron d'
// injection que le lecteur RFID et l'horloge — api:verify capture les lignes
// ainsi, sans dépendre de la capture console).
//
// Le timestamp suit l'horloge RÉELLE (et non l'horloge injectée) : les logs
// sont un flux opérationnel, pas des données d'affaires — FakeClock ne doit
// pas réécrire l'heure d'exécution.

import { captureLog } from "./logBuffer";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
    [key: string]: unknown;
}

export interface Logger {
    debug(event: string, fields?: LogFields): void;
    info(event: string, fields?: LogFields): void;
    warn(event: string, fields?: LogFields): void;
    error(event: string, fields?: LogFields): void;
    // Logger dérivé : chaque ligne hérite des champs liés (ex. { component }).
    child(bindings: LogFields): Logger;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Clés réservées : jamais écrasées par un champ de contexte.
const RESERVED_KEYS = new Set(["timestamp", "level", "event"]);

// Clés sensibles (forme normalisée : minuscules, « _ » retirés). Toute valeur
// sous l'une de ces clés, à n'importe quelle profondeur, est remplacée.
const REDACTED = "[redacted]";
const SENSITIVE_KEYS = new Set([
    "password",
    "passwordhash",
    "newpassword",
    "currentpassword",
    "confirmpassword",
    "token",
    "sessiontoken",
    "sid",
    "cookie",
    "cookieheader",
    "setcookie",
    "authorization",
    "secret",
    "apikey",
]);

// Champs portant un UID RFID complet : masqués (4 derniers chiffres) plutôt
// que supprimés — le suffixe reste suffisant pour recouper un scan.
const UID_KEYS = new Set(["uid", "decid", "hexid", "carduid"]);
const UID_MASK = "***";

const MAX_DEPTH = 4;

function normalizeKey(key: string): string {
    return key.toLowerCase().replace(/_/g, "");
}

// « 9000001 » → « ***0001 » ; un uid trop court pour être identifiable est
// intégralement masqué.
export function maskUid(uid: unknown): string {
    const text = String(uid ?? "");
    if (text.length <= UID_MASK.length) return UID_MASK;
    return UID_MASK + text.slice(-4);
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (value === null || value === undefined) return value ?? undefined;
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
    if (typeof value === "bigint") return value.toString();
    if (typeof value !== "object") return String(value); // function, symbol…

    if (value instanceof Error) {
        // Un Error qui arrive jusque-là est journalisé sans stack : la stack
        // est un choix explicite de l'appelant via errorFields().
        return { name: value.name, message: value.message };
    }
    if (depth >= MAX_DEPTH) return "[truncated]";
    if (seen.has(value)) return "[circular]";
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map((item) => sanitizeValue(item, depth + 1, seen));
    }

    const out: LogFields = {};
    for (const [key, raw] of Object.entries(value as LogFields)) {
        if (RESERVED_KEYS.has(key)) continue;
        const normalized = normalizeKey(key);
        if (SENSITIVE_KEYS.has(normalized)) {
            out[key] = REDACTED;
        } else if (UID_KEYS.has(normalized) && (typeof raw === "string" || typeof raw === "number")) {
            out[key] = maskUid(raw);
        } else {
            out[key] = sanitizeValue(raw, depth + 1, seen);
        }
    }
    return out;
}

function sanitizeFields(fields: LogFields | undefined, seen: WeakSet<object>): LogFields {
    if (!fields) return {};
    const out: LogFields = {};
    for (const [key, raw] of Object.entries(fields)) {
        if (RESERVED_KEYS.has(key)) continue;
        const normalized = normalizeKey(key);
        if (SENSITIVE_KEYS.has(normalized)) {
            out[key] = REDACTED;
        } else if (UID_KEYS.has(normalized) && (typeof raw === "string" || typeof raw === "number")) {
            out[key] = maskUid(raw);
        } else {
            out[key] = sanitizeValue(raw, 0, seen);
        }
    }
    return out;
}

// Contexte d'une erreur inconnue — message (et stack, uniquement quand
// l'appelant le demande : erreurs internes 500 uniquement).
export function errorFields(err: unknown, options?: { stack?: boolean }): LogFields {
    if (err instanceof Error) {
        const info: LogFields = { name: err.name, message: err.message };
        if (options?.stack && err.stack) info.stack = err.stack;
        return { error: info };
    }
    return { error: String(err) };
}

// ─── Destination des lignes (seam d'injection) ────────────────────────────────

export type LogSink = (line: string, level: LogLevel, record: LogFields) => void;

const defaultSink: LogSink = (line, level) => {
    if (level === "warn" || level === "error") console.error(line);
    else console.log(line);
};

let activeSink: LogSink = defaultSink;

// Remplace la destination des lignes (test seam). Retourne la restauration.
export function setLogSink(sink: LogSink): () => void {
    const previous = activeSink;
    activeSink = sink;
    return () => {
        activeSink = previous;
    };
}

function minWeight(): number {
    const raw = (process.env.LOG_LEVEL ?? "").trim().toLowerCase();
    return raw in LEVEL_WEIGHT ? LEVEL_WEIGHT[raw as LogLevel] : LEVEL_WEIGHT.info;
}

function emit(bindings: LogFields, level: LogLevel, event: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[level] < minWeight()) return;
    const seen = new WeakSet<object>();
    const record: LogFields = {
        timestamp: new Date().toISOString(),
        level,
        event,
        ...sanitizeFields(bindings, seen),
        ...sanitizeFields(fields, seen),
    };
    let line: string;
    try {
        line = JSON.stringify(record);
    } catch {
        // Valeur non sérialisable malgré la sanitation : ligne minimale,
        // jamais une exception qui ferait tomber l'appelant.
        line = JSON.stringify({ timestamp: record.timestamp, level, event: "log.unserializable" });
        record.event = "log.unserializable";
    }
    // Destination miroir du tampon mémoire (écran « Journaux » admin) : la
    // ligne déjà sanitisée, exactement telle qu'elle part vers le sink.
    captureLog(line, level, record);
    activeSink(line, level, record);
}

function makeLogger(bindings: LogFields): Logger {
    return {
        debug: (event, fields) => emit(bindings, "debug", event, fields),
        info: (event, fields) => emit(bindings, "info", event, fields),
        warn: (event, fields) => emit(bindings, "warn", event, fields),
        error: (event, fields) => emit(bindings, "error", event, fields),
        child: (extra) => makeLogger({ ...bindings, ...sanitizeFields(extra, new WeakSet<object>()) }),
    };
}

// Logger racine ; chaque module dérive le sien avec son composant :
//   const log = logger.child({ component: "attendance" });
export const logger = makeLogger({});
