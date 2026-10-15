// Onglet « Calendrier » des sessions : semaine courante navigable, données
// via GET /api/sessions/calendar (le client ne fetch JAMAIS directement),
// rechargement déclenché par les événements WebSocket de cycle de vie
// (session:started/stopped/updated) et le re-branchement (epoch) — les scans
// d'assiduité ne provoquent AUCUN rechargement (le comptage des participants
// n'est pas une donnée de grille minute par minute).
//
// Dialogues : création (ponctuelle/série), détail d'occurrence, modification
// avec portée explicite. Les changements de SÉRIE sont diffusés par WebSocket
// (événement « series:changed » — création/édition/pause/reprise/annulation
// côté serveur, et « generated » quand le scheduler matérialise de nouvelles
// occurrences) : le calendrier se resync sur cet événement (debounce), après
// chaque action locale, et une re-planification différée reste le filet si la
// connexion WS est momentanément indisponible.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getCalendar } from "../../api/sessions";
import { useWebSocket } from "../../hooks/useWebSocket";
import { useToast } from "../../hooks/useToast";
import { addLocalDays, startOfWeekLocal } from "../../lib/calendar";
import type { CalendarSessionRow, SeriesDetail } from "../../types/domain";
import { EmptyState, ErrorState, Loading } from "../common/StateBlocks";
import { Modal } from "../common/Modal";
import { CreateSessionDialog } from "./CreateSessionDialog";
import { SessionDetailsDialog } from "./SessionDetailsDialog";
import { SessionEditDialog } from "./SessionEditDialog";
import { WeekCalendar } from "./WeekCalendar";
import type { CalendarRange } from "./WeekCalendar";

const RANGE_STORAGE_KEY = "rfweb.calendar.range";
const DEFAULT_RANGE: CalendarRange = { startHour: 7, endHour: 19 };

// Créneau choisi par clic/glisser sur la grille : pré-remplissage du
// dialogue de création (date + heure + durée), jamais une création directe.
interface CreatePreset {
    scheduledAt: string; // « YYYY-MM-DDTHH:MM » local (input datetime-local)
    durationMinutes: number;
    startsOn: string; // « YYYY-MM-DD » local (début de série)
    localTime: string; // « HH:MM » local (heure murale de série)
}

function loadRange(): CalendarRange {
    try {
        const raw = localStorage.getItem(RANGE_STORAGE_KEY);
        if (!raw) return DEFAULT_RANGE;
        const parsed = JSON.parse(raw) as Partial<CalendarRange>;
        const startHour = Number(parsed.startHour);
        const endHour = Number(parsed.endHour);
        if (
            Number.isInteger(startHour) &&
            Number.isInteger(endHour) &&
            startHour >= 0 &&
            endHour <= 23 &&
            startHour < endHour
        ) {
            return { startHour, endHour };
        }
    } catch {
        /* stockage indisponible ou corrompu : réglages par défaut */
    }
    return DEFAULT_RANGE;
}

