import { useMemo, useState } from "react";
import type { FormEvent } from "react";

import type { GroupRow, StudentWithCardRow } from "../../types/domain";
import { toLocalInputValue } from "../../lib/format";
import { StudentPicker } from "./StudentPicker";
import type { ParticipantDeltas } from "./StudentPicker";

export interface SessionFormValues {
    label: string;
    // Union of the checked groups — at least one group is required.
    groupIds: number[];
    // Individual inclusion/exclusion deltas on top of the groups (real
    // deviations only : inclusions outside the checked groups, exclusions
    // despite a checked group). Empty array when nothing deviates.
    participants: Array<{ studentId: number; included: boolean }>;
    scheduledAt: string;
    durationMinutes: number;
}

interface SessionFormProps {
    groups: GroupRow[];
    students: StudentWithCardRow[];
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
// (there is no longer an implicit « all students » session). On top of that
// base, INDIVIDUAL students can be selected (inclusions/exclusions — the same
// deltas a series carries) : an « included » student joins the roster without
// being in a checked group, an « excluded » one leaves it despite their group.
// Only the minimal validation the API needs is done client-side (required
// label, numeric duration, non-empty group selection); the backend stays
// authoritative and its messages are shown as-is.
export function SessionForm({
    groups,
    students,
    busy,
    submitLabel = "Créer la session",
    initialScheduledAt,
    initialDurationMinutes,
    onSubmit,
    onCancel,
}: SessionFormProps) {
    const [label, setLabel] = useState("");
    const [groupIds, setGroupIds] = useState<number[]>([]);
    const [participants, setParticipants] = useState<ParticipantDeltas>(new Map());
    const [scheduledAt, setScheduledAt] = useState(initialScheduledAt ?? toLocalInputValue(null));
    const [duration, setDuration] = useState(String(initialDurationMinutes ?? 10));

    const toggleGroup = (id: number): void => {
        setGroupIds((current) =>
            current.includes(id) ? current.filter((g) => g !== id) : [...current, id],
        );
    };

    // A student belongs to only one group: the union of the checked groups is
    // the base roster, adjusted by the individual deltas (inclusions outside,
    // exclusions despite a group).
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
            participants: [...participants.entries()].map(([studentId, included]) => ({
                studentId,
                included,
            })),
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
                        : `Liste d'appel de base : ${selectedCount} étudiant(s), ajustée par les écarts individuels ci-dessous.`}
                </p>
            </fieldset>

            <fieldset className="field">
                <legend>Participants individuels (facultatif)</legend>
                <p className="field__hint">
                    Par dérogation à l'appartenance aux groupes : un étudiant « inclus » participe sans être dans un
                    groupe coché ; un étudiant « exclu » ne participe pas malgré son groupe. Les membres des groupes
                    cochés n'ont rien à ajouter.
                </p>
                <StudentPicker
                    groups={groups}
                    students={students}
                    selectedGroupIds={groupIds}
                    value={participants}
                    onChange={setParticipants}
                />
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
