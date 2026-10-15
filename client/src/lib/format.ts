// Display formatting helpers. All outputs are French (user-facing).

import type { ScanResult, SessionStatus, UserRole } from "../types/domain";

const timeFmt = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
const dateTimeFmt = new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
});
const dateFmt = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });

export function formatTime(iso: string | null | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : timeFmt.format(d);
}

// Log timestamp: local HH:MM:SS.mmm (milliseconds matter when tailing logs).
export function formatLogTime(iso: string | null | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const pad = (n: number, len = 2): string => String(n).padStart(len, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function formatDateTime(iso: string | null | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : dateTimeFmt.format(d);
}

export function formatDate(iso: string | null | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : dateFmt.format(d);
}

export function fullName(first: string | null | undefined, last: string | null | undefined): string {
    return [first, last].filter(Boolean).join(" ") || "—";
}

// Byte size in French (« 1,5 Mo ») — backup list, file attachments.
export function formatFileSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    const units = ["o", "Ko", "Mo", "Go", "To"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const fmt = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: unit === 0 ? 0 : 1 });
    return `${fmt.format(value)} ${units[unit]}`;
}

export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
    scheduled: "Programmée",
    running: "En cours",
    completed: "Terminée",
    cancelled: "Annulée",
};

export const SCAN_RESULT_LABEL: Record<ScanResult, string> = {
    accepted: "Présence enregistrée",
    duplicate: "Déjà présent",
    unknown: "Carte inconnue",
    expired: "Carte retirée",
    out_of_group: "Hors session",
    manual: "Présence manuelle",
};

export const ROLE_LABEL: Record<UserRole, string> = {
    admin: "Administrateur",
    teacher: "Enseignant",
    kiosk: "Borne",
};

// Value for <input type="datetime-local"> from an ISO string (local time).
export function toLocalInputValue(iso: string | null | undefined): string {
    const d = iso ? new Date(iso) : new Date();
    const base = Number.isNaN(d.getTime()) ? new Date() : d;
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}T${pad(base.getHours())}:${pad(base.getMinutes())}`;
}
