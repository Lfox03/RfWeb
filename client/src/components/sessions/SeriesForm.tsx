// Formulaire d'un modèle récurrent (série) — création ET édition « à partir
// de cette occurrence ». Champs strictement limités à ce que l'API accepte
// (seriesRouter) : libellé, récurrence daily|weekly + SEUL jour de semaine
// (le serveur n'accepte qu'un weekday 0-6, pas de liste de jours — limite
// documentée, jamais contournée côté client), heure locale HH:MM, fuseau
// IANA, durée, dates inclusives starts_on/ends_on, groupes et écarts
// individuels (création comme édition — Phase 5 : à l'édition, la liste est
// remplacée et les copies héritées des futures occurrences « programmées »
// sont resynchronisées, les dérogations explicites par occurrence survivent).
// Le serveur reste seul juge : il renvoie 400/409 dont les messages français
// sont affichés tels quels.

import { useMemo, useState } from "react";
import type { FormEvent } from "react";

import { StudentPicker } from "./StudentPicker";
import type { ParticipantDeltas } from "./StudentPicker";
import { localDateKey, WEEKDAY_LABELS_FR } from "../../lib/calendar";
import { browserTimezone, timezoneOptions } from "../../lib/timezones";
import type {
    GroupRow,
    SeriesDetail,
    StudentWithCardRow,
} from "../../types/domain";

export interface SeriesFormValues {
    label: string;
    recurrence: "daily" | "weekly";
    weekday: number | null;
    localTime: string;
    timezone: string;
    durationMinutes: number;
    startsOn: string;
    endsOn: string | null;
    groupIds: number[];
    participants: Array<{ studentId: number; included: boolean }>;
}

interface SeriesFormProps {
    mode: "create" | "edit";
    // Édition : date d'occurrence ancre (« à partir de »), envoyée en fromDate.
    fromDate?: string;
    initial?: SeriesDetail;
    // Création : créneau choisi sur la grille (clic/glisser) — pré-remplit la
    // date de début, l'heure murale et la durée quand il n'y a pas d'initial.
    initialStartsOn?: string;
    initialLocalTime?: string;
    initialDurationMinutes?: number;
    groups: GroupRow[];
    students: StudentWithCardRow[];
    busy?: boolean;
    submitLabel?: string;
    onSubmit: (values: SeriesFormValues) => void;
    onCancel: () => void;
}

