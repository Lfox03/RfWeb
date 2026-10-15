// Fiche détaillée d'une occurrence du calendrier (contenu de Modal).
//
// Lectures seules pour les séances terminées/annulées ; actions strictement
// limitées à la machine à états serveur :
//   • scheduled : Modifier (dialogue de portée) et Annuler (POST /sessions/:id/cancel) ;
//   • running   : suivi des présences sur la fiche de session (le démarrage/
//     l'arrêt restent sur cette fiche, comme le tableau de bord) ;
//   • occurrence de série : métadonnées du patron + pause/reprise
//     (POST /series/:id/pause|resume) et annulation de la série À PARTIR DE
//     CETTE OCCURRENCE (POST /series/:id/cancel { from: occurrence_date }).
// Chaque 409 (course perdue contre le scheduler, série déjà annulée…) est
// affiché tel quel puis provoque une resynchronisation du calendrier.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { toUiMessage } from "../../api/client";
import { cancelSeries, getSeries, pauseSeries, resumeSeries } from "../../api/series";
import { cancelSession } from "../../api/sessions";
import { useToast } from "../../hooks/useToast";
import { WEEKDAY_LABELS_FR } from "../../lib/calendar";
import { formatMinutes } from "../../lib/calendar";
import { SESSION_STATUS_LABEL } from "../../lib/format";
import type { CalendarSessionRow, SeriesDetail } from "../../types/domain";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { StatusBadge } from "../common/StatusBadge";

interface SessionDetailsDialogProps {
    row: CalendarSessionRow;
    onChanged: () => void; // recharger le calendrier
    onEdit: (row: CalendarSessionRow) => void;
    onClose: () => void;
}

