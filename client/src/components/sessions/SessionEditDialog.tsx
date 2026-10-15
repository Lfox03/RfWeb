// Dialogue « Modifier » d'une occurrence.
//
// Deux portées explicites pour une occurrence de série (choix explicite,
// jamais implicite) :
//   • « Uniquement cette occurrence »      → PATCH /api/sessions/:id
//     (label / durée ; instant UTC seulement pour une session autonome —
//     une occurrence de série ne se déplace pas elle-même, le serveur
//     renverrait 409 SESSION_OCCURRENCE_MOVE) ;
//   • « Cette occurrence et les suivantes » → PATCH /api/series/:id avec
//     fromDate = occurrence_date cliquée (réécriture transactionnelle des
//     futures occurrences « scheduled » par seriesService.editSeriesFrom).
// Une session autonome n'a qu'une portée. Les 409 (occurrence déjà démarrée,
// série annulée, patron invalide) sont signalés par un toast puis le
// calendrier est rechargé : l'état affiché était périmé.

import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { ApiError, toUiMessage } from "../../api/client";
import { listGroups } from "../../api/groups";
import { editSeriesFrom, getSeries } from "../../api/series";
import { updateSession } from "../../api/sessions";
import { listStudents } from "../../api/students";
import { useToast } from "../../hooks/useToast";
import { toLocalInputValue } from "../../lib/format";
import type {
    GroupRow,
    SeriesDetail,
    StudentWithCardRow,
} from "../../types/domain";
import { ErrorState, Loading } from "../common/StateBlocks";
import { SeriesForm } from "./SeriesForm";
import type { SeriesFormValues } from "./SeriesForm";

// Sous-ensemble de la ligne de session dont le dialogue a besoin : aussi bien
// une ligne GET /sessions/calendar qu'un GET /sessions/:id (le dialogue
// n'affiche que ces champs ; la resynchronisation vient du parent).
export interface EditableSession {
    id: number;
    label: string;
    scheduled_at: string;
    duration_minutes: number;
    series_id: number | null;
    occurrence_date: string | null;
    series_label?: string | null;
}

interface SessionEditDialogProps {
    row: EditableSession;
    onChanged: () => void; // recharger l'affichage (succès comme 409)
    onDone: () => void; // fermer le dialogue
}

type Scope = "occurrence" | "series";

