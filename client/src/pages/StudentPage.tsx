import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { toUiMessage } from "../api/client";
import { revokeCard } from "../api/cards";
import { listGroups } from "../api/groups";
import { deleteStudent, getStudent, listStudentCards, updateStudent } from "../api/students";
import type { StudentInput } from "../api/students";
import { useNavigate } from "react-router-dom";
import { useToast } from "../hooks/useToast";
import { usePagination } from "../hooks/usePagination";
import { formatDate, fullName } from "../lib/format";
import type { CardRow, GroupRow, StudentWithCardRow } from "../types/domain";
import { EmptyState, ErrorState, Loading } from "../components/common/StateBlocks";
import { PaginationBar } from "../components/common/PaginationBar";
import { Modal } from "../components/common/Modal";
import { ConfirmDialog } from "../components/common/ConfirmDialog";
import { StudentForm } from "../components/students/StudentForm";
import { AssignCardDialog } from "../components/students/AssignCardDialog";

export function StudentPage() {
    const { id } = useParams<{ id: string }>();
    const studentId = Number(id);
    const navigate = useNavigate();
    const { push } = useToast();

    const [student, setStudent] = useState<StudentWithCardRow | null>(null);
    const [cards, setCards] = useState<CardRow[]>([]);
    const [groups, setGroups] = useState<GroupRow[]>([]);
    const [error, setError] = useState<unknown>(null);
    const [editing, setEditing] = useState(false);
    const [assigning, setAssigning] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback((): void => {
        if (!Number.isInteger(studentId) || studentId <= 0) {
            setError(new Error("Étudiant invalide."));
            return;
        }
        setError(null);
        void (async () => {
            try {
                const [st, cardsRes, groupsRes] = await Promise.all([
                    getStudent(studentId),
                    listStudentCards(studentId),
                    listGroups(),
                ]);
                setStudent(st);
                setCards(cardsRes.rows);
                setGroups(groupsRes.rows);
            } catch (err) {
                setError(err);
            }
        })();
    }, [studentId]);

    useEffect(load, [load]);

    const pagination = usePagination(cards.length);

    const submitEdit = async (values: StudentInput): Promise<void> => {
        setBusy(true);
        try {
            const updated = await updateStudent(studentId, values);
            setStudent(updated);
            setEditing(false);
            push("success", "Étudiant mis à jour.");
        } catch (err) {
            push("danger", toUiMessage(err));
        } finally {
            setBusy(false);
        }
    };

    const handleRevoke = async (): Promise<void> => {
        if (!confirmRevoke) return;
        setBusy(true);
        try {
            await revokeCard(confirmRevoke);
            push("success", "Carte retirée.");
            setConfirmRevoke(null);
            load();
        } catch (err) {
            push("danger", toUiMessage(err));
        } finally {
            setBusy(false);
        }
    };

    const handleDelete = async (): Promise<void> => {
        setBusy(true);
        try {
            await deleteStudent(studentId);
            push("success", "Étudiant supprimé.");
            navigate("/students", { replace: true });
        } catch (err) {
            push("danger", toUiMessage(err));
            setBusy(false);
        }
    };

    if (error !== null) {
        return (
            <div className="page">
                <ErrorState error={error} onRetry={load} text="Impossible de charger l'étudiant." />
            </div>
        );
    }
    if (!student) {
        return (
            <div className="page">
                <Loading text="Chargement de l'étudiant…" />
            </div>
        );
    }

    const groupName = student.group_id !== null ? groups.find((g) => g.id === student.group_id)?.name : null;
    const activeCard = cards.find((c) => c.revoked_at === null) ?? null;

    return (
        <div className="page">
            <p className="breadcrumbs">
                <Link to="/students">Étudiants</Link> / {fullName(student.first_name, student.last_name)}
            </p>

            <div className="page__header">
                <div>
                    <h1>{fullName(student.first_name, student.last_name)}</h1>
                    <p className="page__subtitle">
                        {groupName ?? "Aucun groupe"} · Numéro : {student.student_number ?? "—"} ·{" "}
                        {student.email ?? "sans e-mail"}
                    </p>
                </div>
                <div className="page__header-side">
                    <button className="btn btn--primary" onClick={() => setAssigning(true)}>
                        {activeCard ? "Remplacer la carte" : "Associer une carte"}
                    </button>
                    <button className="btn" onClick={() => setEditing(true)}>
                        Modifier
                    </button>
                    <button className="btn btn--danger-ghost" onClick={() => setConfirmDelete(true)}>
                        Supprimer
                    </button>
                </div>
            </div>

            <section className="card">
                <h2 className="card__title">Carte active</h2>
                {activeCard ? (
                    <div className="card-row-inline">
                        <code className="uid">{activeCard.uid}</code>
                        <button className="btn btn--danger-ghost btn--sm" onClick={() => setConfirmRevoke(activeCard.uid)}>
                            Retirer la carte
                        </button>
                    </div>
                ) : (
                    <EmptyState text="Aucune carte active." />
                )}
            </section>

            <section className="card">
                <h2 className="card__title">Historique des cartes</h2>
                {cards.length === 0 ? (
                    <EmptyState text="Aucune carte pour cet étudiant." />
                ) : (
                    <>
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>UID</th>
                                    <th>Statut</th>
                                    <th>Retirée le</th>
                                </tr>
                            </thead>
                            <tbody>
                                {pagination.slice(cards).map((c) => (
                                    <tr key={c.id}>
                                        <td>
                                            <code>{c.uid}</code>
                                        </td>
                                        <td>{c.revoked_at === null ? <span className="badge badge--running">Active</span> : <span className="badge badge--cancelled">Retirée</span>}</td>
                                        <td>{c.revoked_at ? formatDate(c.revoked_at) : "—"}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        <PaginationBar pagination={pagination} label="carte(s)" />
                    </>
                )}
            </section>

            {editing && (
                <Modal title="Modifier l'étudiant" onClose={() => setEditing(false)}>
                    <StudentForm
                        groups={groups}
                        initial={student}
                        busy={busy}
                        onSubmit={(v) => void submitEdit(v)}
                        onCancel={() => setEditing(false)}
                    />
                </Modal>
            )}

            {assigning && (
                <AssignCardDialog student={student} onClose={() => setAssigning(false)} onAssigned={() => load()} />
            )}

            {confirmRevoke !== null && (
                <ConfirmDialog
                    title="Retirer la carte"
                    message={`Retirer la carte ${confirmRevoke} ? Elle ne permettra plus d'enregistrer de présence (scan « carte retirée »). L'historique est conservé.`}
                    confirmLabel="Retirer"
                    danger
                    busy={busy}
                    onConfirm={() => void handleRevoke()}
                    onCancel={() => setConfirmRevoke(null)}
                />
            )}

            {confirmDelete && (
                <ConfirmDialog
                    title="Supprimer l'étudiant"
                    message={`Supprimer ${fullName(student.first_name, student.last_name)} ? Ses cartes seront détachées et son historique de scan conservé.`}
                    confirmLabel="Supprimer"
                    danger
                    busy={busy}
                    onConfirm={() => void handleDelete()}
                    onCancel={() => setConfirmDelete(false)}
                />
            )}
        </div>
    );
}
