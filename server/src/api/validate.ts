// API-level input validation — lightweight and dependency-free. It does not
// duplicate unnecessary database constraints: it just ensures that services
// receive correct shapes, with explicit messages.

import { ValidationError } from "../core/errors";
import { EMAIL_MAX_LENGTH, isEmail } from "../core/email";
import { normalizeUid } from "../db/types";
import { isValidLocalDate, parseLocalTime } from "../services/localTime";
import type { UserRole } from "../db/types";

export type Body = Record<string, unknown>;

export function requireBody(body: unknown): Body {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new ValidationError("Corps de requête JSON objet attendu.");
    }
    return body as Body;
}

interface StringOptions {
    required?: boolean;
    min?: number;
    max?: number;
    trim?: boolean; // defaults to true
}

export function vString(obj: Body, field: string, options: StringOptions = {}): string | undefined {
    const raw = obj[field];
    if (raw === undefined || raw === null) {
        if (options.required) throw new ValidationError(`Le champ « ${field} » est requis.`);
        return undefined;
    }
    if (typeof raw !== "string") throw new ValidationError(`Le champ « ${field} » doit être une chaîne.`);
    const value = options.trim === false ? raw : raw.trim();
    if (options.required && value === "") throw new ValidationError(`Le champ « ${field} » ne peut pas être vide.`);
    if (options.min !== undefined && value.length < options.min) {
        throw new ValidationError(`Le champ « ${field} » doit contenir au moins ${options.min} caractères.`);
    }
    if (options.max !== undefined && value.length > options.max) {
        throw new ValidationError(`Le champ « ${field} » doit contenir au plus ${options.max} caractères.`);
    }
    return value;
}

interface IntOptions {
    required?: boolean;
    min?: number;
    max?: number;
}

export function vInt(obj: Body, field: string, options: IntOptions = {}): number | undefined {
    const raw = obj[field];
    if (raw === undefined || raw === null) {
        if (options.required) throw new ValidationError(`Le champ « ${field} » est requis.`);
        return undefined;
    }
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
        throw new ValidationError(`Le champ « ${field} » doit être un entier.`);
    }
    if (options.min !== undefined && raw < options.min) {
        throw new ValidationError(`Le champ « ${field} » doit être ≥ ${options.min}.`);
    }
    if (options.max !== undefined && raw > options.max) {
        throw new ValidationError(`Le champ « ${field} » doit être ≤ ${options.max}.`);
    }
    return raw;
}

interface IntArrayOptions {
    required?: boolean;
    min?: number;
    max?: number;
    maxItems?: number;
}

// Array of integers (e.g. a session's groupIds): duplicates removed, order
// preserved. An empty array is accepted (== no reference) unless required.
export function vIntArray(obj: Body, field: string, options: IntArrayOptions = {}): number[] | undefined {
    const raw = obj[field];
    if (raw === undefined || raw === null) {
        if (options.required) throw new ValidationError(`Le champ « ${field} » est requis.`);
        return undefined;
    }
    if (!Array.isArray(raw)) throw new ValidationError(`Le champ « ${field} » doit être un tableau.`);
    if (options.maxItems !== undefined && raw.length > options.maxItems) {
        throw new ValidationError(`Le champ « ${field} » doit contenir au plus ${options.maxItems} éléments.`);
    }
    const values: number[] = [];
    for (const item of raw) {
        if (typeof item !== "number" || !Number.isInteger(item)) {
            throw new ValidationError(`Le champ « ${field} » ne doit contenir que des entiers.`);
        }
        if (options.min !== undefined && item < options.min) {
            throw new ValidationError(`Le champ « ${field} » ne doit contenir que des entiers ≥ ${options.min}.`);
        }
        if (options.max !== undefined && item > options.max) {
            throw new ValidationError(`Le champ « ${field} » ne doit contenir que des entiers ≤ ${options.max}.`);
        }
        if (!values.includes(item)) values.push(item);
    }
    return values;
}

// Route parameter: positive integer id.
export function parseIdParam(value: string | string[], label = "identifiant"): number {
    const raw = Array.isArray(value) ? value[0] : value;
    if (!/^\d+$/.test(raw)) throw new ValidationError(`Identifiant invalide (${label}).`);
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidationError(`Identifiant invalide (${label}).`);
    return id;
}

// RFID card UID: decimal integer (string), exactly what the reader publishes
// (decID). The final normalization is the DB layer's.
export function parseUidParam(value: string | string[]): string {
    const raw = Array.isArray(value) ? value[0] : value;
    try {
        return normalizeUid(raw);
    } catch {
        throw new ValidationError("UID de carte invalide : entier décimal attendu.");
    }
}

export function vUid(body: Body, field: string, options: { required?: boolean } = {}): string | undefined {
    const raw = vString(body, field, { required: options.required, max: 20 });
    if (raw === undefined) return undefined;
    try {
        return normalizeUid(raw);
    } catch {
        throw new ValidationError(`Le champ « ${field} » doit être un UID décimal (chiffres uniquement).`);
    }
}

// ISO-8601 date (parseable) normalized to UTC ISO with milliseconds.
export function vIsoDate(obj: Body, field: string, options: { required?: boolean } = {}): string | undefined {
    const raw = vString(obj, field, { required: options.required, max: 40 });
    if (raw === undefined) return undefined;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
        throw new ValidationError(`Le champ « ${field} » doit être une date ISO-8601 valide.`);
    }
    return date.toISOString();
}

