import { useMemo, useState } from "react";
import type { FormEvent } from "react";

import type { GroupRow } from "../../types/domain";
import { toLocalInputValue } from "../../lib/format";

export interface SessionFormValues {
    label: string;
    // Union of the checked groups — at least one group is required.
    groupIds: number[];
    scheduledAt: string;
    durationMinutes: number;
}

interface SessionFormProps {
    groups: GroupRow[];
    busy?: boolean;
    submitLabel?: string;
    // Pre-filled slot chosen by click/drag on the calendar grid:
    // « YYYY-MM-DDTHH:MM » local plus the dragged duration in minutes.
    initialScheduledAt?: string;
    initialDurationMinutes?: number;
    onSubmit: (values: SessionFormValues) => void;
    onCancel: () => void;
}

// Create-session form. A session covers ONE OR SEVERAL groups (a shared
// lesson): the roster is the union of the checked groups, hence a checkbox
// list rather than a single select — and at least one group must be checked
// (there is no longer an implicit « all students » session). Only the minimal
// validation the API needs is done client-side (required label, numeric
// duration, non-empty group selection); the backend stays authoritative and
// its messages are shown as-is.
export function SessionForm({
    groups,
    busy,
    submitLabel = "Créer la session",
    initialScheduledAt,
    initialDurationMinutes,
    onSubmit,
    onCancel,
}: SessionFormProps) {
    const [label, setLabel] = useState("");
    const [groupIds, setGroupIds] = useState<number[]>([]);
    const [scheduledAt, setScheduledAt] = useState(initialScheduledAt ?? toLocalInputValue(null));
    const [duration, setDuration] = useState(String(initialDurationMinutes ?? 10));

    const toggleGroup = (id: number): void => {
        setGroupIds((current) =>
            current.includes(id) ? current.filter((g) => g !== id) : [...current, id],
        );
    };

    // A student belongs to only one group: the sum of the checked groups'
    // headcounts is exactly the roster size.
    const selectedCount = useMemo(
        () => groupIds.reduce((sum, id) => sum + (groups.find((g) => g.id === id)?.student_count ?? 0), 0),
        [groupIds, groups],
    );

    const handleSubmit = (e: FormEvent): void => {
        e.preventDefault();
        const trimmed = label.trim();
        if (!trimmed || groupIds.length === 0) return;
        onSubmit({
            label: trimmed,
            groupIds,
            scheduledAt: new Date(scheduledAt).toISOString(),
            durationMinutes: Number(duration) || 10,
        });
    };

    return (
        <form className="form" onSubmit={handleSubmit}>
            <div className="field">
                <label htmlFor="session-label">Libellé</label>
                <input
                    id="session-label"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    required
                    maxLength={200}
                    autoFocus
                    placeholder="Ex. Cours de 8 h — G1 + G2"
                />
            </div>

            <fieldset className="field">
                <legend>Groupes</legend>
                {groups.length === 0 ? (
                    <p className="field__hint">
                        Aucun groupe n'existe encore — créez d'abord un groupe pour pouvoir créer une session.
                    </p>
                ) : (
                    <div className="checklist">
                        {groups.map((g) => (
                            <label key={g.id} className="checklist__item">
                                <input
                                    type="checkbox"
                                    checked={groupIds.includes(g.id)}
                                    onChange={() => toggleGroup(g.id)}
                                />
                                <span>
                                    {g.name}
                                    {g.student_count !== undefined && (
                                        <span className="checklist__count"> · {g.student_count} étudiant(s)</span>
                                    )}
                                </span>
                            </label>
                        ))}
                    </div>
                )}
                <p className="field__hint">
                    {groupIds.length === 0
                        ? "Sélectionnez au moins un groupe"
                        : `Liste d'appel : ${selectedCount} étudiant(s) au total.`}
                </p>
            </fieldset>

            <div className="field-row">
                <div className="field">
                    <label htmlFor="session-scheduled">Date et heure prévue</label>
                    <input
                        id="session-scheduled"
                        type="datetime-local"
                        value={scheduledAt}
                        onChange={(e) => setScheduledAt(e.target.value)}
                        required
                    />
                </div>
                <div className="field field--narrow">
                    <label htmlFor="session-duration">Durée (min)</label>
                    <input
                        id="session-duration"
                        type="number"
                        min={1}
                        max={1440}
                        value={duration}
                        onChange={(e) => setDuration(e.target.value)}
                        required
                    />
                </div>
            </div>

            <div className="form__actions">
                <button type="button" className="btn" onClick={onCancel} disabled={busy}>
                    Annuler
                </button>
                <button
                    type="submit"
                    className="btn btn--primary"
                    disabled={busy || !label.trim() || groupIds.length === 0}
                >
                    {submitLabel}
                </button>
            </div>
        </form>
    );
}
