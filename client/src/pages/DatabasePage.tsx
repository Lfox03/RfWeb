import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";

import { createBackup, downloadBackup, listBackups, restoreBackup } from "../api/backups";
import { toUiMessage } from "../api/client";
import { useToast } from "../hooks/useToast";
import { useSortState } from "../hooks/useSort";
import { sortRows } from "../lib/sort";
import { formatDateTime, formatFileSize } from "../lib/format";
import type { BackupInfo } from "../types/domain";
import { EmptyState, ErrorState, Loading } from "../components/common/StateBlocks";
import { ConfirmDialog } from "../components/common/ConfirmDialog";
import { SortHeader } from "../components/common/SortHeader";

type BackupSortKey = "filename" | "size_bytes" | "created_at";

// Admin-only database administration (route guard lives in App.tsx): create a
// consistent SQLite snapshot of the live database, download any stored backup
// as a .db file, and restore a full database from an uploaded .db file (with
// an explicit confirmation — the current database is replaced). The server
// never exposes its paths.
export function DatabasePage() {
    const { push } = useToast();
    const { spec, toggle } = useSortState<BackupSortKey>();

    const [backups, setBackups] = useState<BackupInfo[] | null>(null);
    const [error, setError] = useState<unknown>(null);
    const [creating, setCreating] = useState(false);
    const [downloading, setDownloading] = useState<string | null>(null);
    const [restoreFile, setRestoreFile] = useState<File | null>(null);
    const [confirmingRestore, setConfirmingRestore] = useState(false);
    const [restoring, setRestoring] = useState(false);

    const load = useCallback((): void => {
        setError(null);
        listBackups()
            .then((res) => setBackups(res.rows))
            .catch((err) => setError(err));
    }, []);

    useEffect(load, [load]);

    const handleCreate = async (): Promise<void> => {
        setCreating(true);
        try {
            const info = await createBackup();
            push("success", `Sauvegarde créée : ${info.filename}`);
            load();
        } catch (err) {
            push("danger", toUiMessage(err));
        } finally {
            setCreating(false);
        }
    };

    const handleDownload = async (backup: BackupInfo): Promise<void> => {
        setDownloading(backup.filename);
        try {
            await downloadBackup(backup.filename);
        } catch (err) {
            push("danger", toUiMessage(err));
        } finally {
            setDownloading(null);
        }
    };

    const pickRestoreFile = (e: ChangeEvent<HTMLInputElement>): void => {
        setRestoreFile(e.target.files?.[0] ?? null);
    };

    // Runs only after the explicit confirmation dialog: the server validates
    // the .db file, snapshots the current database as a safety backup, then
    // replaces it. Every screen must be reloaded afterwards — the whole
    // database (users included) may have changed.
    const handleRestore = async (): Promise<void> => {
        if (!restoreFile || restoring) return;
        setRestoring(true);
        try {
            const result = await restoreBackup(restoreFile);
            push("success", `Base restaurée. Sauvegarde de sécurité créée : ${result.safety_backup.filename}.`);
            setConfirmingRestore(false);
            setRestoreFile(null);
            window.setTimeout(() => window.location.reload(), 1500);
        } catch (err) {
            push("danger", toUiMessage(err));
        } finally {
            setRestoring(false);
        }
    };

    // Header click: ascending → descending → default sort (newest first).
    const sorted = useMemo(
        () =>
            sortRows(backups ?? [], spec, {
                filename: (b) => b.filename,
                size_bytes: (b) => b.size_bytes,
                created_at: (b) => b.created_at,
            }),
        [backups, spec],
    );

    return (
        <div className="page">
            <div className="page__header">
                <h1>Base de données</h1>
                <button className="btn btn--primary" onClick={handleCreate} disabled={creating}>
                    {creating ? "Sauvegarde en cours…" : "Créer une sauvegarde"}
                </button>
            </div>

            <p className="muted">
                Chaque sauvegarde est un instantané cohérent de la base SQLite (journal WAL inclus),
                créé sans interrompre l&apos;application. Téléchargez-la depuis le tableau pour la
                conserver ou la restaurer.
            </p>

            <div className="card">
                <div className="card__header">
                    <span className="card__title">Restaurer une sauvegarde</span>
                </div>
                <div className="field">
                    <label htmlFor="restore-db-file">Fichier de sauvegarde (.db)</label>
                    <input
                        id="restore-db-file"
                        type="file"
                        accept=".db,application/octet-stream"
                        onChange={pickRestoreFile}
                        disabled={restoring}
                    />
                </div>
                <p className="muted">
                    La restauration remplace entièrement la base de données actuelle par le contenu
                    du fichier choisi (séances, présences, cartes, comptes et groupes). Une sauvegarde
                    de sécurité de la base actuelle est automatiquement créée avant l&apos;opération,
                    puis le serveur se recharge.
                </p>
                <div className="form__actions">
                    <button
                        className="btn btn--danger"
                        onClick={() => setConfirmingRestore(true)}
                        disabled={restoreFile === null || restoring}
                    >
                        {restoring ? "Restauration en cours…" : "Restaurer cette sauvegarde…"}
                    </button>
                </div>
            </div>

            {error !== null ? (
                <ErrorState error={error} onRetry={load} text="Impossible de charger les sauvegardes." />
            ) : backups === null ? (
                <Loading text="Chargement des sauvegardes…" />
            ) : backups.length === 0 ? (
                <EmptyState text="Aucune sauvegarde. Utilisez « Créer une sauvegarde » pour générer le fichier .db." />
            ) : (
                <table className="table">
                    <thead>
                        <tr>
                            <SortHeader label="Fichier" sortKey="filename" spec={spec} onSort={toggle} />
                            <SortHeader label="Taille" sortKey="size_bytes" spec={spec} onSort={toggle} />
                            <SortHeader label="Créée le" sortKey="created_at" spec={spec} onSort={toggle} />
                            <th className="table__actions-col">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sorted.map((backup) => (
                            <tr key={backup.filename}>
                                <td>
                                    <strong>{backup.filename}</strong>
                                </td>
                                <td>{formatFileSize(backup.size_bytes)}</td>
                                <td>{formatDateTime(backup.created_at)}</td>
                                <td className="table__actions-col">
                                    <button
                                        className="btn btn--sm"
                                        onClick={() => handleDownload(backup)}
                                        disabled={downloading !== null}
                                        title={`Télécharger ${backup.filename}`}
                                    >
                                        {downloading === backup.filename ? "Téléchargement…" : "Télécharger"}
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            {confirmingRestore && restoreFile !== null && (
                <ConfirmDialog
                    title="Restaurer la base de données"
                    message={`Attention : la base de données actuelle sera DÉFINITIVEMENT REMPLACÉE par le contenu de « ${restoreFile.name} » (${formatFileSize(restoreFile.size)}). Les données actuelles (séances, présences, cartes, comptes) seront perdues ; une sauvegarde de sécurité de la base actuelle sera créée avant la restauration. Confirmez-vous cette opération ?`}
                    confirmLabel="Remplacer et restaurer"
                    danger
                    busy={restoring}
                    onConfirm={() => void handleRestore()}
                    onCancel={() => setConfirmingRestore(false)}
                />
            )}
        </div>
    );
}