export function SessionsCalendar() {
    const { epoch, subscribe } = useWebSocket();
    const { push } = useToast();

    const [weekStart, setWeekStart] = useState(() => startOfWeekLocal(new Date()));
    const [range, setRange] = useState<CalendarRange>(loadRange);
    const [rows, setRows] = useState<CalendarSessionRow[] | null>(null);
    const [error, setError] = useState<unknown>(null);
    const [reloadTick, setReloadTick] = useState(0);

    const [creating, setCreating] = useState(false);
    const [createPreset, setCreatePreset] = useState<CreatePreset | null>(null);
    const [detailsRow, setDetailsRow] = useState<CalendarSessionRow | null>(null);
    const [editRow, setEditRow] = useState<CalendarSessionRow | null>(null);

    // Génération de requête : une navigation rapide dans les semaines ne doit
    // jamais laisser une réponse tardive écraser la semaine affichée.
    const genRef = useRef(0);

    const load = useCallback((): void => {
        const gen = ++genRef.current;
        setError(null);
        getCalendar(weekStart, addLocalDays(weekStart, 6))
            .then((res) => {
                if (gen === genRef.current) setRows(res.rows);
            })
            .catch((err) => {
                if (gen === genRef.current) {
                    setError(err);
                    setRows(null);
                }
            });
    }, [weekStart]);

    useEffect(load, [load, epoch, reloadTick]);

    // Rechargement à la demande (debounce : une rafale d'événements ne
    // déclenche qu'un seul GET).
    const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const scheduleReload = useCallback((delayMs = 350): void => {
        if (reloadTimer.current) clearTimeout(reloadTimer.current);
        reloadTimer.current = setTimeout(() => setReloadTick((t) => t + 1), delayMs);
    }, []);
    useEffect(() => () => {
        if (reloadTimer.current) clearTimeout(reloadTimer.current);
        if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
    }, []);

    useEffect(() => {
        return subscribe((event) => {
            if (
                event.event === "session:started" ||
                event.event === "session:stopped" ||
                event.event === "session:updated" ||
                event.event === "series:changed"
            ) {
                scheduleReload();
            }
        });
    }, [subscribe, scheduleReload]);

    const handleRangeChange = (next: CalendarRange): void => {
        setRange(next);
        try {
            localStorage.setItem(RANGE_STORAGE_KEY, JSON.stringify(next));
        } catch {
            /* stockage indisponible : réglage non persisté, sans gravité */
        }
    };

    const onChanged = useCallback((): void => setReloadTick((t) => t + 1), []);

    const openCreate = useCallback((preset: CreatePreset | null): void => {
        setCreatePreset(preset);
        setCreating(true);
    }, []);
    const closeCreate = useCallback((): void => setCreating(false), []);

    // Clic/glisser dans une colonne vide → dialogue de création pré-rempli
    // avec le jour et les heures choisis (aucune séance n'est créée ici).
    const handleCreateRange = useCallback(
        (date: string, startMinutes: number, endMinutes: number): void => {
            const hh = String(Math.floor(startMinutes / 60)).padStart(2, "0");
            const mm = String(startMinutes % 60).padStart(2, "0");
            openCreate({
                scheduledAt: `${date}T${hh}:${mm}`,
                durationMinutes: endMinutes - startMinutes,
                startsOn: date,
                localTime: `${hh}:${mm}`,
            });
        },
        [openCreate],
    );

    // Après une création, les occurrences d'une nouvelle série n'existent pas
    // encore (le scheduler les matérialise au prochain tick ≤ 10 s et diffuse
    // alors « series:changed {generated} »). Ce timer est le FILET si
    // l'événement WebSocket ne parvient pas (connexion momentanément bas).
    const afterSeriesCreated = useCallback((): void => {
        if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
        fallbackTimer.current = setTimeout(() => setReloadTick((t) => t + 1), 12_000);
    }, []);

    const empty = useMemo(() => rows !== null && rows.length === 0, [rows]);

    return (
        <div className="page">
            <div className="page__header">
                <button className="btn btn--primary" onClick={() => openCreate(null)}>
                    Nouvelle séance
                </button>
            </div>

            {error !== null ? (
                <ErrorState error={error} onRetry={load} text="Impossible de charger le calendrier." />
            ) : rows === null ? (
                <Loading text="Chargement du calendrier…" />
            ) : (
                <>
                    {empty && (
                        <EmptyState text="Aucun cours programmé cette semaine — créez une séance ou déplacez-vous dans les semaines." />
                    )}
                    <WeekCalendar
                        weekStart={weekStart}
                        rows={rows}
                        range={range}
                        onRangeChange={handleRangeChange}
                        onWeekChange={setWeekStart}
                        onSelect={(row) => setDetailsRow(row)}
                        onCreateRange={handleCreateRange}
                    />
                </>
            )}

            {creating && (
                <Modal title="Nouvelle séance" onClose={closeCreate} width="wide">
                    <CreateSessionDialog
                        initialScheduledAt={createPreset?.scheduledAt}
                        initialDurationMinutes={createPreset?.durationMinutes}
                        onCreatedOnce={(label) => {
                            setCreating(false);
                            push("success", `Séance « ${label} » créée.`);
                            onChanged();
                        }}
                        onCreatedSeries={(series: SeriesDetail) => {
                            setCreating(false);
                            push(
                                "success",
                                `Série « ${series.label} » créée — les cours planifiés apparaîtront au calendrier d'ici quelques instants.`,
                            );
                            onChanged();
                            afterSeriesCreated();
                        }}
                        onError={(message) => push("danger", message)}
                        onClose={() => setCreating(false)}
                    />
                </Modal>
            )}

            {detailsRow !== null && (
                <Modal
                    title={toUiTitle(detailsRow)}
                    onClose={() => setDetailsRow(null)}
                    width="wide"
                >
                    <SessionDetailsDialog
                        row={detailsRow}
                        onChanged={onChanged}
                        onEdit={(row) => {
                            setDetailsRow(null);
                            setEditRow(row);
                        }}
                        onClose={() => setDetailsRow(null)}
                    />
                </Modal>
            )}

            {editRow !== null && (
                <Modal title={`Modifier — ${editRow.label}`} onClose={() => setEditRow(null)} width="wide">
                    <SessionEditDialog
                        row={editRow}
                        onChanged={onChanged}
                        onDone={() => setEditRow(null)}
                    />
                </Modal>
            )}
        </div>
    );
}

function toUiTitle(row: CalendarSessionRow): string {
    return row.series_id !== null ? `Séance de série — ${row.label}` : `Séance — ${row.label}`;
}
