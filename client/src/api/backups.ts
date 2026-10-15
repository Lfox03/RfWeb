// Database backup endpoints (admin-only). A backup is a consistent SQLite
// snapshot created server-side (online backup API, WAL included); the API
// never exposes server paths — only the generated .db filename.

import { downloadFile, getList, post, postRaw } from "./client";
import type { ListResult } from "../types/api";
import type { BackupInfo, RestoreResult } from "../types/domain";

export function createBackup(): Promise<BackupInfo> {
    return post<BackupInfo>("/backups");
}

export function listBackups(): Promise<ListResult<BackupInfo>> {
    return getList<BackupInfo>("/backups");
}

// Direct download of a stored backup as a raw .db file.
export function downloadBackup(filename: string): Promise<void> {
    return downloadFile(`/backups/${encodeURIComponent(filename)}`, filename);
}

// Full restore from an uploaded .db backup (raw octet-stream body). The server
// validates the file and creates a safety backup of the CURRENT database
// before replacing it — a dangerous, irreversible operation.
export function restoreBackup(file: File): Promise<RestoreResult> {
    return postRaw<RestoreResult>("/backups/restore", "application/octet-stream", file);
}
