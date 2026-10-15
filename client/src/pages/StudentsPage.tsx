import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { toUiMessage } from "../api/client";
import { listGroups } from "../api/groups";
import {
    createStudent,
    deleteStudent,
    listStudents,
    updateStudent,
} from "../api/students";
import type { StudentInput } from "../api/students";
import { useWebSocket } from "../hooks/useWebSocket";
import { useToast } from "../hooks/useToast";
import { useSortState } from "../hooks/useSort";
import { usePagination } from "../hooks/usePagination";
import { sortRows } from "../lib/sort";
import { fullName } from "../lib/format";
import type { CardWithStudentRow, GroupRow, StudentWithCardRow } from "../types/domain";
import { EmptyState, ErrorState, Loading } from "../components/common/StateBlocks";
import { Modal } from "../components/common/Modal";
import { ConfirmDialog } from "../components/common/ConfirmDialog";
import { SortHeader } from "../components/common/SortHeader";
import { PaginationBar } from "../components/common/PaginationBar";
import { StudentForm } from "../components/students/StudentForm";
import { AssignCardDialog } from "../components/students/AssignCardDialog";
import { ImportStudentsDialog } from "../components/students/ImportStudentsDialog";

type Dialog =
    | { kind: "create" }
    | { kind: "edit"; student: StudentWithCardRow }
    | { kind: "card"; student: StudentWithCardRow }
    | { kind: "delete"; student: StudentWithCardRow }
    | { kind: "import" }
    | null;

type StudentSortKey = "first_name" | "last_name" | "student_number" | "group" | "card_uid" | "email";

