// Sélecteur de participants individuels pour une série : recherche côté
// client sur la VRAIE liste d'étudiants (GET /students), écarts d'inclusion/
// exclusion distincts de l'appartenance aux groupes cochés.
//
// Modèle : Map<studentId, included> — un étudiant ne porte qu'un seul écart
// (inclusion OU exclusion, jamais les deux : la Map déduplique), et le
// serveur applique « l'écart l'emporte sur le groupe ». Un étudiant membre
// d'un groupe coché n'a pas besoin d'inclusion (badge « membre » affiché) ;
// il peut en revanche être exclu. La sélection de groupes est passée en prop
// pour distinguer visuellement « membre du groupe » et « hors groupes ».

import { useMemo, useState } from "react";

import { fullName } from "../../lib/format";
import type { GroupRow, StudentWithCardRow } from "../../types/domain";

export type ParticipantDeltas = Map<number, boolean>;

interface StudentPickerProps {
    groups: GroupRow[];
    students: StudentWithCardRow[];
    selectedGroupIds: number[];
    value: ParticipantDeltas;
    onChange: (next: ParticipantDeltas) => void;
}

const MAX_RESULTS = 50;

// Normalisation pour la recherche : minuscules sans accents.
function norm(s: string | null): string {
    return (s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function StudentPicker({ groups, students, selectedGroupIds, value, onChange }: StudentPickerProps) {
    const [query, setQuery] = useState("");
    const [groupFilter, setGroupFilter] = useState<string>("");

    const groupNameById = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);

    const results = useMemo(() => {
        const q = norm(query.trim());
        const gid = groupFilter === "" ? null : Number(groupFilter);
        return students
            .filter((s) => (gid === null ? true : s.group_id === gid))
            .filter((s) => {
                if (q === "") return true;
                return (
                    norm(fullName(s.first_name, s.last_name)).includes(q) ||
                    norm(s.student_number).includes(q)
                );
            })
            .slice(0, MAX_RESULTS);
    }, [students, query, groupFilter]);

    const inclusions = useMemo(
        () => [...value.entries()].filter(([, included]) => included),
        [value],
    );
    const exclusions = useMemo(
        () => [...value.entries()].filter(([, included]) => !included),
        [value],
    );

    const setDelta = (studentId: number, included: boolean): void => {
        const next = new Map(value);
        // Bascule : re-cliquer la même option retire l'écart (pas de doublon).
        if (next.get(studentId) === included) next.delete(studentId);
        else next.set(studentId, included);
        onChange(next);
    };

    const remove = (studentId: number): void => {
        const next = new Map(value);
        next.delete(studentId);
        onChange(next);
    };

    const chip = (studentId: number, included: boolean) => {
        const student = students.find((s) => s.id === studentId);
        return (
            <span key={studentId} className={`delta-chip delta-chip--${included ? "in" : "out"}`}>
                {student ? fullName(student.first_name, student.last_name) : `Étudiant ${studentId}`}
                <button type="button" onClick={() => remove(studentId)} aria-label="Retirer">
                    ×
                </button>
            </span>
        );
    };

    return (
        <div className="picker">
            <div className="picker__controls">
                <input
                    className="toolbar__search"
                    type="search"
                    placeholder="Rechercher un étudiant (nom, numéro)…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    aria-label="Rechercher un étudiant"
                />
                <select
                    value={groupFilter}
                    onChange={(e) => setGroupFilter(e.target.value)}
                    aria-label="Filtrer par groupe"
                >
                    <option value="">Tous les groupes</option>
                    {groups.map((g) => (
                        <option key={g.id} value={g.id}>
                            {g.name}
                        </option>
                    ))}
                </select>
            </div>

            <ul className="picker__results">
                {results.length === 0 ? (
                    <li className="picker__empty">Aucun étudiant ne correspond à la recherche.</li>
                ) : (
                    results.map((s) => {
                        const current = value.get(s.id);
                        const member = s.group_id !== null && selectedGroupIds.includes(s.group_id);
                        return (
                            <li key={s.id} className="picker__row">
                                <span className="picker__who">
                                    <span className="picker__name">{fullName(s.first_name, s.last_name)}</span>
                                    <span className="picker__meta">
                                        {s.group_id === null ? "Sans groupe" : groupNameById.get(s.group_id) ?? `Groupe ${s.group_id}`}
                                        {s.student_number ? ` · ${s.student_number}` : ""}
                                    </span>
                                </span>
                                <span className="picker__flags">
                                    {member && <span className="picker__badge picker__badge--member">membre des groupes</span>}
                                    {!member && current !== true && (
                                        <span className="picker__badge">hors groupes</span>
                                    )}
                                </span>
                                <span className="picker__actions">
                                    {!member && (
                                        <button
                                            type="button"
                                            className={`btn btn--sm ${current === true ? "btn--primary" : ""}`}
                                            onClick={() => setDelta(s.id, true)}
                                            title="Participe sans être dans un groupe coché"
                                        >
                                            Inclure
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        className={`btn btn--sm ${current === false ? "btn--danger" : ""}`}
                                        onClick={() => setDelta(s.id, false)}
                                        title={
                                            member
                                                ? "Ne participera PAS malgré son groupe coché"
                                                : "Déjà hors des groupes cochés — l'exclusion est inutile ici"
                                        }
                                        disabled={!member && current !== false}
                                    >
                                        Exclure
                                    </button>
                                </span>
                            </li>
                        );
                    })
                )}
            </ul>

            {(inclusions.length > 0 || exclusions.length > 0) && (
                <div className="picker__selected">
                    {inclusions.length > 0 && (
                        <div className="picker__chips">
                            <span className="picker__chips-label">
                                Inclusions individuelles ({inclusions.length})
                            </span>
                            {inclusions.map(([id, inc]) => chip(id, inc))}
                        </div>
                    )}
                    {exclusions.length > 0 && (
                        <div className="picker__chips">
                            <span className="picker__chips-label">
                                Exclusions individuelles ({exclusions.length})
                            </span>
                            {exclusions.map(([id, inc]) => chip(id, inc))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
