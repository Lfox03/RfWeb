// « Base de données » administration : sauvegardes .db de la base courante
// et restauration complète à partir d'un fichier .db téléversé (voir la fin
// du fichier pour le déroulement prudent de la restauration).
//
// La copie est faite par l'API de sauvegarde en ligne de SQLite
// (better-sqlite3 `db.backup()`), PAS par une copie du fichier vivant : le
// résultat est un instantané cohérent, journal WAL inclus, même pendant que
// l'application écrit. Les fichiers produits sont nommés de façon sûre
// (horodatage UTC, aucun caractère de chemin) et stockés dans BACKUP_DIR ;
// seule cette arborescence est accessible en lecture, jamais le reste du
// système de fichiers (nom validé par expression régulière stricte).

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";

import { db, getCurrentDbPath, reopenDatabase, sessionRepository, TARGET_SCHEMA_VERSION } from "../db";
import type { DatabaseHandle } from "../db";
import { runMigrations } from "../db/migrations";
import { isoNow } from "../db/types";
import { BACKUP_DIR } from "../config/env";
import { AppError, BackupError, ConflictError, NotFoundError, ValidationError } from "../core/errors";
import { errorFields, logger } from "../core/logger";

// Journalisation serveur uniquement : les erreurs SQLite/système restent dans
// les logs, le client ne reçoit jamais qu'un message français générique.
const backupLog = logger.child({ component: "backup" });

// Métadonnées d'une sauvegarde — volontairement sans chemin serveur.
export interface BackupInfo {
    filename: string;
    size_bytes: number;
    created_at: string;
}

// Format généré : attendance-YYYYMMDD-HHMMSS.db (suffixe -N en cas de
// collision dans la même seconde). Rien d'autre n'est jamais accepté en
// lecture : ni séparation de chemin, ni « .. », ni autre extension.
const BACKUP_FILENAME_RE = /^attendance-\d{8}-\d{6}(?:-\d{1,2})?\.db$/;

function backupDir(): string {
    return path.resolve(BACKUP_DIR);
}

// Horodatage UTC au format AAAAMMJJ-HHMMSS (puisque isoNow() est UTC).
function timestampStamp(): string {
    return isoNow().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

// Chemin cible inédit dans le répertoire de sauvegarde.
function nextBackupPath(dir: string): { filePath: string; filename: string } {
    const stem = `attendance-${timestampStamp()}`;
    let filename = `${stem}.db`;
    for (let suffix = 2; fs.existsSync(path.join(dir, filename)) && suffix <= 99; suffix++) {
        filename = `${stem}-${suffix}.db`;
    }
    return { filePath: path.join(dir, filename), filename };
}

// Instantané cohérent de la base courante (WAL inclus) dans BACKUP_DIR.
export async function createBackup(): Promise<BackupInfo> {
    const dir = backupDir();
    let filePath = "";
    try {
        fs.mkdirSync(dir, { recursive: true });
        const target = nextBackupPath(dir);
        filePath = target.filePath;
        // Sauvegarde en ligne SQLite : transactionnelle, cohérente même sous
        // charge, et qui intègre le contenu du journal WAL sans le toucher.
        await db.backup(filePath);
        const stat = await fsp.stat(filePath);
        return { filename: target.filename, size_bytes: stat.size, created_at: isoNow() };
    } catch (err) {
        // Fichier partiel le cas échéant : suppression au propre, meilleure
        // effort (l'erreur d'origine reste la cause remontée dans les logs).
        if (filePath) {
            await fsp.rm(filePath, { force: true }).catch(() => undefined);
        }
        backupLog.error("backup.create_failed", errorFields(err));
        throw new BackupError();
    }
}

// Sauvegardes présentes dans BACKUP_DIR, plus récente d'abord (mtime de
// l'écriture, le nom horodaté servant de départage). Un fichier disparu
// entre-temps est ignoré.
export async function listBackups(): Promise<BackupInfo[]> {
    const dir = backupDir();
    let names: string[];
    try {
        names = await fsp.readdir(dir);
    } catch (err) {
        // Aucune sauvegarde tant que le répertoire n'existe pas.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        backupLog.error("backup.dir_unreadable", errorFields(err));
        throw new BackupError("Lecture du répertoire de sauvegardes impossible. Réessayez.");
    }

    const infos = await Promise.all(
        names
            .filter((name) => BACKUP_FILENAME_RE.test(name))
            .map(async (name): Promise<BackupInfo | null> => {
                try {
                    const stat = await fsp.stat(path.join(dir, name));
                    if (!stat.isFile()) return null;
                    // mtime = instant de rédaction de la sauvegarde.
                    return { filename: name, size_bytes: stat.size, created_at: stat.mtime.toISOString() };
                } catch {
                    return null;
                }
            }),
    );
    return infos
        .filter((info): info is BackupInfo => info !== null)
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.filename.localeCompare(a.filename));
}