export function StudentsPage() {
    const { epoch } = useWebSocket();
    const { push } = useToast();
    const { spec, toggle } = useSortState<StudentSortKey>();

    const [students, setStudents] = useState<StudentWithCardRow[] | null>(null);
    const [groups, setGroups] = useState<GroupRow[]>([]);
    const [error, setError] = useState<unknown>(null);
    const [query, setQuery] = useState("");
    const [groupFilter, setGroupFilter] = useState<string>("");
    const [dialog, setDialog] = useState<Dialog>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback((): void => {
        setError(null);
        Promise.all([listStudents(), listGroups()])
            .then(([st, gr]) => {
                setStudents(st.rows);
                setGroups(gr.rows);
            })
            .catch((err) => setError(err));
    }, []);

    useEffect(load, [load, epoch]);

    const groupName = useCallback(
        (id: number | null): string => (id === null ? "—" : groups.find((g) => g.id === id)?.name ?? `Groupe ${id}`),
        [groups],
    );

    const filtered = useMemo(() => {
        const list = students ?? [];
        const q = query.trim().toLowerCase();
        return list.filter((s) => {
            if (groupFilter !== "" && s.group_id !== Number(groupFilter)) return false;
            if (!q) return true;
            return [fullName(s.first_name, s.last_name), s.student_number ?? "", s.email ?? "", s.card_uid ?? ""]
                .join(" ")
                .toLowerCase()
                .includes(q);
        });
    }, [students, query, groupFilter]);

    // Header click: ascending → descending → default sort.
    const sorted = useMemo(
        () =>
            sortRows(filtered, spec, {
                first_name: (s) => s.first_name,
                last_name: (s) => s.last_name,
                student_number: (s) => s.student_number,
                group: (s) => (s.group_id === null ? null : groupName(s.group_id)),
                card_uid: (s) => s.card_uid,
                email: (s) => s.email,
            }),
        [filtered, spec, groupName],
    );

    const pagination = usePagination(sorted.length);
    const visibleRows = pagination.slice(sorted);

    const submitForm = async (values: StudentInput): Promise<void> => {
        setBusy(true);
        try {
            if (dialog?.kind === "edit") {
                await updateStudent(dialog.student.id, values);
                push("success", "Étudiant mis à jour.");
            } else {
                await createStudent(values);
                push("success", "Étudiant créé.");
            }
            setDialog(null);
            load();
        } catch (err) {
            push("danger", toUiMessage(err));
        } finally {
            setBusy(false);
        }
    };

    const confirmDelete = async (): Promise<void> => {
        if (dialog?.kind !== "delete") return;
        setBusy(true);
        try {
            await deleteStudent(dialog.student.id);
            push("success", "Étudiant supprimé.");
            setDialog(null);
            load();
        } catch (err) {
            push("danger", toUiMessage(err));
        } finally {
            setBusy(false);
        }
    };

    const onCardAssigned = (_card: CardWithStudentRow): void => {
        load();
    };

    return (
        <div className="page">
            <div className="page__header">
                <h1>Étudiants</h1>
                <div className="page__header-side">
                    <button className="btn" onClick={() => setDialog({ kind: "import" })}>
                        Importer CSV
                    </button>
                    <button className="btn btn--primary" onClick={() => setDialog({ kind: "create" })}>
                        Nouvel étudiant
                    </button>
                </div>
            </div>

            <div className="toolbar">
                <input
                    className="toolbar__search"
                    type="search"
                    placeholder="Rechercher (nom, numéro, carte…)"
                    value={query}
                    onChange={(e) => {
                        setQuery(e.target.value);
                        pagination.reset();
                    }}
                    aria-label="Rechercher un étudiant"
                />
                <select
                    value={groupFilter}
                    onChange={(e) => {
                        setGroupFilter(e.target.value);
                        pagination.reset();
                    }}
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

            {error !== null ? (
                <ErrorState error={error} onRetry={load} text="Impossible de charger les étudiants." />
            ) : students === null ? (
                <Loading text="Chargement des étudiants…" />
            ) : students.length === 0 ? (
                <EmptyState text="Aucun étudiant enregistré." />
            ) : filtered.length === 0 ? (
                <EmptyState text="Aucun résultat pour cette recherche." />
            ) : (
                <>
                    <table className="table">
                        <thead>
                            <tr>
                                <SortHeader label="Prénom" sortKey="first_name" spec={spec} onSort={toggle} />
                                <SortHeader label="Nom" sortKey="last_name" spec={spec} onSort={toggle} />
                                <SortHeader label="Numéro" sortKey="student_number" spec={spec} onSort={toggle} />
                                <SortHeader label="Groupe" sortKey="group" spec={spec} onSort={toggle} />
                                <SortHeader label="Carte" sortKey="card_uid" spec={spec} onSort={toggle} />
                                <SortHeader label="E-mail" sortKey="email" spec={spec} onSort={toggle} />
                                <th className="table__actions-col">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {visibleRows.map((s) => (
                                <tr key={s.id}>
                                    <td>
                                        <Link to={`/students/${s.id}`} className="table__link">
                                            {s.first_name}
                                        </Link>
                                    </td>
                                    <td>
                                        <Link to={`/students/${s.id}`} className="table__link">
                                            {s.last_name ?? "—"}
                                        </Link>
                                    </td>
                                    <td>{s.student_number ?? "—"}</td>
                                    <td>{groupName(s.group_id)}</td>
                                    <td>
                                        {s.card_uid ? (
                                            <code>{s.card_uid}</code>
                                        ) : (
                                            <span className="muted">Aucune carte</span>
                                        )}
                                    </td>
                                    <td>{s.email ?? "—"}</td>
                                    <td className="table__actions-col">
                                        <button className="btn btn--sm" onClick={() => setDialog({ kind: "card", student: s })}>
                                            Carte
                                        </button>
                                        <button className="btn btn--sm" onClick={() => setDialog({ kind: "edit", student: s })}>
                                            Modifier
                                        </button>
                                        <button
                                            className="btn btn--sm btn--danger-ghost"
                                            onClick={() => setDialog({ kind: "delete", student: s })}
                                        >
                                            Supprimer
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <PaginationBar pagination={pagination} label="étudiant(s)" />
                </>
            )}

            {(dialog?.kind === "create" || dialog?.kind === "edit") && (
                <Modal title={dialog.kind === "edit" ? "Modifier l'étudiant" : "Nouvel étudiant"} onClose={() => setDialog(null)}>
                    <StudentForm
                        groups={groups}
                        initial={dialog.kind === "edit" ? dialog.student : null}
                        busy={busy}
                        onSubmit={(v) => void submitForm(v)}
                        onCancel={() => setDialog(null)}
                    />
                </Modal>
            )}

            {dialog?.kind === "card" && (
                <AssignCardDialog
                    student={dialog.student}
                    onClose={() => setDialog(null)}
                    onAssigned={onCardAssigned}
                />
            )}

            {dialog?.kind === "import" && (
                <Modal title="Importer des étudiants (CSV)" onClose={() => setDialog(null)}>
                    <ImportStudentsDialog
                        onFinished={(imported) => {
                            setDialog(null);
                            if (imported > 0) load();
                        }}
                    />
                </Modal>
            )}

            {dialog?.kind === "delete" && (
                <ConfirmDialog
                    title="Supprimer l'étudiant"
                    message={`Supprimer ${fullName(dialog.student.first_name, dialog.student.last_name)} ? Ses cartes seront détachées et son historique de scan conservé.`}
                    confirmLabel="Supprimer"
                    danger
                    busy={busy}
                    onConfirm={() => void confirmDelete()}
                    onCancel={() => setDialog(null)}
                />
            )}
        </div>
    );
}