// Local calendar date 'YYYY-MM-DD' (recurring-series bounds, calendar query
// parameters) : STRICT Gregorian calendar — impossible days like 2026-02-30,
// which SQLite's date() would silently normalize to 2026-03-02, are refused
// (services/localTime is the grammar's single source of truth).
export function vLocalDate(obj: Body, field: string, options: { required?: boolean } = {}): string | undefined {
    const raw = vString(obj, field, { required: options.required, max: 10 });
    if (raw === undefined) return undefined;
    if (!isValidLocalDate(raw)) {
        throw new ValidationError(`Le champ « ${field} » doit être une date calendrier valide (AAAA-MM-JJ).`);
    }
    return raw;
}

// Local wall-clock time 'HH:MM' (24-hour), same grammar as the migration 008
// CHECKs and services/localTime.
export function vLocalTime(obj: Body, field: string, options: { required?: boolean } = {}): string | undefined {
    const raw = vString(obj, field, { required: options.required, max: 5 });
    if (raw === undefined) return undefined;
    if (!parseLocalTime(raw)) {
        throw new ValidationError(`Le champ « ${field} » doit être une heure au format « HH:MM » (24 h).`);
    }
    return raw;
}

export function vEmail(obj: Body, field: string, options: { required?: boolean } = {}): string | undefined {
    const raw = vString(obj, field, { required: options.required, max: EMAIL_MAX_LENGTH });
    if (raw === undefined) return undefined;
    if (!isEmail(raw)) {
        throw new ValidationError(`Le champ « ${field} » doit être une adresse e-mail valide.`);
    }
    return raw;
}

const ROLES: readonly UserRole[] = ["admin", "teacher", "kiosk"];

export function vRole(value: unknown): UserRole {
    if (!ROLES.includes(value as UserRole)) {
        throw new ValidationError("Rôle invalide : « admin », « teacher » ou « kiosk » attendu.");
    }
    return value as UserRole;
}

export function vUsername(value: string): string {
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(value)) {
        throw new ValidationError(
            "Nom d'utilisateur invalide : 3 à 32 caractères (lettres, chiffres, « . », « _ », « - »).",
        );
    }
    return value;
}

export function vPassword(value: string, options: { minLength?: number } = {}): string {
    const minLength = options.minLength ?? 8;
    if (value.length < minLength || value.length > 200) {
        throw new ValidationError(`Mot de passe invalide : entre ${minLength} et 200 caractères.`);
    }
    return value;
}

// Rejects unknown keys in a body (silent typos).
export function rejectUnknownFields(obj: Body, allowed: readonly string[]): void {
    for (const key of Object.keys(obj)) {
        if (!allowed.includes(key)) throw new ValidationError(`Champ inconnu : « ${key} ».`);
    }
}

// ─── Query-string helpers (reporting filters, Phase 7) ───────────────────────
// Query parameters arrive as strings (or string arrays); these helpers keep
// the same explicit-validation spirit as the body helpers above. An empty
// value ("?from=") counts as absent.

function firstQueryValue(obj: Body, field: string): string | undefined {
    const raw = obj[field];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value === undefined || value === null || value === "") return undefined;
    return String(value);
}

export function qInt(obj: Body, field: string, options: IntOptions = {}): number | undefined {
    const raw = firstQueryValue(obj, field);
    if (raw === undefined) {
        if (options.required) throw new ValidationError(`Le paramètre « ${field} » est requis.`);
        return undefined;
    }
    if (!/^-?\d+$/.test(raw)) throw new ValidationError(`Le paramètre « ${field} » doit être un entier.`);
    const value = Number(raw);
    if (options.min !== undefined && value < options.min) {
        throw new ValidationError(`Le paramètre « ${field} » doit être ≥ ${options.min}.`);
    }
    if (options.max !== undefined && value > options.max) {
        throw new ValidationError(`Le paramètre « ${field} » doit être ≤ ${options.max}.`);
    }
    return value;
}

// Calendar date (YYYY-MM-DD), returned unchanged: it is compared against the
// ISO-8601 UTC prefix stored in the database (substr(timestamp, 1, 10)).
export function qDate(obj: Body, field: string, options: { required?: boolean } = {}): string | undefined {
    const raw = firstQueryValue(obj, field);
    if (raw === undefined) {
        if (options.required) throw new ValidationError(`Le paramètre « ${field} » est requis.`);
        return undefined;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) !== raw) {
        throw new ValidationError(`Le paramètre « ${field} » doit être une date au format AAAA-MM-JJ.`);
    }
    return raw;
}

export function qEnum<T extends string>(
    obj: Body,
    field: string,
    values: readonly T[],
    options: { required?: boolean } = {},
): T | undefined {
    const raw = firstQueryValue(obj, field);
    if (raw === undefined) {
        if (options.required) throw new ValidationError(`Le paramètre « ${field} » est requis.`);
        return undefined;
    }
    if (!(values as readonly string[]).includes(raw)) {
        throw new ValidationError(`Le paramètre « ${field} » doit être l'un de : ${values.join(", ")}.`);
    }
    return raw as T;
}