export function SeriesForm({
    mode,
    fromDate,
    initial,
    initialStartsOn,
    initialLocalTime,
    initialDurationMinutes,
    groups,
    students,
    busy,
    submitLabel,
    onSubmit,
    onCancel,
}: SeriesFormProps) {
    const today = useMemo(() => localDateKey(new Date()), []);
    // En édition, c'est le modèle existant qui prime ; le créneau pré-choisi
    // ne s'applique qu'à la création.
    const startsInitial = initial?.starts_on ?? initialStartsOn ?? today;
    const localTimeInitial = initial?.local_time ?? initialLocalTime ?? "08:00";

    const [label, setLabel] = useState(initial?.label ?? "");
    const [recurrence, setRecurrence] = useState<"daily" | "weekly">(initial?.recurrence ?? "weekly");
    const [weekday, setWeekday] = useState<number | null>(
        initial ? initial.weekday : dayOfWeekOf(startsInitial),
    );
    const [startsOn, setStartsOn] = useState(startsInitial);
    const [endsOn, setEndsOn] = useState(initial?.ends_on ?? "");
    const [localTime, setLocalTime] = useState(localTimeInitial);
    const [timezone, setTimezone] = useState(initial?.timezone ?? browserTimezone());
    const [duration, setDuration] = useState(String(initial?.duration_minutes ?? initialDurationMinutes ?? 60));
    const [groupIds, setGroupIds] = useState<number[]>(initial?.group_ids ?? []);
    const [participants, setParticipants] = useState<ParticipantDeltas>(() => {
        const map: ParticipantDeltas = new Map();
        for (const p of initial?.participants ?? []) map.set(p.student_id, p.included === 1);
        return map;
    });

    const toggleGroup = (id: number): void => {
        setGroupIds((current) =>
            current.includes(id) ? current.filter((g) => g !== id) : [...current, id],
        );
    };

    // Changer la date de début re-sélectionne le jour de semaine, tant que
    // l'utilisateur n'a pas choisi de jour manuellement différent.
    const handleStartsOn = (value: string): void => {
        setStartsOn(value);
        if (recurrence === "weekly" && (weekday === null || weekday === dayOfWeekOf(startsOn))) {
            setWeekday(dayOfWeekOf(value));
        }
    };

    const handleRecurrence = (next: "daily" | "weekly"): void => {
        setRecurrence(next);
        if (next === "weekly" && weekday === null) setWeekday(dayOfWeekOf(startsOn));
    };

    const invalidRange = endsOn !== "" && endsOn < startsOn;
    const canSubmit =
        label.trim() !== "" &&
        startsOn !== "" &&
        groupIds.length > 0 &&
        !invalidRange &&
        Number(duration) >= 1 &&
        Number(duration) <= 1440;

    const handleSubmit = (e: FormEvent): void => {
        e.preventDefault();
        if (!canSubmit) return;
        // « participants » : la liste complète des écarts (le serveur remplace
        // la liste en édition — les copies héritées des futures occurrences
        // sont resynchronisées, les dérogations explicites par occurrence
        // survivent ; en création elle initialise simplement la série).
        onSubmit({
            label: label.trim(),
            recurrence,
            weekday: recurrence === "weekly" ? weekday ?? dayOfWeekOf(startsOn) : null,
            localTime,
            timezone,
            durationMinutes: Number(duration),
            startsOn,
            endsOn: endsOn === "" ? null : endsOn,
            groupIds,
            participants: [...participants.entries()].map(([studentId, included]) => ({
                studentId,
                included,
            })),
        });
    };

    return (
        <form className="form" onSubmit={handleSubmit}>
            {mode === "edit" && fromDate && (
                <p className="dialog-note">
                    Édition « à partir du {fromDate} » : les séances déjà passées, en cours ou
                    terminées ne sont pas modifiées ; seules les occurrences planifiées à partir de
                    cette date sont déplacées, annulées ou créées.
                </p>
            )}

            <div className="field">
                <label htmlFor="series-label">Libellé</label>
                <input
                    id="series-label"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    required
                    maxLength={200}
                    autoFocus
                    placeholder="Ex. Algorithmique — lundi 8 h"
                />
            </div>

            <fieldset className="field">
                <legend>Récurrence</legend>
                <div className="radios">
                    <label className="radios__item">
                        <input
                            type="radio"
                            name="series-recurrence"
                            checked={recurrence === "weekly"}
                            onChange={() => handleRecurrence("weekly")}
                        />
                        <span>Chaque semaine</span>
                    </label>
                    <label className="radios__item">
                        <input
                            type="radio"
                            name="series-recurrence"
                            checked={recurrence === "daily"}
                            onChange={() => handleRecurrence("daily")}
                        />
                        <span>Chaque jour</span>
                    </label>
                </div>
                {recurrence === "weekly" && (
                    <div className="field field--narrow">
                        <label htmlFor="series-weekday">Jour</label>
                        <select
                            id="series-weekday"
                            value={weekday ?? 1}
                            onChange={(e) => setWeekday(Number(e.target.value))}
                        >
                            {WEEKDAY_LABELS_FR.map((name, idx) => (
                                <option key={idx} value={idx}>
                                    {name}
                                </option>
                            ))}
                        </select>
                        <p className="field__hint">Un seul jour par série (patron hebdomadaire du serveur).</p>
                    </div>
                )}
                <p className="field__hint">
                    Les cours sont planifiés d'avance sur l'horizon du serveur (≈ 12 semaines) ;
                    les nouvelles occurrences apparaissent automatiquement dans le calendrier.
                </p>
            </fieldset>

            <div className="field-row">
                <div className="field">
                    <label htmlFor="series-starts">Débute le</label>
                    <input
                        id="series-starts"
                        type="date"
                        value={startsOn}
                        onChange={(e) => handleStartsOn(e.target.value)}
                        required
                    />
                </div>
                <div className="field">
                    <label htmlFor="series-ends">Se termine le (optionnel)</label>
                    <input
                        id="series-ends"
                        type="date"
                        value={endsOn}
                        min={startsOn}
                        onChange={(e) => setEndsOn(e.target.value)}
                    />
                </div>
            </div>
            {invalidRange && (
                <p className="form-error" role="alert">
                    La date de fin ne peut pas précéder la date de début.
                </p>
            )}

            <div className="field-row">
                <div className="field field--narrow">
                    <label htmlFor="series-time">Heure locale</label>
                    <input
                        id="series-time"
                        type="time"
                        value={localTime}
                        onChange={(e) => setLocalTime(e.target.value)}
                        required
                    />
                </div>
                <div className="field">
                    <label htmlFor="series-tz">Fuseau horaire</label>
                    <select id="series-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                        {timezoneOptions().map((tz) => (
                            <option key={tz} value={tz}>
                                {tz}
                            </option>
                        ))}
                    </select>
                </div>
                <div className="field field--narrow">
                    <label htmlFor="series-duration">Durée (min)</label>
                    <input
                        id="series-duration"
                        type="number"
                        min={1}
                        max={1440}
                        value={duration}
                        onChange={(e) => setDuration(e.target.value)}
                        required
                    />
                </div>
            </div>
            <p className="field__hint">
                L'heure est l'heure murale du cours dans ce fuseau : elle reste la même à travers
                les changements d'heure été/hiver (c'est l'instant UTC qui s'adapte).
            </p>

            <fieldset className="field">
                <legend>Groupes</legend>
                {groups.length === 0 ? (
                    <p className="field__hint">
                        Aucun groupe n'existe encore — créez d'abord un groupe pour pouvoir créer
                        une série.
                    </p>
                ) : (
                    <div className="checklist">
                        {groups.map((g) => (
                            <label key={g.id} className="checklist__item">
                                <input type="checkbox" checked={groupIds.includes(g.id)} onChange={() => toggleGroup(g.id)} />
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
                    {groupIds.length === 0 ? "Sélectionnez au moins un groupe." : "La liste d'appel est l'union des groupes cochés, ajustée par les écarts individuels ci-dessous."}
                </p>
            </fieldset>

            <fieldset className="field">
                <legend>Participants individuels (facultatif)</legend>
                <p className="field__hint">
                    Par dérogation à l'appartenance aux groupes : un étudiant « inclus » participe
                    sans être dans un groupe coché ; un étudiant « exclu » ne participe pas
                    malgré son groupe. Les membres des groupes cochés n'ont rien à ajouter.
                    {mode === "edit" && (
                        <> En édition, cette liste remplace celle de la série : les futures
                        occurrences « programmées » suivront ces écarts, sauf dérogation
                        explicite déjà enregistrée sur une occurrence.</>
                    )}
                </p>
                <StudentPicker
                    groups={groups}
                    students={students}
                    selectedGroupIds={groupIds}
                    value={participants}
                    onChange={setParticipants}
                />
            </fieldset>

            <div className="form__actions">
                <button type="button" className="btn" onClick={onCancel} disabled={busy}>
                    Annuler
                </button>
                <button type="submit" className="btn btn--primary" disabled={busy || !canSubmit}>
                    {submitLabel ?? (mode === "create" ? "Créer la série" : "Appliquer à partir de cette date")}
                </button>
            </div>
        </form>
    );
}

// Jour de semaine JS (0 = dimanche) de la date locale « YYYY-MM-DD ».
function dayOfWeekOf(dateKey: string): number {
    const [y, m, d] = dateKey.split("-").map(Number);
    return new Date(y, m - 1, d).getDay();
}
