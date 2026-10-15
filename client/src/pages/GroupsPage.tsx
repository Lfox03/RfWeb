import { useCallback, useEffect, useMemo, useState } from "react";

import { toUiMessage } from "../api/client";
import { createGroup, deleteGroup, listGroups, renameGroup } from "../api/groups";
import { useWebSocket } from "../hooks/useWebSocket";
import { useToast } from "../hooks/useToast";
import { useSortState } from "../hooks/useSort";
import { usePagination } from "../hooks/usePagination";
import { sortRows } from "../lib/sort";
import type { GroupRow } from "../types/domain";
import { EmptyState, ErrorState, Loading } from "../components/common/StateBlocks";
import { ConfirmDialog } from "../components/common/ConfirmDialog";
import { Modal } from "../components/common/Modal";
import { SortHeader } from "../components/common/SortHeader";
import { PaginationBar } from "../components/common/PaginationBar";

type GroupSortKey = "name" | "student_count";

export function GroupsPage() {
    const { epoch } = useWebSocket();
    const { push } = useToast();
    const { spec, toggle } = useSortState<GroupSortKey>();

    const [groups, setGroups] = useState<GroupRow[] | null>(null);
    const [error, setError] = useState<unknown>(null);
    const [query, setQuery] = useState("");
    const [newName, setNewName] = useState("");
    const [renaming, setRenaming] = useState<GroupRow | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const [deleting, setDeleting] = useState<GroupRow | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback((): void => {
        setError(null);
        listGroups()
            .then((res) => setGroups(res.rows))
            .catch((err) => setError(err));
    }, []);

    useEffect(load, [load, epoch]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        const list = groups ?? [];
        return q ? list.filter((g) => g.name.toLowerCase().includes(q)) : list;
    }, [groups, query]);

    // Header click: ascending → descending → default sort.
    const sorted = useMemo(
        () =>
            sortRows(filtered, spec, {
                name: (g) => g.name,
                student_count: (g) => g.student_count ?? 0,
            }),
        [filtered, spec],
    );

    const pagination = usePagination(sorted.length);

    const handleCreate = async (): Promise<void> => {
        const name = newName.trim();
        if (!name) return;
        setBusy(true);
        try {
            await createGroup(name);
            setNewName("");
            push("success", "Groupe créé.");
            load();
        } catch (err) {
            // Includes GROUP_NAME_TAKEN (French message from the backend).
            push("danger", toUiMessage(err));
        } finally {
            setBusy(false);
        }
    };

    const handleRename = async (): Promise<void> => {
        if (!renaming) return;
        const name = renameValue.trim();
        if (!name) return;
        setBusy(true);
        try {
            await renameGroup(renaming.id, name);
            push("success", "Groupe renommé.");
            setRenaming(null);
            load();
        } catch (err) {
            push("danger", toUiMessage(err));
        } finally {
            setBusy(false);
        }
    };

    const handleDelete = async (): Promise<void> => {
        if (!deleting) return;
        setBusy(true);
        try {
            await deleteGroup(deleting.id);
            push("success", "Groupe supprimé.");
            setDeleting(null);
            load();
        } catch (err) {
            push("danger", toUiMessage(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="page">
            <div className="page__header">
                <h1>Groupes</h1>
            </div>

            <div className="toolbar">
                <input
                    className="toolbar__search"
                    type="search"
                    placeholder="Rechercher un groupe…"
                    value={query}
                    onChange={(e) => {
                        setQuery(e.target.value);
                        pagination.reset();
                    }}
                    aria-label="Rechercher un groupe"
                />
                <form
                    className="inline-form"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void handleCreate();
                    }}
                >
                    <input
                        placeholder="Nom du nouveau groupe"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        maxLength={100}
                        aria-label="Nom du nouveau groupe"
                    />
                    <button className="btn btn--primary" type="submit" disabled={busy || !newName.trim()}>
                        Ajouter
                    </button>
                </form>
            </div>

            {error !== null ? (
                <ErrorState error={error} onRetry={load} text="Impossible de charger les groupes." />
            ) : groups === null ? (
                <Loading text="Chargement des groupes…" />
            ) : groups.length === 0 ? (
                <EmptyState text="Aucun groupe." />
            ) : filtered.length === 0 ? (
                <EmptyState text="Aucun résultat pour cette recherche." />
            ) : (
                <>
                    <table className="table">
                        <thead>
                            <tr>
                                <SortHeader label="Nom" sortKey="name" spec={spec} onSort={toggle} />
                                <SortHeader label="Étudiants" sortKey="student_count" spec={spec} onSort={toggle} />
                                <th className="table__actions-col">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {pagination.slice(sorted).map((g) => (
                                <tr key={g.id}>
                                    <td>{g.name}</td>
                                    <td>{g.student_count ?? 0}</td>
                                    <td className="table__actions-col">
                                        <button
                                            className="btn btn--sm"
                                            onClick={() => {
                                                setRenaming(g);
                                                setRenameValue(g.name);
                                            }}
                                        >
                                            Renommer
                                        </button>
                                        <button className="btn btn--sm btn--danger-ghost" onClick={() => setDeleting(g)}>
                                            Supprimer
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <PaginationBar pagination={pagination} label="groupe(s)" />
                </>
            )}

            {renaming && (
                <Modal title="Renommer le groupe" onClose={() => setRenaming(null)}>
                    <form
                        className="form"
                        onSubmit={(e) => {
                            e.preventDefault();
                            void handleRename();
                        }}
                    >
                        <div className="field">
                            <label htmlFor="grp-name">Nom</label>
                            <input
                                id="grp-name"
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                autoFocus
                                maxLength={100}
                            />
                        </div>
                        <div className="form__actions">
                            <button type="button" className="btn" onClick={() => setRenaming(null)} disabled={busy}>
                                Annuler
                            </button>
                            <button type="submit" className="btn btn--primary" disabled={busy || !renameValue.trim()}>
                                Enregistrer
                            </button>
                        </div>
                    </form>
                </Modal>
            )}

            {deleting && (
                <ConfirmDialog
                    title="Supprimer le groupe"
                    message={`Supprimer le groupe « ${deleting.name} » ? Les ${deleting.student_count ?? 0} étudiant(s) associé(s) seront conservés mais détachés de ce groupe.`}
                    confirmLabel="Supprimer"
                    danger
                    busy={busy}
                    onConfirm={() => void handleDelete()}
                    onCancel={() => setDeleting(null)}
                />
            )}
        </div>
    );
}
