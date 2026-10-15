import { useCallback, useEffect, useMemo, useState } from "react";

import { listUsers } from "../api/users";
import { useAuth } from "../hooks/useAuth";
import { useSortState } from "../hooks/useSort";
import { usePagination } from "../hooks/usePagination";
import { sortRows } from "../lib/sort";
import { formatDate, formatDateTime, ROLE_LABEL } from "../lib/format";
import type { UserAccount } from "../types/domain";
import { EmptyState, ErrorState, Loading } from "../components/common/StateBlocks";
import { SortHeader } from "../components/common/SortHeader";
import { PaginationBar } from "../components/common/PaginationBar";
import { CreateUserDialog } from "../components/users/CreateUserDialog";
import { ChangeRoleDialog } from "../components/users/ChangeRoleDialog";
import { ResetPasswordDialog } from "../components/users/ResetPasswordDialog";

type Dialog =
    | { kind: "create" }
    | { kind: "role"; target: UserAccount }
    | { kind: "password"; target: UserAccount }
    | null;

type UserSortKey = "username" | "role" | "created_at" | "updated_at";

// Admin-only account management (route guard lives in App.tsx): list users,
// create accounts, change roles, reset passwords. No password ever flows
// back from the API.
export function UsersPage() {
    const { user: me } = useAuth();
    const { spec, toggle } = useSortState<UserSortKey>();

    const [users, setUsers] = useState<UserAccount[] | null>(null);
    const [error, setError] = useState<unknown>(null);
    const [dialog, setDialog] = useState<Dialog>(null);

    const load = useCallback((): void => {
        setError(null);
        listUsers()
            .then((res) => setUsers(res.rows))
            .catch((err) => setError(err));
    }, []);

    useEffect(load, [load]);

    // Replace a row in place after a mutation (keeps the list order stable).
    const upsert = (updated: UserAccount): void => {
        setUsers((list) => (list ? list.map((u) => (u.id === updated.id ? updated : u)) : list));
    };

    // Header click: ascending → descending → default sort.
    const sorted = useMemo(
        () =>
            sortRows(users ?? [], spec, {
                username: (u) => u.username,
                role: (u) => ROLE_LABEL[u.role],
                created_at: (u) => u.created_at,
                updated_at: (u) => u.updated_at,
            }),
        [users, spec],
    );

    const pagination = usePagination(sorted.length);

    return (
        <div className="page">
            <div className="page__header">
                <h1>Utilisateurs</h1>
                <button className="btn btn--primary" onClick={() => setDialog({ kind: "create" })}>
                    Ajouter un utilisateur
                </button>
            </div>

            {error !== null ? (
                <ErrorState error={error} onRetry={load} text="Impossible de charger les utilisateurs." />
            ) : users === null ? (
                <Loading text="Chargement des utilisateurs…" />
            ) : users.length === 0 ? (
                <EmptyState text="Aucun utilisateur." />
            ) : (
                <>
                    <table className="table">
                        <thead>
                            <tr>
                                <SortHeader label="Utilisateur" sortKey="username" spec={spec} onSort={toggle} />
                                <SortHeader label="Rôle" sortKey="role" spec={spec} onSort={toggle} />
                                <SortHeader label="Créé le" sortKey="created_at" spec={spec} onSort={toggle} />
                                <SortHeader label="Dernière modification" sortKey="updated_at" spec={spec} onSort={toggle} />
                                <th className="table__actions-col">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {pagination.slice(sorted).map((u) => {
                                const isSelf = u.id === me?.id;
                                return (
                                    <tr key={u.id}>
                                        <td>
                                            <strong>{u.username}</strong>
                                            {isSelf && <span className="muted"> (vous)</span>}
                                        </td>
                                        <td>
                                            <span className={`badge badge--${u.role}`}>{ROLE_LABEL[u.role]}</span>
                                        </td>
                                        <td>{formatDate(u.created_at)}</td>
                                        <td>{formatDateTime(u.updated_at)}</td>
                                        <td className="table__actions-col">
                                            <button
                                                className="btn btn--sm"
                                                onClick={() => setDialog({ kind: "role", target: u })}
                                                disabled={isSelf}
                                                title={
                                                    isSelf
                                                        ? "Vous ne pouvez pas modifier votre propre rôle."
                                                        : `Modifier le rôle de ${u.username}`
                                                }
                                            >
                                                Rôle
                                            </button>
                                            <button
                                                className="btn btn--sm"
                                                onClick={() => setDialog({ kind: "password", target: u })}
                                                title={`Modifier le mot de passe de ${u.username}`}
                                            >
                                                Mot de passe
                                            </button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                    <PaginationBar pagination={pagination} label="utilisateur(s)" />
                </>
            )}

            {dialog?.kind === "create" && <CreateUserDialog onClose={() => setDialog(null)} onCreated={load} />}
            {dialog?.kind === "role" && (
                <ChangeRoleDialog
                    target={dialog.target}
                    onClose={() => setDialog(null)}
                    onChanged={upsert}
                />
            )}
            {dialog?.kind === "password" && (
                <ResetPasswordDialog
                    target={dialog.target}
                    isSelf={dialog.target.id === me?.id}
                    onClose={() => setDialog(null)}
                    onSaved={load}
                />
            )}
        </div>
    );
}
