// Fuseaux horaires proposés aux formulaires de récurrence. Le serveur valide
// n'importe quel identifiant IANA (Intl) — cette liste est un confort, pas une
// limite : le fuseau détecté du navigateur est toujours proposé en tête.

const CURATED = [
    "UTC",
    "Europe/Paris",
    "Europe/London",
    "Europe/Madrid",
    "Europe/Brussels",
    "Europe/Zurich",
    "Africa/Casablanca",
    "Africa/Algiers",
    "Africa/Dakar",
    "America/Cayenne",
    "America/Guadeloupe",
    "America/Martinique",
    "America/Montreal",
    "America/New_York",
    "America/Mexico_City",
    "America/Bogota",
    "America/Lima",
    "America/Sao_Paulo",
    "Indian/Reunion",
    "Indian/Mayotte",
    "Pacific/Tahiti",
    "Pacific/Noumea",
];

export function browserTimezone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
        return "UTC";
    }
}

// Liste dédiée au <select> : fuseau courant en tête, puis la liste triée.
export function timezoneOptions(): string[] {
    const current = browserTimezone();
    const rest = [...new Set(CURATED)].filter((tz) => tz !== current).sort();
    return [current, ...rest];
}

export function isValidTimezone(tz: string): boolean {
    try {
        new Intl.DateTimeFormat("fr-FR", { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}
