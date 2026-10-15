// Sessions — deux vues : le PLANNING HEBDOMADAIRE (vue par défaut, Phase 4 :
// grille horaire, navigation de semaines, création ponctuelle/série, édition
// avec portée) et l'HISTORIQUE & RAPPORTS (liste filtrable, compteurs vivants
// et rapport détaillé avec export CSV — le contenu de la page précédente,
// conservé tel quel sous ?vue=historique). La vue active vit dans l'URL
// (?vue=calendrier|historique) pour rester partageable ; le rapport sélectionné
// garde son paramètre ?session=. HTTP only for the report (the page stays
// usable with the real-time link down).

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { toUiMessage } from "../api/client";
import { listGroups } from "../api/groups";
import { downloadSessionReportCsv, getSessionReport, listReportSessions } from "../api/reports";
import type { ReportFilters } from "../api/reports";
import { useWebSocket } from "../hooks/useWebSocket";
import { useToast } from "../hooks/useToast";
import { useSortState } from "../hooks/useSort";
import { usePagination } from "../hooks/usePagination";
import { sortRows } from "../lib/sort";
import { formatDate, formatDateTime, formatTime, fullName, SESSION_STATUS_LABEL } from "../lib/format";
import type { GroupRow, ReportSessionRow, SessionReport, SessionStatus } from "../types/domain";
import { EmptyState, ErrorState, Loading } from "../components/common/StateBlocks";
import { Modal } from "../components/common/Modal";
import { SortHeader } from "../components/common/SortHeader";
import { PaginationBar } from "../components/common/PaginationBar";
import { StatusBadge } from "../components/common/StatusBadge";
import { CreateSessionDialog } from "../components/sessions/CreateSessionDialog";
import { SessionsCalendar } from "../components/sessions/SessionsCalendar";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type SessionView = "calendrier" | "historique";

const STATUS_ORDER: SessionStatus[] = ["scheduled", "running", "completed", "cancelled"];

interface FilterState {
    from: string;
    to: string;
    groupId: string;
    status: string;
}

const EMPTY_FILTERS: FilterState = { from: "", to: "", groupId: "", status: "" };

type SessionSortKey =
    | "label"
    | "group_name"
    | "status"
    | "scheduled_at"
    | "started_at"
    | "ended_at"
    | "created_by_username"
    | "present_count"
    | "scan_count";

type RosterSortKey = "name" | "student_number" | "group_name" | "status" | "first_scan_at";

