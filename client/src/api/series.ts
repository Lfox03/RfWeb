// Séries récurrentes (seriesRouter) — modèles de cours programmés dont le
// ordonnanceur matérialise les occurrences sur un horizon roulant. Contrat
// exact de l'API (ne rien inventer) :
//   POST   /series            → SeriesDetail (201) — aucune occurrence créée
//                               ici, la génération appartient au scheduler.
//   GET    /series            → SeriesWithGroups[]
//   GET    /series/:id        → SeriesDetail (avec participants)
//   PATCH  /series/:id        → SeriesEditResult — édition « à partir de
//                               cette date » ; fromDate DOIT être une date
//                               d'occurrence existante (404 sinon) ; les
//                               participants sont éditables (Phase 5) : les
//                               copies héritées des futures occurrences
//                               « programmées » sont resynchronisées, les
//                               dérogations explicites par occurrence
//                               survivent (migration 009).
//   POST   /series/:id/pause  → SessionSeriesRow (paused)
//   POST   /series/:id/resume → SessionSeriesRow (active)
//   POST   /series/:id/cancel → SeriesCancellation { series, cancelled[] }
//                               — corp { from? } optionnel : date locale de
//                               l'annulation du futur planifié (défaut :
//                               aujourd'hui dans le fuseau de la série).

import { get, getList, patch, post, postEmpty } from "./client";
import type { ListResult } from "../types/api";
import type {
    SeriesCancellation,
    SeriesDetail,
    SeriesEditResult,
    SeriesWithGroups,
} from "../types/domain";

export interface SeriesInput {
    label: string;
    recurrence: "daily" | "weekly";
    // 0 = dimanche … 6 = samedi (convention JS getDay). Obligatoire si
    // « weekly », doit être null/absent si « daily ».
    weekday: number | null;
    localTime: string; // "HH:MM"
    timezone?: string; // IANA, défaut serveur "UTC"
    durationMinutes?: number;
    startsOn: string; // "YYYY-MM-DD" (inclusive)
    endsOn?: string | null; // "YYYY-MM-DD" (inclusive) ou null = sans fin
    groupIds: number[];
    participants?: Array<{ studentId: number; included: boolean }>;
}

// Patch d'édition : mêmes champs que la création (participants inclus depuis
// Phase 5 — remplacement de la liste des écarts) + fromDate obligatoire =
// date d'occurrence ancre.
export interface SeriesPatchInput extends Partial<SeriesInput> {
    fromDate: string;
}

export function listSeries(): Promise<ListResult<SeriesWithGroups>> {
    return getList<SeriesWithGroups>("/series");
}

export function getSeries(id: number): Promise<SeriesDetail> {
    return get<SeriesDetail>(`/series/${id}`);
}

export function createSeries(input: SeriesInput): Promise<SeriesDetail> {
    return post<SeriesDetail>("/series", input);
}

export function editSeriesFrom(id: number, input: SeriesPatchInput): Promise<SeriesEditResult> {
    return patch<SeriesEditResult>(`/series/${id}`, input);
}

export function pauseSeries(id: number): Promise<unknown> {
    return postEmpty<unknown>(`/series/${id}/pause`);
}

export function resumeSeries(id: number): Promise<unknown> {
    return postEmpty<unknown>(`/series/${id}/resume`);
}

// from = date locale « YYYY-MM-DD » à partir de laquelle le futur planifié est
// annulé (le calendrier envoie la date de l'occurrence cliquée ; omis =
// aujourd'hui dans le fuseau de la série côté serveur).
export function cancelSeries(id: number, from?: string): Promise<SeriesCancellation> {
    return post<SeriesCancellation>(`/series/${id}/cancel`, from ? { from } : {});
}