export function SessionEditDialog({ row, onChanged, onDone }: SessionEditDialogProps) {
    const { push } = useToast();
    const isOccurrence = row.series_id !== null && row.occurrence_date !== null;
    const [scope, setScope] = useState<Scope>("occurrence");

    const [label, setLabel] = useState(row.label);
    const [scheduledAt, setScheduledAt] = useState(toLocalInputValue(row.scheduled_at));
    const [duration, setDuration] = useState(String(row.duration_minutes));
    const [busy, setBusy] = useState(false);

    // Détails de la série (portée « et les suivantes ») chargés à la demande.
    const [series, setSeries] = useState<SeriesDetail | null>(null);
    const [seriesError, setSeriesError] = useState<unknown>(null);
    const [groups, setGroups] = useState<GroupRow[]>([]);
    const [students, setStudents] = useState<StudentWithCardRow[]>([]);

    useEffect(() => {
        if (scope !== "series" || row.series_id === null) return;
        let cancelled = false;
        setSeriesError(null);
        void (async () => {
            try {
                const [s, g, st] = await Promise.all([
                    getSeries(row.series_id!),
                    listGroups(),
                    listStudents(),
                ]);
                if (cancelled) return;
                setSeries(s);
                setGroups(g.rows);
                setStudents(st.rows);
            } catch (err) {
                if (!cancelled) setSeriesError(err);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [scope, row.series_id]);

    // Échec → toast serveur + resynchronisation : un 409 signifie presque
    // toujours que l'occurrence a démarré (ou la série changé) depuis l'ouverture.
    const fail = (err: unknown): void => {
        push("danger", toUiMessage(err));
        if (err instanceof ApiError && err.status === 409) {
            onChanged();
            onDone();
        }
    };

    const submitOccurrence = async (e: FormEvent): Promise<void> => {
        e.preventDefault();
        const trimmed = label.trim();
        if (!trimmed) return;
        setBusy(true);
        try {
            await updateSession(row.id, {
                label: trimmed,
                // UNE OCCURRENCE NE SE DÉPLACE PAS : son instant suit le créneau
                // local de la série (identité d'occurrence + clé d'idempotence de
                // génération) — le serveur refuserait (409 SESSION_OCCURRENCE_MOVE).
                // Le déplacement passe par la portée « et les suivantes ».
                ...(isOccurrence ? {} : { scheduledAt: new Date(scheduledAt).toISOString() }),
                durationMinutes: Number(duration),
            });
            push("success", "Séance mise à jour.");
            onChanged();
            onDone();
        } catch (err) {
            fail(err);
        } finally {
            setBusy(false);
        }
    };

    const submitSeries = async (values: SeriesFormValues): Promise<void> => {
        if (row.series_id === null || row.occurrence_date === null) return;
        setBusy(true);
        try {
            const result = await editSeriesFrom(row.series_id, {
                fromDate: row.occurrence_date,
                label: values.label,
                recurrence: values.recurrence,
                weekday: values.weekday,
                localTime: values.localTime,
                timezone: values.timezone,
                durationMinutes: values.durationMinutes,
                startsOn: values.startsOn,
                endsOn: values.endsOn,
                groupIds: values.groupIds,
                // Écarts individuels : remplacement de la liste ; les copies
                // héritées des futures occurrences sont resynchronisées, les
                // dérogations explicites par occurrence survivent (Phase 5).
                participants: values.participants,
            });
            const bits = [
                result.updated.length > 0 ? `${result.updated.length} déplacée(s)` : null,
                result.created.length > 0 ? `${result.created.length} créée(s)` : null,
                result.cancelled.length > 0 ? `${result.cancelled.length} annulée(s)` : null,
                result.preserved.length > 0 ? `${result.preserved.length} conservée(s)` : null,
            ].filter(Boolean);
            push(
                "success",
                bits.length > 0
                    ? `Série mise à jour — ${bits.join(", ")}.`
                    : "Série mise à jour — aucune occurrence concernée.",
            );
            onChanged();
            onDone();
        } catch (err) {
            fail(err);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div>
            {isOccurrence && (
                <fieldset className="field">
                    <legend>Portée de la modification</legend>
                    <div className="radios radios--stacked">
                        <label className="radios__item">
                            <input
                                type="radio"
                                name="edit-scope"
                                checked={scope === "occurrence"}
                                onChange={() => setScope("occurrence")}
                                disabled={busy}
                            />
                            <span>
                                <strong>Uniquement cette occurrence</strong> — le {row.occurrence_date}{" "}
                                seulement ; la série garde son patron.
                            </span>
                        </label>
                        <label className="radios__item">
                            <input
                                type="radio"
                                name="edit-scope"
                                checked={scope === "series"}
                                onChange={() => setScope("series")}
                                disabled={busy}
                            />
                            <span>
                                <strong>Cette occurrence et les suivantes</strong> — édition de la
                                série « {row.series_label ?? ""} » à partir du {row.occurrence_date}.
                            </span>
                        </label>
                    </div>
                </fieldset>
            )}

            {scope === "occurrence" ? (
                <form className="form" onSubmit={(e) => void submitOccurrence(e)}>
                    <div className="field">
                        <label htmlFor="edit-label">Libellé</label>
                        <input
                            id="edit-label"
                            value={label}
                            onChange={(e) => setLabel(e.target.value)}
                            required
                            maxLength={200}
                            autoFocus
                        />
                    </div>
                    <div className="field-row">
                        {!isOccurrence && (
                            <div className="field">
                                <label htmlFor="edit-when">Date et heure prévue</label>
                                <input
                                    id="edit-when"
                                    type="datetime-local"
                                    value={scheduledAt}
                                    onChange={(e) => setScheduledAt(e.target.value)}
                                    required
                                />
                            </div>
                        )}
                        <div className="field field--narrow">
                            <label htmlFor="edit-duration">Durée (min)</label>
                            <input
                                id="edit-duration"
                                type="number"
                                min={1}
                                max={1440}
                                value={duration}
                                onChange={(e) => setDuration(e.target.value)}
                                required
                            />
                        </div>
                    </div>
                    {isOccurrence ? (
                        <p className="field__hint">
                            Date et heure d&apos;une occurrence proviennent de sa série : seul le
                            créneau de la série peut les déplacer — choisissez pour cela la portée
                            « Cette occurrence et les suivantes ».
                        </p>
                    ) : (
                        <p className="field__hint">
                            Session autonome : le déplacement ne concerne que ce cours.
                        </p>
                    )}
                    <div className="form__actions">
                        <button type="button" className="btn" onClick={onDone} disabled={busy}>
                            Annuler
                        </button>
                        <button
                            type="submit"
                            className="btn btn--primary"
                            disabled={busy || label.trim() === ""}
                        >
                            {busy ? "Enregistrement…" : "Enregistrer"}
                        </button>
                    </div>
                </form>
            ) : seriesError !== null ? (
                <ErrorState error={seriesError} text="Impossible de charger la série." />
            ) : series === null ? (
                <Loading text="Chargement de la série…" />
            ) : (
                <SeriesForm
                    mode="edit"
                    fromDate={row.occurrence_date ?? undefined}
                    initial={series}
                    groups={groups}
                    students={students}
                    busy={busy}
                    onSubmit={(v) => void submitSeries(v)}
                    onCancel={onDone}
                />
            )}
        </div>
    );
}
