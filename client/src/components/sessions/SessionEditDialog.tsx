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
//
// Sélection individuelle de participants : l'éditeur est exposé par la
// portée « uniquement cette séance », y compris pour une OCCURRENCE de série
// (dérogation par occurrence). La liste est pré-remplie depuis
// GET /api/sessions/:id — pour une occurrence, cela inclut les écarts
// HÉRITÉS de la série — et PATCH REMPLACE toute la liste : enregistrer une
// modification matérialise donc les écarts de cette occurrence en lignes
// explicites (inherited = 0), que les futures éditions de la série ne
// resynchroniseront plus (les dérogations par occurrence survivent, Phase 5).
// Pour ne pas figer une occurrence PAR INADVERTANCE, « participants » n'est
// envoyé que si la sélection a réellement changé depuis l'ouverture : sans
// envoi, les copies héritées restent héritées.

import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { ApiError, toUiMessage } from "../../api/client";
import { listGroups } from "../../api/groups";
import { editSeriesFrom, getSeries } from "../../api/series";
import { getSession, updateSession } from "../../api/sessions";
import { listStudents } from "../../api/students";
import { useToast } from "../../hooks/useToast";
import { toLocalInputValue } from "../../lib/format";
import type {
    GroupRow,
    SeriesDetail,
    SessionDetail,
    StudentWithCardRow,
} from "../../types/domain";
import { ErrorState, Loading } from "../common/StateBlocks";
import { SeriesForm } from "./SeriesForm";
import type { SeriesFormValues } from "./SeriesForm";
import { StudentPicker } from "./StudentPicker";
import type { ParticipantDeltas } from "./StudentPicker";

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

// Signature stable d'une sélection : l'ordre d'ajout dans la Map n'a aucun
// sens, on trie par identifiant d'étudiant. Sert à ne remplacer les écarts
// que sur modification réelle (voir l'en-tête du fichier).
function deltasSignature(map: ParticipantDeltas): string {
    return JSON.stringify([...map.entries()].sort((a, b) => a[0] - b[0]));
}

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

    // Sélection individuelle (portée « uniquement cette séance », autonome
    // COMME occurrence) : le détail courant (groupes + écarts, héritages
    // inclus) pré-remplit l'éditeur ; l'envoi ne remplace la liste que si
    // l'utilisateur a réellement touché à la sélection.
    const [detail, setDetail] = useState<SessionDetail | null>(null);
    const [detailError, setDetailError] = useState<unknown>(null);
    const [participants, setParticipants] = useState<ParticipantDeltas>(new Map());
    const [initialSignature, setInitialSignature] = useState("");

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

    // Écarts courants + étudiants + groupes : chargés une seule fois, pour
    // une séance autonome comme pour une occurrence de série. L'éditeur
    // (et l'envoi) reste désactivé tant que le détail n'est pas là, pour
    // qu'une sauvegarde prématurée n'écrase pas la liste des écarts.
    useEffect(() => {
        let cancelled = false;
        setDetailError(null);
        void (async () => {
            try {
                const [s, st, g] = await Promise.all([
                    getSession(row.id),
                    listStudents(),
                    listGroups(),
                ]);
                if (cancelled) return;
                setDetail(s);
                setStudents(st.rows);
                setGroups(g.rows);
                const map: ParticipantDeltas = new Map();
                for (const p of s.participants) map.set(p.student_id, p.included === 1);
                setParticipants(map);
                setInitialSignature(deltasSignature(map));
            } catch (err) {
                if (!cancelled) setDetailError(err);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [row.id]);

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
        // Le détail des écarts doit être chargé avant d'envoyer (sinon on
        // écraserait toute la liste des écarts par vide).
        if (detail === null) return;
        setBusy(true);
        const touched = deltasSignature(participants) !== initialSignature;
        try {
            await updateSession(row.id, {
                label: trimmed,
                // UNE OCCURRENCE NE SE DÉPLACE PAS : son instant suit le créneau
                // local de la série (identité d'occurrence + clé d'idempotence de
                // génération) — le serveur refuserait (409 SESSION_OCCURRENCE_MOVE).
                // Le déplacement passe par la portée « et les suivantes ».
                ...(isOccurrence ? {} : { scheduledAt: new Date(scheduledAt).toISOString() }),
                durationMinutes: Number(duration),
                // Écarts individuels : REMPLACEMENT de toute la liste (le serveur
                // ne fusionne pas). Envoyé UNIQUEMENT si la sélection a changé :
                // sur une occurrence de série, un envoi fige les héritages en
                // dérogations explicites — un simple clic sur « Enregistrer » sans
                // rien changer ne doit pas avoir cet effet.
                ...(touched
                    ? {
                          participants: [...participants.entries()].map(([studentId, included]) => ({
                              studentId,
                              included,
                          })),
                      }
                    : {}),
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

                    <fieldset className="field">
                        <legend>Participants individuels</legend>
                        <p className="field__hint">
                            Par dérogation à l&apos;appartenance aux groupes : un étudiant « inclus »
                            participe sans être dans un groupe de la séance ; un étudiant « exclu »
                            n&apos;y participe pas malgré son groupe.
                            {isOccurrence ? (
                                <>
                                    {" "}
                                    La liste affichée inclut les écarts hérités de la série :
                                    enregistrer une modification remplace toute la liste de{" "}
                                    <strong>cette occurrence</strong> et la rend explicite — les
                                    prochaines éditions de la série ne changeront plus ces élèves.
                                    Pour toute la série, choisissez « Cette occurrence et les
                                    suivantes ».
                                </>
                            ) : (
                                <> Enregistrer remplace la liste complète des écarts de cette séance.</>
                            )}
                        </p>
                        {detailError !== null ? (
                            <ErrorState
                                error={detailError}
                                text="Impossible de charger les participants de la séance."
                            />
                        ) : detail === null ? (
                            <Loading text="Chargement des participants…" />
                        ) : (
                            <StudentPicker
                                groups={groups}
                                students={students}
                                selectedGroupIds={detail.group_ids}
                                value={participants}
                                onChange={setParticipants}
                            />
                        )}
                    </fieldset>

                    <div className="form__actions">
                        <button type="button" className="btn" onClick={onDone} disabled={busy}>
                            Annuler
                        </button>
                        <button
                            type="submit"
                            className="btn btn--primary"
                            disabled={
                                busy ||
                                label.trim() === "" ||
                                detailError !== null ||
                                detail === null
                            }
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