export function SessionsPage() {
    const { epoch } = useWebSocket();
    const { push } = useToast();
    const [searchParams, setSearchParams] = useSearchParams();
    const { spec, toggle } = useSortState<SessionSortKey>();
    const { spec: rosterSpec, toggle: toggleRoster } = useSortState<RosterSortKey>();

    const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
    const [groups, setGroups] = useState<GroupRow[]>([]);

    const [sessions, setSessions] = useState<ReportSessionRow[] | null>(null);
    const [sessionsError, setSessionsError] = useState<unknown>(null);
    const [creating, setCreating] = useState(false);

    const [report, setReport] = useState<SessionReport | null>(null);
    const [reportError, setReportError] = useState<unknown>(null);
    const [reportLoading, setReportLoading] = useState(false);
    const [exporting, setExporting] = useState(false);

    const selectedId = (() => {
        const raw = Number(searchParams.get("session"));
        return Number.isInteger(raw) && raw > 0 ? raw : null;
    })();

    // Vue active : calendrier (défaut) ou historique, persistée dans l'URL.
    const view: SessionView = searchParams.get("vue") === "historique" ? "historique" : "calendrier";
    const setView = (next: SessionView): void => {
        setSearchParams(
            (prev) => {
                const q = new URLSearchParams(prev);
                if (next === "calendrier") q.delete("vue");
                else q.set("vue", next);
                return q;
            },
            { replace: true },
        );
    };

    // Client-side guard: an invalid range must never reach the API.
    const invalidRange = DATE_RE.test(filters.from) && DATE_RE.test(filters.to) && filters.from > filters.to;

    const query = useMemo<ReportFilters>(
        () => ({
            from: filters.from || undefined,
            to: filters.to || undefined,
            groupId: filters.groupId ? Number(filters.groupId) : undefined,
            status: (filters.status || undefined) as SessionStatus | undefined,
        }),
        [filters],
    );

    const loadSessions = useCallback((): void => {
        if (invalidRange) {
            setSessions(null);
            return;
        }
        setSessionsError(null);
        listReportSessions(query)
            .then((res) => setSessions(res.rows))
            .catch((err) => setSessionsError(err));
    }, [query, invalidRange]);

    // epoch: the present/scan counters stay fresh during a session.
    useEffect(loadSessions, [loadSessions, epoch]);

    useEffect(() => {
        listGroups()
            .then((res) => setGroups(res.rows))
            .catch((err) => console.debug("[SESSIONS] Failed to load groups:", err));
    }, []);

    const loadReport = useCallback((): void => {
        if (selectedId === null) {
            setReport(null);
            setReportError(null);
            return;
        }
        setReportLoading(true);
        setReportError(null);
        getSessionReport(selectedId)
            .then(setReport)
            .catch(setReportError)
            .finally(() => setReportLoading(false));
    }, [selectedId]);

    useEffect(loadReport, [loadReport, epoch]);

    const selectSession = (id: number | null): void => {
        reportPagination.reset();
        setSearchParams(
            (prev) => {
                const next = new URLSearchParams(prev);
                if (id === null) next.delete("session");
                else next.set("session", String(id));
                return next;
            },
            { replace: true },
        );
    };

    // Header click: ascending → descending → default sort
    // (the server returns sessions by scheduled_at descending).
    const sorted = useMemo(
        () =>
            sortRows(sessions ?? [], spec, {
                label: (s) => s.label,
                group_name: (s) => s.group_name,
                status: (s) => s.status,
                scheduled_at: (s) => s.scheduled_at,
                started_at: (s) => s.started_at,
                ended_at: (s) => s.ended_at,
                created_by_username: (s) => s.created_by_username,
                present_count: (s) => s.present_count,
                scan_count: (s) => s.scan_count,
            }),
        [sessions, spec],
    );

    const sortedReportRows = useMemo(
        () =>
            sortRows(report?.rows ?? [], rosterSpec, {
                name: (r) => fullName(r.first_name, r.last_name),
                student_number: (r) => r.student_number,
                group_name: (r) => r.group_name,
                status: (r) => r.status,
                first_scan_at: (r) => r.first_scan_at,
            }),
        [report, rosterSpec],
    );

    const sessionsPagination = usePagination(sessions?.length ?? 0);
    const reportPagination = usePagination(report?.rows.length ?? 0);

    // Création (dialogue partagé, modes ponctuelle/série) : la liste
    // historique se recharge ; le calendrier (autre vue) se recharge à sa
    // propre monture.
    const handleCreated = (message: string): void => {
        setCreating(false);
        push("success", message);
        loadSessions();
    };

    const handleExport = async (): Promise<void> => {
        if (selectedId === null) return;
        setExporting(true);
        try {
            await downloadSessionReportCsv(selectedId);
            push("success", "Export CSV téléchargé.");
        } catch (err) {
            push("danger", toUiMessage(err));
        } finally {
            setExporting(false);
        }
    };

    const patch = (part: Partial<FilterState>): void => {
        setFilters((f) => ({ ...f, ...part }));
        sessionsPagination.reset();
    };

    return (
        <div className="page">
            <div className="page__header">
                <div>
                    <h1>Sessions</h1>
                </div>
                {view === "historique" && (
                    <button className="btn btn--primary" onClick={() => setCreating(true)}>
                        Nouvelle session
                    </button>
                )}
            </div>

            <nav className="tabs" role="tablist" aria-label="Vues des sessions">
                <button
                    type="button"
                    role="tab"
                    aria-selected={view === "calendrier"}
                    className={`tabs__tab ${view === "calendrier" ? "tabs__tab--active" : ""}`}
                    onClick={() => setView("calendrier")}
                >
                    Calendrier
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={view === "historique"}
                    className={`tabs__tab ${view === "historique" ? "tabs__tab--active" : ""}`}
                    onClick={() => setView("historique")}
                >
                    Historique et rapports
                </button>
            </nav>

            {view === "calendrier" ? (
                <SessionsCalendar />
            ) : (
                <>
                    <section className="card">
                        <h2 className="card__title">Filtres</h2>
                        <div className="filters">
                            <div className="field">
                                <label htmlFor="session-from">Du</label>
                                <input
                                    id="session-from"
                                    type="date"
                                    value={filters.from}
                                    onChange={(e) => patch({ from: e.target.value })}
                                />
                            </div>
                            <div className="field">
                                <label htmlFor="session-to">Au</label>
                                <input
                                    id="session-to"
                                    type="date"
                                    value={filters.to}
                                    onChange={(e) => patch({ to: e.target.value })}
                                />
                            </div>
                            <div className="field">
                                <label htmlFor="session-group">Groupe</label>
                                <select
                                    id="session-group"
                                    value={filters.groupId}
                                    onChange={(e) => patch({ groupId: e.target.value })}
                                >
                                    <option value="">Tous les groupes</option>
                                    {groups.map((g) => (
                                        <option key={g.id} value={g.id}>
                                            {g.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="field">
                                <label htmlFor="session-status">Statut</label>
                                <select
                                    id="session-status"
                                    value={filters.status}
                                    onChange={(e) => patch({ status: e.target.value })}
                                >
                                    <option value="">Tous les statuts</option>
                                    {STATUS_ORDER.map((s) => (
                                        <option key={s} value={s}>
                                            {SESSION_STATUS_LABEL[s]}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <button
                                className="btn btn--ghost"
                                onClick={() => {
                                    setFilters(EMPTY_FILTERS);
                                    sessionsPagination.reset();
                                }}
                                disabled={filters === EMPTY_FILTERS}
                            >
                                Réinitialiser
                            </button>
                        </div>
                        {invalidRange && (
                            <p className="form-error" role="alert">
                                La date de fin est antérieure à la date de début.
                            </p>
                        )}
                    </section>

                    {invalidRange ? null : sessionsError !== null ? (
                        <ErrorState
                            error={sessionsError}
                            onRetry={loadSessions}
                            text="Impossible de charger les sessions."
                        />
                    ) : sessions === null ? (
                        <Loading text="Chargement des sessions…" />
                    ) : sessions.length === 0 ? (
                        <EmptyState text="Aucune session ne correspond aux filtres." />
                    ) : (
                        <>
                            <table className="table">
                                <thead>
                                    <tr>
                                        <SortHeader label="Libellé" sortKey="label" spec={spec} onSort={toggle} />
                                        <SortHeader label="Groupe" sortKey="group_name" spec={spec} onSort={toggle} />
                                        <SortHeader label="Statut" sortKey="status" spec={spec} onSort={toggle} />
                                        <SortHeader label="Planifiée" sortKey="scheduled_at" spec={spec} onSort={toggle} />
                                        <SortHeader label="Démarrée" sortKey="started_at" spec={spec} onSort={toggle} />
                                        <SortHeader label="Terminée" sortKey="ended_at" spec={spec} onSort={toggle} />
                                        <SortHeader
                                            label="Créée par"
                                            sortKey="created_by_username"
                                            spec={spec}
                                            onSort={toggle}
                                        />
                                        <SortHeader
                                            label="Présents"
                                            sortKey="present_count"
                                            spec={spec}
                                            onSort={toggle}
                                        />
                                        <SortHeader label="Scans" sortKey="scan_count" spec={spec} onSort={toggle} />
                                        <th className="table__actions-col"></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {sessionsPagination.slice(sorted).map((s) => (
                                        <tr key={s.id} className={s.id === selectedId ? "row--selected" : undefined}>
                                            <td>
                                                <Link to={`/sessions/${s.id}`} className="table__link">
                                                    {s.label}
                                                </Link>
                                            </td>
                                            <td>{s.group_name ?? "—"}</td>
                                            <td>
                                                <StatusBadge status={s.status} />
                                            </td>
                                            <td>{formatDateTime(s.scheduled_at)}</td>
                                            <td>{formatDateTime(s.started_at)}</td>
                                            <td>{formatDateTime(s.ended_at)}</td>
                                            <td>{s.created_by_username ?? "—"}</td>
                                            <td>{s.present_count}</td>
                                            <td>{s.scan_count}</td>
                                            <td className="table__actions-col">
                                                <button className="btn btn--sm" onClick={() => selectSession(s.id)}>
                                                    Voir le rapport
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            <PaginationBar pagination={sessionsPagination} label="session(s)" />
                        </>
                    )}

                    {selectedId !== null && (
                        <section className="card">
                            {reportLoading ? (
                                <Loading text="Chargement du rapport…" />
                            ) : reportError !== null ? (
                                <ErrorState
                                    error={reportError}
                                    onRetry={loadReport}
                                    text="Impossible de charger le rapport."
                                />
                            ) : report ? (
                                <>
                                    <div className="page__header">
                                        <div>
                                            <h2 className="card__title">{report.session.label}</h2>
                                            <p className="page__subtitle">
                                                {report.group_name ?? "Tous les étudiants"} ·{" "}
                                                {formatDate(report.session.scheduled_at)} ·{" "}
                                                {report.session.duration_minutes} min
                                            </p>
                                        </div>
                                        <div className="page__header-side">
                                            <StatusBadge status={report.session.status} />
                                            <button
                                                className="btn btn--primary"
                                                onClick={() => void handleExport()}
                                                disabled={exporting}
                                            >
                                                {exporting ? "Export…" : "Exporter en CSV"}
                                            </button>
                                            <button className="btn btn--ghost" onClick={() => selectSession(null)}>
                                                Fermer
                                            </button>
                                        </div>
                                    </div>

                                    {report.session.status === "cancelled" && (
                                        <p className="report-note">
                                            Session annulée — les présences ci-dessous sont affichées à titre
                                            indicatif.
                                        </p>
                                    )}
                                    {report.group_name === null && (
                                        <p className="report-note">
                                            Aucun groupe associé — seules les personnes présentes sont listées.
                                        </p>
                                    )}

                                    <div className="report-summary">
                                        <span className="report-pill report-pill--present">
                                            {report.summary.present} présent(s)
                                        </span>
                                        <span className="report-pill report-pill--absent">
                                            {report.summary.absent} absent(s)
                                        </span>
                                        <span className="report-pill">{report.summary.total} étudiant(s)</span>
                                    </div>

                                    {report.rows.length === 0 ? (
                                        <EmptyState text="Aucun étudiant à signaler pour cette session." />
                                    ) : (
                                        <>
                                            <table className="table">
                                                <thead>
                                                    <tr>
                                                        <SortHeader
                                                            label="Étudiant"
                                                            sortKey="name"
                                                            spec={rosterSpec}
                                                            onSort={toggleRoster}
                                                        />
                                                        <SortHeader
                                                            label="Numéro"
                                                            sortKey="student_number"
                                                            spec={rosterSpec}
                                                            onSort={toggleRoster}
                                                        />
                                                        <SortHeader
                                                            label="Groupe"
                                                            sortKey="group_name"
                                                            spec={rosterSpec}
                                                            onSort={toggleRoster}
                                                        />
                                                        <SortHeader
                                                            label="Présence"
                                                            sortKey="status"
                                                            spec={rosterSpec}
                                                            onSort={toggleRoster}
                                                        />
                                                        <SortHeader
                                                            label="Premier scan"
                                                            sortKey="first_scan_at"
                                                            spec={rosterSpec}
                                                            onSort={toggleRoster}
                                                        />
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {reportPagination.slice(sortedReportRows).map((row) => (
                                                        <tr key={row.student_id}>
                                                            <td>
                                                                <Link to={`/students/${row.student_id}`}>
                                                                    {fullName(row.first_name, row.last_name)}
                                                                </Link>
                                                            </td>
                                                            <td>{row.student_number ?? "—"}</td>
                                                            <td>{row.group_name ?? "—"}</td>
                                                            <td>
                                                                <span
                                                                    className={
                                                                        row.status === "present"
                                                                            ? "presence presence--yes"
                                                                            : "presence presence--no"
                                                                    }
                                                                >
                                                                    {row.status === "present"
                                                                        ? "Présent(e)"
                                                                        : "Absent(e)"}
                                                                </span>
                                                            </td>
                                                            <td>
                                                                {row.status === "present"
                                                                    ? formatTime(row.first_scan_at)
                                                                    : "—"}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                            <PaginationBar pagination={reportPagination} label="étudiant(s)" />
                                        </>
                                    )}
                                </>
                            ) : null}
                        </section>
                    )}

                    {creating && (
                        <Modal title="Nouvelle session" onClose={() => setCreating(false)} width="wide">
                            <CreateSessionDialog
                                initialMode="once"
                                onCreatedOnce={(label) => handleCreated(`Séance « ${label} » créée.`)}
                                onCreatedSeries={(series) =>
                                    handleCreated(`Série « ${series.label} » créée — planifiée automatiquement.`)
                                }
                                onError={(message) => push("danger", message)}
                                onClose={() => setCreating(false)}
                            />
                        </Modal>
                    )}
                </>
            )}
        </div>
    );
}