// Charge le contenu d'une sauvegarde pour le téléchargement. Toute tentative
// de sortie du répertoire (chemin, « .. », autre extension) est refusée par
// l'expression régulière stricte — aucune information interne (chemoisement,
// arborescence, erreur système) n'est divulguée au client.
export async function readBackup(
    filename: string,
): Promise<{ filename: string; sizeBytes: number; content: Buffer }> {
    if (typeof filename !== "string" || !BACKUP_FILENAME_RE.test(filename)) {
        throw new ValidationError("Nom de sauvegarde invalide.");
    }
    const dir = backupDir();
    const filePath = path.resolve(dir, filename);
    // Ceintures et bretelles : le nom validé ne peut pas sortir du répertoire,
    // on le vérifie quand même avant de toucher au système de fichiers.
    if (path.dirname(filePath) !== dir) {
        throw new ValidationError("Nom de sauvegarde invalide.");
    }
    try {
        const content = await fsp.readFile(filePath);
        return { filename, sizeBytes: content.length, content };
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new NotFoundError("Sauvegarde");
        backupLog.error("backup.read_failed", { filename, ...errorFields(err) });
        throw new BackupError("Lecture de la sauvegarde impossible. Réessayez.");
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Restauration complète de la base (.db) — l'opération inverse.
//
// Principe de précaution : la base vivante n'est JAMAIS écrasée par un
// fichier non vérifié. Le fichier téléversé est d'abord écrit dans un
// fichier tampon, à côté de la base (même volume, pour un remplacement
// atomique) ; il est ensuite ouvert, contrôlé (intégrité SQLite, version et
// migrations de schéma, tables attendues). Ce n'est qu'après ces contrôles
// qu'une sauvegarde de sécurité de la base courante est créée, puis que le
// remplacement a lieu dans une phase strictement synchrone (imposée par le
// monopilote du moteur) : fermeture de la connexion,
// échange des fichiers, réouverture via reopenDatabase() — les exports
// vivants de db/index.ts propagent la nouvelle connexion à toute
// l'application sans redémarrage.
//
// Aucune erreur système (chemin, SQLite, disque) n'est renvoyée au client :
// journalisée côté serveur, elle devient un message français générique.
// ═══════════════════════════════════════════════════════════════════════════

// Résultat d'une restauration — uniquement des métadonnées, jamais de chemin.
export interface RestoreResult {
    restored_size_bytes: number;
    safety_backup: BackupInfo;
}

// En-tête magique de tout fichier SQLite (« SQLite format 3\0 »).
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");

// Tables que la base restaurée doit contenir à l'issue des migrations —
// un fichier valide sur le plan binaire mais étranger à l'application est
// refusé ici plutôt que d'être activé puis de planter à la première requête.
const RESTORE_CORE_TABLES = [
    "users",
    "groups",
    "app_students",
    "cards",
    "app_sessions",
    "session_groups",
    "app_attendances",
    "card_scans",
    "auth_sessions",
] as const;

// Contrôle du fichier tampon : ouverture SQLite réussie, PRAGMA integrity_check
// « ok », version de schéma compatible (les versions antérieures sont montées
// par les migrations de l'application, une version future est refusée), puis
// présence de toutes les tables attendues. Échec ⇒ ValidationError (400),
// la base vivante n'a encore rien vu.
function validateStagedDatabase(stagedPath: string): void {
    let staged: DatabaseHandle | null = null;
    try {
        try {
            staged = new Database(stagedPath);
        } catch {
            throw new ValidationError("Fichier invalide : ce n'est pas une base de données SQLite.");
        }
        let integrity: unknown;
        try {
            integrity = staged.pragma("integrity_check", { simple: true });
        } catch {
            integrity = "erreur";
        }
        if (integrity !== "ok") {
            throw new ValidationError("Fichier invalide : le contrôle d'intégrité SQLite a échoué.");
        }
        const version = staged.pragma("user_version", { simple: true }) as number;
        if (version > TARGET_SCHEMA_VERSION) {
            throw new ValidationError(
                `Base non restaurable : version de schéma ${version} postérieure à celle de l'application (${TARGET_SCHEMA_VERSION}).`,
            );
        }
        if (version < TARGET_SCHEMA_VERSION) {
            try {
                runMigrations(staged);
            } catch {
                throw new ValidationError("Base non restaurable : la mise à jour du schéma a échoué.");
            }
        }
        const tables = new Set(
            (staged.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
                (row) => row.name,
            ),
        );
        const missing = RESTORE_CORE_TABLES.filter((table) => !tables.has(table));
        if (missing.length > 0) {
            throw new ValidationError(
                `Base non restaurable : tables attendues absentes (${missing.join(", ")}).`,
            );
        }
    } finally {
        if (staged) {
            try {
                staged.close();
            } catch {
                /* de toute façon inutilisable */
            }
        }
    }
}

// Restauration complète : remplace la base vivante par le fichier .db
// téléversé, après vérification complète et création d'une sauvegarde de
// sécurité de l'état courant. Refusée tant qu'une session est active (409).
export async function restoreBackup(content: Buffer): Promise<RestoreResult> {
    if (!Buffer.isBuffer(content) || content.length < 512 || !content.subarray(0, 16).equals(SQLITE_MAGIC)) {
        throw new ValidationError("Fichier invalide : envoyez le contenu complet d'un fichier .db sauvegardé.");
    }

    const livePath = path.resolve(getCurrentDbPath());
    // Tampon sur le même volume que la base : le remplacement final est un
    // simple rename atomique (ni copie, ni fenêtre de base à moitié écrite).
    const stagingPath = path.join(
        path.dirname(livePath),
        `.restore-staging-${process.pid}-${Date.now()}.tmp`,
    );

    // ── 1. Écriture + vérification du fichier téléversé (base intacte) ──
    try {
        await fsp.writeFile(stagingPath, content);
        validateStagedDatabase(stagingPath);
    } catch (err) {
        await fsp.rm(stagingPath, { force: true }).catch(() => undefined);
        if (err instanceof AppError) throw err;
        backupLog.error("restore.validate_failed", errorFields(err));
        throw new BackupError("La restauration de la base de données a échoué. Réessayez.");
    }

    // ── 2. Sauvegarde de sécurité de l'état courant ──
    if (sessionRepository.findActive()) {
        await fsp.rm(stagingPath, { force: true }).catch(() => undefined);
        throw new ConflictError(
            "RESTORE_SESSION_RUNNING",
            "Arrêtez la session active avant de restaurer la base de données.",
        );
    }
    let safetyBackup: BackupInfo;
    try {
        safetyBackup = await createBackup();
    } catch (err) {
        // Sans sauvegarde de sécurité, la restauration est annulée : on ne
        // remplace jamais une base sans pouvoir revenir en arrière.
        await fsp.rm(stagingPath, { force: true }).catch(() => undefined);
        throw err;
    }

    // ── 3. Échange atomique — phase strictement synchrone (aucun await) ──
    // Entre le dernier contrôle et la réouverture, rien d'autre (ordonnanceur,
    // boucle de scan, requête) ne peut toucher à la connexion ni au fichier :
    // tout se joue dans une seule exécution synchrone du moteur.
    const oldPath = `${livePath}.restore-old-${Date.now()}`;
    let swapped = false;
    // Contrôle renouvelé : la sauvegarde de sécurité ci-dessus était asynchrone
    // — l'ordonnanceur aurait pu démarrer une session entre-temps ; auquel cas
    // aucun fichier n'est touché et la sauvegarde de sécurité superflue retirée.
    const runningAborted = Boolean(sessionRepository.findActive());
    if (!runningAborted) {
        try {
            try {
                db.close();
            } catch {
                /* déjà fermée */
            }
            fs.rmSync(`${livePath}-wal`, { force: true });
            fs.rmSync(`${livePath}-shm`, { force: true });
            // L'ancien fichier est d'abord déplacé (et non supprimé) : si le
            // second rename échoue, la base d'origine est replacée telle quelle.
            fs.renameSync(livePath, oldPath);
            try {
                fs.renameSync(stagingPath, livePath);
                swapped = true;
            } catch (err) {
                fs.renameSync(oldPath, livePath);
                throw err;
            }
        } catch (err) {
            // La base d'origine est replacée : la rouvrir immédiatement, de
            // façon synchrone, avant le moindre await — l'application
            // redevient fonctionnelle avant même que l'erreur soit renvoyée.
            try {
                reopenDatabase(livePath);
            } catch (reopenErr) {
                backupLog.error("restore.reopen_failed_after_swap_error", { restart_required: true, ...errorFields(reopenErr) });
            }
            backupLog.error("restore.swap_failed", errorFields(err));
        }
    }

    if (runningAborted) {
        await fsp.rm(stagingPath, { force: true }).catch(() => undefined);
        await fsp.rm(path.join(backupDir(), safetyBackup.filename), { force: true }).catch(() => undefined);
        throw new ConflictError(
            "RESTORE_SESSION_RUNNING",
            "Arrêtez la session active avant de restaurer la base de données.",
        );
    }
    if (!swapped) {
        await fsp.rm(stagingPath, { force: true }).catch(() => undefined);
        throw new BackupError("La restauration de la base de données a échoué. Réessayez.");
    }

    // ── 4. Réouverture — le fichier téléversé est désormais la base vivante ──
    try {
        reopenDatabase(livePath);
    } catch (err) {
        // Le nouvel état est en place mais inutilisable : on remet l'ancien
        // (conservé sous oldPath) et on tente de le rouvrir.
        backupLog.error("restore.reopen_failed_after_swap", { rollback: "attempted", ...errorFields(err) });
        try {
            fs.rmSync(`${livePath}-wal`, { force: true });
            fs.rmSync(`${livePath}-shm`, { force: true });
            fs.rmSync(livePath, { force: true });
            fs.renameSync(oldPath, livePath);
            reopenDatabase(livePath);
        } catch (rollbackErr) {
            backupLog.error("restore.rollback_failed", { restart_required: true, ...errorFields(rollbackErr) });
        }
        throw new BackupError("La restauration de la base de données a échoué. Réessayez.");
    }

    // Propre : l'ancien fichier n'a plus d'utilité (la sauvegarde de
    // sécurité, elle, reste listée et téléchargeable).
    try {
        fs.rmSync(oldPath, { force: true });
    } catch {
        /* résidu inoffensif, jamais sous les pieds de SQLite */
    }

    backupLog.info("restore.completed", {
        restored_size_bytes: content.length,
        safety_backup: safetyBackup.filename,
    });
    return { restored_size_bytes: content.length, safety_backup: safetyBackup };
}
