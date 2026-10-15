import { useCallback, useEffect, useMemo, useState } from "react";

import { listLogs } from "../api/logs";
import { formatLogTime } from "../lib/format";
import type { LogEntry, LogLevel } from "../types/domain";
import { EmptyState, ErrorState, Loading } from "../components/common/StateBlocks";

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const MAX_LINES = 500; // window fetched from the server-side buffer
const POLL_MS = 2000;

// Compact one-line rendering of a context value (full detail lives when the
// row is expanded).
function valueText(value: unknown): string {
    if (value === null) return "null";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function summarize(fields: Record<string, unknown>): string {
    return Object.entries(fields)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${valueText(v)}`)
        .join("  ");
}

// Admin-only viewer for the server's structured log tail (route guard lives in
// App.tsx). Everything shown has already been redacted by the logger; this is a
// read-only projection of an in-memory buffer — nothing is mutated or deleted.
export function LogsPage() {
    const [entries, setEntries] = useState<LogEntry[] | null>(null);
    const [error, setError] = useState<unknown>(null);
    const [level, setLevel] = useState<LogLevel | "all">("all");
    const [search, setSearch] = useState("");
    const [auto, setAuto] = useState(true);
    const [expanded, setExpanded] = useState<number | null>(null);
    // Lines at or below this seq are hidden by a manual "Effacer" until newer
    // ones arrive — the view stays append-only without losing the window.
    const [hiddenBeforeSeq, setHiddenBeforeSeq] = useState(0);

    const load = useCallback((): void => {
        setError(null);
        listLogs({ limit: MAX_LINES })
            .then((res) => setEntries(res.rows))
            .catch((err) => setError(err));
    }, []);

    useEffect(load, [load]);

    useEffect(() => {
        if (!auto) return;
        const id = window.setInterval(load, POLL_MS);
        return () => window.clearInterval(id);
    }, [auto, load]);

    const maxSeq = useMemo(() => (entries ?? []).reduce((m, e) => Math.max(m, e.seq), 0), [entries]);

    // Client-side filters over the fetched window (instant, no refetch churn).
    const visible = useMemo(() => {
        if (!entries) return [];
        const q = search.trim().toLowerCase();
        return entries
            .filter((e) => e.seq > hiddenBeforeSeq)
            .filter((e) => level === "all" || e.level === level)
            .filter((e) => q === "" || e.line.toLowerCase().includes(q) || e.event.toLowerCase().includes(q))
            .reverse(); // newest first (the buffer is delivered oldest → newest)
    }, [entries, search, level, hiddenBeforeSeq]);

    const shown = entries?.filter((e) => e.seq > hiddenBeforeSeq).length ?? 0;

    return (
        <div className="page">
            <div className="page__header">
                <h1>Journaux serveur</h1>
                <div className="page__header-side">
                    {hiddenBeforeSeq > 0 && (
                        <button className="btn btn--ghost" onClick={() => setHiddenBeforeSeq(0)}>
                            Tout afficher
                        </button>
                    )}
                    <label className="logs__auto">
                        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
                        Rafraîchir auto
                    </label>
                    <button className="btn" onClick={load}>
                        Actualiser
                    </button>
                    <button className="btn" onClick={() => setHiddenBeforeSeq(maxSeq)} disabled={maxSeq === 0}>
                        Effacer
                    </button>
                </div>
            </div>

            <p className="muted">
                Dernières lignes du journal applicatif, conservées en mémoire par le serveur (effacées au
                redémarrage).
            </p>

            <div className="toolbar">
                <input
                    className="toolbar__search"
                    type="search"
                    placeholder="Rechercher (événement, message…)"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    aria-label="Rechercher dans les journaux"
                />
                <select value={level} onChange={(e) => setLevel(e.target.value as LogLevel | "all")} aria-label="Filtrer par niveau">
                    <option value="all">Tous les niveaux</option>
                    {LEVELS.map((l) => (
                        <option key={l} value={l}>
                            {l}
                        </option>
                    ))}
                </select>
                <span className="muted logs__count">
                    {entries === null ? "…" : `${visible.length} affichée(s) sur ${shown}`}
                </span>
            </div>

            {error !== null ? (
                <ErrorState error={error} onRetry={load} text="Impossible de charger les journaux." />
            ) : entries === null ? (
                <Loading text="Chargement des journaux…" />
            ) : visible.length === 0 ? (
                <EmptyState
                    text={
                        entries.length === 0
                            ? "Aucune ligne de journal pour le moment."
                            : "Aucune ligne ne correspond aux filtres."
                    }
                />
            ) : (
                <div className="logs">
                    {visible.map((e) => (
                        <div key={e.seq} className={`logrow logrow--${e.level}`}>
                            <button
                                type="button"
                                className="logrow__head"
                                onClick={() => setExpanded((cur) => (cur === e.seq ? null : e.seq))}
                            >
                                <span className="logrow__time">{formatLogTime(e.timestamp)}</span>
                                <span className={`logrow__level logrow__level--${e.level}`}>{e.level}</span>
                                <span className="logrow__component">{e.component ?? "—"}</span>
                                <span className="logrow__event">{e.event}</span>
                                <span className="logrow__summary">{summarize(e.fields)}</span>
                            </button>
                            {expanded === e.seq && (
                                <div className="logrow__detail">
                                    <div className="logrow__detail-block">
                                        <span className="logrow__detail-label">Contexte</span>
                                        <pre className="logrow__raw">{JSON.stringify(e.fields, null, 2)}</pre>
                                    </div>
                                    <div className="logrow__detail-block">
                                        <span className="logrow__detail-label">Ligne JSON brute</span>
                                        <pre className="logrow__raw">{e.line}</pre>
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
