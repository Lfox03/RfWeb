// Boîte de création d'une séance (rendue dans un Modal par l'appelant) :
// deux modes — séance PONCTUELLE (POST /api/sessions, formulaire historique
// conservé) ou SÉRIE RÉCURRENTE (POST /api/series, patron SeriesForm). Les
// groupes et les étudiants proviennent des vrais endpoints (aucune donnée de
// démo) ; la validation métier reste serveur (messages 400/409 français
// affichés tels quels via toUiMessage).

import { useEffect, useState } from "react";

import { toUiMessage } from "../../api/client";
import { listGroups } from "../../api/groups";
import { createSeries } from "../../api/series";
import { createSession } from "../../api/sessions";
import { listStudents } from "../../api/students";
import type { GroupRow, SeriesDetail, StudentWithCardRow } from "../../types/domain";
import { ErrorState, Loading } from "../common/StateBlocks";
import { SessionForm } from "./SessionForm";
import type { SessionFormValues } from "./SessionForm";
import { SeriesForm } from "./SeriesForm";
import type { SeriesFormValues } from "./SeriesForm";

interface CreateSessionDialogProps {
    initialMode?: "once" | "series";
    // Créneau choisi sur la grille (clic/glisser) : pré-remplit la date/heure
    // ponctuelle, ou la date de début + heure murale de la série.
    initialScheduledAt?: string; // « YYYY-MM-DDTHH:MM » local
    initialDurationMinutes?: number;
    onCreatedOnce: (label: string) => void;
    onCreatedSeries: (series: SeriesDetail) => void;
    onError: (message: string) => void;
    onClose: () => void;
}

export function CreateSessionDialog({
    initialMode = "once",
    initialScheduledAt,
    initialDurationMinutes,
    onCreatedOnce,
    onCreatedSeries,
    onError,
    onClose,
}: CreateSessionDialogProps) {
    const [mode, setMode] = useState<"once" | "series">(initialMode);
    const [groups, setGroups] = useState<GroupRow[] | null>(null);
    const [students, setStudents] = useState<StudentWithCardRow[] | null>(null);
    const [loadError, setLoadError] = useState<unknown>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const [g, s] = await Promise.all([listGroups(), listStudents()]);
                if (cancelled) return;
                setGroups(g.rows);
                setStudents(s.rows);
            } catch (err) {
                if (!cancelled) setLoadError(err);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const handleOnce = async (values: SessionFormValues): Promise<void> => {
        setBusy(true);
        try {
            await createSession(values);
            onCreatedOnce(values.label);
        } catch (err) {
            onError(toUiMessage(err));
        } finally {
            setBusy(false);
        }
    };

    const handleSeries = async (values: SeriesFormValues): Promise<void> => {
        setBusy(true);
        try {
            const created = await createSeries({
                ...values,
                // Aucun écart → champ omis (le serveur crée sans participants).
                participants: values.participants.length > 0 ? values.participants : undefined,
            });
            onCreatedSeries(created);
        } catch (err) {
            onError(toUiMessage(err));
        } finally {
            setBusy(false);
        }
    };

    if (loadError !== null) {
        return <ErrorState error={loadError} text="Impossible de charger les groupes ou les étudiants." />;
    }
    if (groups === null || students === null) {
        return <Loading text="Chargement des groupes et des étudiants…" />;
    }

    return (
        <>
            <div className="create-tabs" role="tablist" aria-label="Type de séance">
                <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "once"}
                    className={`create-tabs__tab ${mode === "once" ? "create-tabs__tab--active" : ""}`}
                    onClick={() => setMode("once")}
                    disabled={busy}
                >
                    Séance ponctuelle
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "series"}
                    className={`create-tabs__tab ${mode === "series" ? "create-tabs__tab--active" : ""}`}
                    onClick={() => setMode("series")}
                    disabled={busy}
                >
                    Série récurrente
                </button>
            </div>

            {mode === "once" ? (
                <SessionForm
                    groups={groups}
                    busy={busy}
                    initialScheduledAt={initialScheduledAt}
                    initialDurationMinutes={initialDurationMinutes}
                    onSubmit={(v) => void handleOnce(v)}
                    onCancel={onClose}
                />
            ) : (
                <SeriesForm
                    mode="create"
                    groups={groups}
                    students={students}
                    busy={busy}
                    initialStartsOn={initialScheduledAt?.slice(0, 10)}
                    initialLocalTime={initialScheduledAt?.slice(11, 16)}
                    initialDurationMinutes={initialDurationMinutes}
                    onSubmit={(v) => void handleSeries(v)}
                    onCancel={onClose}
                />
            )}
        </>
    );
}