export function SessionDetailsDialog({ row, onChanged, onEdit, onClose }: SessionDetailsDialogProps) {
    const { push } = useToast();
    const [busy, setBusy] = useState<string | null>(null);
    const [confirming, setConfirming] = useState<"occurrence" | "series" | null>(null);
    const [series, setSeries] = useState<SeriesDetail | null>(null);

    useEffect(() => {
        if (row.series_id === null) return;
        let cancelled = false;
        getSeries(row.series_id)
            .then((s) => !cancelled && setSeries(s))
            .catch((err) => console.debug("[CAL] Série introuvable :", err));
        return () => {
            cancelled = true;
        };
    }, [row.series_id]);

    // Un échec (409…) repose l'état réel : le calendrier est peut-être périmé.
    const run = async <T,>(key: string, action: () => Promise<T>, done: (result: T) => void): Promise<void> => {
        setBusy(key);
        try {
            const result = await action();
            done(result);
        } catch (err) {
            push("danger", toUiMessage(err));
            onChanged();
        } finally {
            setBusy(null);
        }
    };

    const times = scheduleLabel(row);
    const readOnly = row.status === "completed" || row.status === "cancelled";

    return (
        <div className="cal-details">
            <div className="cal-details__head">
                <div>
                    <h3>{row.label}</h3>
                    <p className="page__subtitle">
                        {times} · {row.duration_minutes} min
                    </p>
                </div>
                <StatusBadge status={row.status} />
            </div>

            <dl className="cal-details__facts">
                <dt>Groupes</dt>
                <dd>{row.group_name ?? "Aucun groupe"}</dd>
                <dt>Participants attendus</dt>
                <dd>{row.participant_count}</dd>
                <dt>Fuseau</dt>
                <dd>{row.timezone}</dd>
                {row.series_id !== null && (
                    <>
                        <dt>Série</dt>
                        <dd>
                            {row.series_label ?? `#${row.series_id}`} —{" "}
                            {series
                                ? describePattern(series)
                                : row.series_recurrence === "daily"
                                  ? "chaque jour"
                                  : "chaque semaine"}
                        </dd>
                    </>
                )}
            </dl>

            {readOnly && (
                <p className="dialog-note">
                    Séance {SESSION_STATUS_LABEL[row.status].toLowerCase()} — lecture seule (les
                    présences restent consultables sur sa fiche).
                </p>
            )}

            <div className="controls">
                <Link className="btn" to={`/sessions/${row.id}`}>
                    Ouvrir la fiche {row.status === "running" ? "et suivre les présences" : ""}
                </Link>
                {row.status === "scheduled" && (
                    <>
                        <button className="btn btn--primary" onClick={() => onEdit(row)} disabled={busy !== null}>
                            Modifier
                        </button>
                        <button
                            className="btn btn--ghost"
                            onClick={() => setConfirming("occurrence")}
                            disabled={busy !== null}
                        >
                            {busy === "cancel-occ" ? "Annulation…" : "Annuler la séance"}
                        </button>
                    </>
                )}
            </div>

            {row.series_id !== null && series && series.status !== "cancelled" && (
                <div className="cal-details__series">
                    <p className="cal-details__series-title">
                        Actions sur la série (depuis cette occurrence du {row.occurrence_date})
                    </p>
                    <div className="controls">
                        {series.status === "active" ? (
                            <button
                                className="btn"
                                disabled={busy !== null}
                                onClick={() =>
                                    void run(
                                        "pause",
                                        () => pauseSeries(row.series_id!),
                                        () => {
                                            push("info", "Série en pause — plus aucune occurrence ne sera planifiée.");
                                            onChanged();
                                            onClose();
                                        },
                                    )
                                }
                            >
                                {busy === "pause" ? "Pause…" : "Mettre la série en pause"}
                            </button>
                        ) : (
                            <button
                                className="btn"
                                disabled={busy !== null}
                                onClick={() =>
                                    void run(
                                        "resume",
                                        () => resumeSeries(row.series_id!),
                                        () => {
                                            push("success", "Série reprise — la planification reprend.");
                                            onChanged();
                                            onClose();
                                        },
                                    )
                                }
                            >
                                {busy === "resume" ? "Reprise…" : "Reprendre la série"}
                            </button>
                        )}
                        <button
                            className="btn btn--danger"
                            disabled={busy !== null}
                            onClick={() => setConfirming("series")}
                        >
                            Annuler la série…
                        </button>
                    </div>
                </div>
            )}
            {series?.status === "cancelled" && (
                <p className="dialog-note">Cette série est annulée — les séances passées restent consultables.</p>
            )}

            {confirming === "occurrence" && (
                <ConfirmDialog
                    title="Annuler cette séance"
                    message={`« ${row.label} » du ${row.occurrence_date ?? ""} sera annulée. Les séances des autres jours ne sont pas affectées.`}
                    confirmLabel="Annuler la séance"
                    danger
                    busy={busy === "cancel-occ"}
                    onConfirm={() =>
                        void run(
                            "cancel-occ",
                            () => cancelSession(row.id),
                            () => {
                                setConfirming(null);
                                push("success", "Séance annulée.");
                                onChanged();
                                onClose();
                            },
                        )
                    }
                    onCancel={() => setConfirming(null)}
                />
            )}
            {confirming === "series" && row.occurrence_date !== null && (
                <ConfirmDialog
                    title="Annuler la série"
                    message={`La série sera arrêtée et TOUTES ses séances encore planifiées à partir du ${row.occurrence_date} seront annulées. Les séances passées (présences comprises) sont conservées. Cette action est définitive.`}
                    confirmLabel="Annuler la série"
                    danger
                    busy={busy === "cancel-series"}
                    onConfirm={() =>
                        void run(
                            "cancel-series",
                            () => cancelSeries(row.series_id!, row.occurrence_date ?? undefined),
                            (result) => {
                                setConfirming(null);
                                push(
                                    "success",
                                    `Série annulée — ${result.cancelled.length} séance(s) encore planifiée(s) annulée(s).`,
                                );
                                onChanged();
                                onClose();
                            },
                        )
                    }
                    onCancel={() => setConfirming(null)}
                />
            )}
        </div>
    );
}

// Petit helper d'affichage — jamais requis par le serveur.
function scheduleLabel(row: CalendarSessionRow): string {
    const date = row.occurrence_date ?? row.scheduled_at.slice(0, 10);
    if (row.occurrence_date !== null && row.local_time !== null) {
        return `${date} · ${row.local_time} (heure locale, ${row.timezone})`;
    }
    const d = new Date(row.scheduled_at);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return `${date} · ${hhmm}`;
}

function describePattern(s: SeriesDetail): string {
    const when =
        s.recurrence === "daily"
            ? "chaque jour"
            : `chaque ${WEEKDAY_LABELS_FR[s.weekday ?? 0].toLowerCase()}`;
    return `${when} à ${formatMinutes(toMinutes(s.local_time))} (${s.timezone}), du ${s.starts_on}${
        s.ends_on ? ` au ${s.ends_on}` : ""
    }`;
}

function toMinutes(hhmm: string): number {
    const [h, m] = hhmm.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
}
