// Helpers purs du planning hebdomadaire : aucun React ici — des fonctions
// déterministes sur des dates « YYYY-MM-DD » LOCALES et des minutes depuis
// minuit, testables et réutilisables (WeekCalendar, SessionDetailsDialog…).
//
// Sémantique d'affichage (alignée sur GET /api/sessions/calendar) :
//   • occurrence de série  → posée à sa date locale occurrence_date, à son
//     heure locale local_time (l'heure murale du cours, inchangée même
//     à travers un changement d'heure été/hiver) ;
//   • session autonome     → posée à l'instant scheduled_at converti dans le
//     fuseau du navigateur (convention d'affichage de toute l'appli).

import type { CalendarSessionRow } from "../types/domain";

export const WEEKDAY_LABELS_FR = [
    "Dimanche",
    "Lundi",
    "Mardi",
    "Mercredi",
    "Jeudi",
    "Vendredi",
    "Samedi",
] as const;

export const WEEKDAY_SHORT_FR = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"] as const;

const pad = (n: number): string => String(n).padStart(2, "0");

// « YYYY-MM-DD » de la date locale de d.
export function localDateKey(d: Date): string {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Minuit local de la date locale « YYYY-MM-DD » (jamais new Date(str) qui,
// lui, interprète « YYYY-MM-DD » en UTC).
export function parseLocalDate(key: string): Date {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d);
}

// Décale une date locale de n jours (arithmétique sur des Date locales :
// safe DST — setHours(0,0,0,0) normalise la veille « heure inexistante »).
export function addLocalDays(key: string, n: number): string {
    const d = parseLocalDate(key);
    d.setDate(d.getDate() + n);
    return localDateKey(d);
}

// Lundi (0 = lundi … 6 = dimanche) de la semaine contenant d.
export function startOfWeekLocal(d: Date): string {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const shift = (x.getDay() + 6) % 7; // lun=0 … dim=6
    x.setDate(x.getDate() - shift);
    return localDateKey(x);
}

// Les 7 dates locales de la semaine commençant à mondayInclusive (lundi).
export function weekDates(mondayInclusive: string): string[] {
    return Array.from({ length: 7 }, (_, i) => addLocalDays(mondayInclusive, i));
}

// Libellé de semaine en français : « 12 – 18 octobre 2026 » (mois omis sur
// la première date quand il est identique).
export function formatWeekRangeLabel(mondayInclusive: string): string {
    const start = parseLocalDate(mondayInclusive);
    const end = parseLocalDate(addLocalDays(mondayInclusive, 6));
    const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
    const fmtFull = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" });
    const fmtDayMonth = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long" });
    return sameMonth
        ? `${start.getDate()} – ${fmtFull.format(end)}`
        : `${fmtDayMonth.format(start)} – ${fmtFull.format(end)}`;
}

export function formatMinutes(min: number): string {
    const wrapped = ((min % 1440) + 1440) % 1440;
    return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}

// Position d'affichage d'une occurrence : jour local + minutes depuis minuit
// (le bloc peut déborder de minuit — c'est borné à l'affichage, jamais une
// occurrence ne traverse la grille car une durée ≤ 1440 min est imposée).
export interface CalendarBlock {
    row: CalendarSessionRow;
    date: string; // « YYYY-MM-DD » du jour de grille
    startMinutes: number;
    endMinutes: number;
    // true quand l'horaire affiché est l'heure locale de la série (murale),
    // false quand c'est l'instant UTC converti en fuseau du navigateur.
    wallClock: boolean;
}

export function blockFromRow(row: CalendarSessionRow): CalendarBlock {
    const duration = Number.isFinite(row.duration_minutes) ? row.duration_minutes : 0;
    if (row.occurrence_date !== null && row.local_time !== null) {
        const [h, m] = row.local_time.split(":").map(Number);
        const start = (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
        return { row, date: row.occurrence_date, startMinutes: start, endMinutes: start + duration, wallClock: true };
    }
    const d = new Date(row.scheduled_at);
    const start = d.getHours() * 60 + d.getMinutes();
    return { row, date: localDateKey(d), startMinutes: start, endMinutes: start + duration, wallClock: false };
}

// Bloc placé dans sa colonne de jour : col/cols viennent de l'empilement des
// chevauchements (largeur = 1/cols, colonne col) — un événement jamais caché.
export interface PlacedBlock extends CalendarBlock {
    col: number;
    cols: number;
}

// Empilement classique : tri (début, puis fin décroissante), regroupement en
// amas qui se chevauchent transitivement, attribution gloutonne de colonne.
export function layoutDay(blocks: CalendarBlock[]): PlacedBlock[] {
    const sorted = [...blocks].sort(
        (a, b) => a.startMinutes - b.startMinutes || b.endMinutes - a.endMinutes,
    );
    const placed: PlacedBlock[] = [];
    let cluster: PlacedBlock[] = [];
    let clusterEnd = -Infinity;
    const colEnds: number[] = [];

    const flush = (): void => {
        const cols = colEnds.length;
        for (const p of cluster) p.cols = cols;
        cluster = [];
        colEnds.length = 0;
    };

    for (const block of sorted) {
        if (cluster.length > 0 && block.startMinutes >= clusterEnd) flush();
        let col = colEnds.findIndex((end) => end <= block.startMinutes);
        if (col === -1) {
            col = colEnds.length;
            colEnds.push(block.endMinutes);
        } else {
            colEnds[col] = block.endMinutes;
        }
        const item: PlacedBlock = { ...block, col, cols: 1 };
        cluster.push(item);
        placed.push(item);
        clusterEnd = Math.max(clusterEnd, block.endMinutes);
    }
    flush();
    return placed;
}

// Nombre de blocs dont le jour tombe hors de la semaine (garde-fou : la
// requête est déjà bornée, mais une occurrence « murale » peut théoriquement
// sortir de la fenêtre demandée selon le fuseau — jamais affichée ailleurs).
export function blocksForDate(blocks: CalendarBlock[], date: string): CalendarBlock[] {
    return blocks.filter((b) => b.date === date);
}
