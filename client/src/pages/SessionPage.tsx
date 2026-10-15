import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { toUiMessage } from "../api/client";
import { listGroups } from "../api/groups";
import {
    getSession,
    listAttendance,
    listScans,
    markPresentManually,
    resetAttendance,
} from "../api/sessions";
import { downloadSessionReportCsv } from "../api/reports";
import { listStudents } from "../api/students";
import { useWebSocket } from "../hooks/useWebSocket";
import { useToast } from "../hooks/useToast";
import { useSortState } from "../hooks/useSort";
import { usePagination } from "../hooks/usePagination";
import { sortRows } from "../lib/sort";
import { formatDateTime, formatTime, fullName, SCAN_RESULT_LABEL } from "../lib/format";
import type {
    GroupRow,
    SessionAttendanceRow,
    SessionScanRow,
    SessionWithGroups,
    StudentWithCardRow,
} from "../types/domain";
import type { ServerEvent } from "../types/websocket";
import { EmptyState, ErrorState, Loading } from "../components/common/StateBlocks";
import { Modal } from "../components/common/Modal";
import { SortHeader } from "../components/common/SortHeader";
import { PaginationBar } from "../components/common/PaginationBar";
import { StatusBadge } from "../components/common/StatusBadge";
import { SessionControls } from "../components/sessions/SessionControls";
import { SessionEditDialog } from "../components/sessions/SessionEditDialog";
import { ConfirmDialog } from "../components/common/ConfirmDialog";

interface AttendanceView {
    studentId: number;
    name: string;
    studentNumber: string | null;
    groupName: string | null;
    present: boolean;
    scannedAt: string | null;
}

type RosterSortKey = "name" | "student_number" | "group" | "present" | "scanned_at";
type ScanSortKey = "scanned_at" | "result" | "student_name" | "uid";

export function SessionPage() {
    const { id } = useParams<{ id: string }>();
    const sessionId = Number(id);
    const { epoch, subscribe } = useWebSocket();
    const { push } = useToast();

    const [session, setSession] = useState<SessionWithGroups | null>(null);
    const [students, setStudents] = useState<StudentWithCardRow[]>([]);
    const [groups, setGroups] = useState<GroupRow[]>([]);
    const [attendance, setAttendance] = useState<SessionAttendanceRow[] | null>(null);
    const [scans, setScans] = useState<SessionScanRow[]>([]);
    const [error, setError] = useState<unknown>(null);
    const [confirmReset, setConfirmReset] = useState(false);
    const [editing, setEditing] = useState(false);
    const [resetting, setResetting] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [markingId, setMarkingId] = useState<number | null>(null);
    const { spec, toggle } = useSortState<RosterSortKey>();
    const { spec: scanSpec, toggle: toggleScans } = useSortState<ScanSortKey>();

    const load = useCallback((): void => {
        if (!Number.isInteger(sessionId) || sessionId <= 0) {
            setError(new Error("Session invalide."));
            return;
        }
        setError(null);
        void (async () => {
            try {
                const [s, att, scansRes, studentsRes, groupsRes] = await Promise.all([
                    getSession(sessionId),
                    listAttendance(sessionId),
                    listScans(sessionId),
                    listStudents(),
                    listGroups(),
                ]);
                setSession(s);
                setAttendance(att.rows);
                setScans([...scansRes.rows].reverse());
                setStudents(studentsRes.rows);
                setGroups(groupsRes.rows);
            } catch (err) {
                setError(err);
            }
        })();
    }, [sessionId]);

    useEffect(load, [load, epoch]);

    // Live attendance + scan feed: patch the affected row only, no reload.
    useEffect(() => {
        return subscribe((event: ServerEvent) => {
            if (event.event !== "attendance:scanned" || event.content.sessionId !== sessionId) return;
            const c = event.content;
            const scanRow: SessionScanRow = {
                scan_id: -Math.floor(Math.random() * 1e9),
                student_id: c.studentId,
                student_name: c.studentName,
                uid: c.uid,
                result: c.result,
                scanned_at: c.scannedAt,
            };
            setScans((rows) => [scanRow, ...rows].slice(0, 100));

            if (c.result === "accepted" || c.result === "manual") {
                push(
                    "success",
                    `✓ ${c.studentName ?? `Étudiant ${c.studentId}`} — présence enregistrée${c.result === "manual" ? " (manuelle)" : ""}`,
                );
                setAttendance((rows) => {
                    if (!rows || c.studentId === null) return rows;
                    if (rows.some((r) => r.student_id === c.studentId)) return rows;
                    return [
                        ...rows,
                        {
                            attendance_id: -c.studentId,
                            student_id: c.studentId,
                            first_name: c.studentName ?? "?",
                            last_name: null,
                            group_name: null,
                            card_uid: null,
                            scanned_at: c.scannedAt,
                            is_valid: 1,
                        },
                    ];
                });
            } else if (c.result === "duplicate") {
                push("info", `${c.studentName ?? "Cet étudiant"} est déjà présent(e).`);
            } else if (c.result === "unknown") {
                push("warning", "Carte RFID inconnue.");
            } else if (c.result === "expired") {
                push("warning", `Carte retirée${c.studentName ? ` (${c.studentName})` : ""} — présence non enregistrée.`);
            } else if (c.result === "out_of_group") {
                push(
                    "warning",
                    `${c.studentName ?? `Carte ${c.uid}`} n'appartient pas aux groupes de cette session — présence non enregistrée.`,
                );
            }
        });
    }, [subscribe, sessionId, push]);

    const attendanceByStudent = useMemo(() => {
        const map = new Map<number, SessionAttendanceRow>();
        for (const row of attendance ?? []) map.set(row.student_id, row);
        return map;
    }, [attendance]);

    // Roster = union of the session's groups (empty selection = no expected
    // roster, only recorded attendees are shown).
    const rows = useMemo<AttendanceView[]>(() => {
        const roster =
            session && session.group_ids.length > 0
                ? students.filter((st) => st.group_id !== null && session.group_ids.includes(st.group_id))
                : [];
        const out: AttendanceView[] = roster.map((st) => {
            const att = attendanceByStudent.get(st.id);
            return {
                studentId: st.id,
                name: fullName(st.first_name, st.last_name),
                studentNumber: st.student_number,
                groupName: groups.find((g) => g.id === st.group_id)?.name ?? null,
                present: att !== undefined,
                scannedAt: att?.scanned_at ?? null,
            };
        });
        // Attendees outside the roster (session without group, or a student
        // from another group that still has a valid card).
        const inRoster = new Set(out.map((r) => r.studentId));
        for (const row of attendance ?? []) {
            if (!inRoster.has(row.student_id)) {
                out.push({
                    studentId: row.student_id,
                    name: fullName(row.first_name, row.last_name),
                    studentNumber: students.find((st) => st.id === row.student_id)?.student_number ?? null,
                    groupName: row.group_name,
                    present: true,
                    scannedAt: row.scanned_at,
                });
            }
        }
        // Present first (by time), then absent alphabetically.
        return out.sort((a, b) => {
            if (a.present !== b.present) return a.present ? -1 : 1;
            if (a.present && b.present) return (a.scannedAt ?? "").localeCompare(b.scannedAt ?? "");
            return a.name.localeCompare(b.name, "fr");
        });
    }, [session, students, groups, attendanceByStudent, attendance]);

    const presentCount = rows.filter((r) => r.present).length;

    // Header click: ascending → descending → default sort.
    const sortedRows = useMemo(
        () =>
            sortRows(rows, spec, {
                name: (r) => r.name,
                student_number: (r) => r.studentNumber,
                group: (r) => r.groupName,
                present: (r) => (r.present ? 1 : 0),
                scanned_at: (r) => r.scannedAt,
            }),
        [rows, spec],
    );

    const sortedScans = useMemo(
        () =>
            sortRows(scans, scanSpec, {
                scanned_at: (r) => r.scanned_at,
                result: (r) => SCAN_RESULT_LABEL[r.result],
                student_name: (r) => r.student_name,
                uid: (r) => r.uid,
            }),
        [scans, scanSpec],
    );

    const rosterPagination = usePagination(rows.length);
    const scansPagination = usePagination(scans.length);

    // Server-side CSV export (authoritative data, identical to the report).
    const handleExport = async (): Promise<void> => {
        setExporting(true);
        try {
            await downloadSessionReportCsv(sessionId);
            push("success", "Export CSV téléchargé.");
        } catch (err) {
            push("danger", toUiMessage(err));
        } finally {
            setExporting(false);
        }
    };

    // Manual presence mark (teacher correction, running session): the
    // attendance row and the toast arrive via the attendance:scanned WebSocket
    // event (result "manual"), just like an RFID scan.
    const handleMarkPresent = async (studentId: number): Promise<void> => {
        setMarkingId(studentId);
        try {
            await markPresentManually(sessionId, studentId);
        } catch (err) {
            push("danger", toUiMessage(err));
        } finally {
            setMarkingId(null);
        }
    };

    const handleReset = async (): Promise<void> => {
        setResetting(true);
        try {
            await resetAttendance(sessionId);
            setAttendance([]);
            setConfirmReset(false);
            push("success", "Présences réinitialisées. L'historique des scans est conservé.");
        } catch (err) {
            push("danger", toUiMessage(err));
        } finally {
            setResetting(false);
        }
    };

    if (error !== null) {
        return (
            <div className="page">
                <ErrorState error={error} onRetry={load} text="Impossible de charger la session." />
            </div>
        );
    }
    if (!session || attendance === null) {
        return (
            <div className="page">
                <Loading text="Chargement de la session…" />
            </div>
        );
    }

    const groupsLabel =
        session.group_ids.length === 0
            ? null
            : session.group_ids.map((gid) => groups.find((g) => g.id === gid)?.name ?? `Groupe ${gid}`).join(", ");

    return (
        <div className="page">
            <p className="breadcrumbs">
                <Link to="/sessions">Sessions</Link> / {session.label}
            </p>

            <div className="page__header">
                <div>
                    <h1>{session.label}</h1>
                    <p className="page__subtitle">
                        {groupsLabel ?? "Tous les étudiants"} · Planifiée le {formatDateTime(session.scheduled_at)} ·{" "}
                        {session.duration_minutes} min
                    </p>
                </div>
                <div className="page__header-side">
                    <StatusBadge status={session.status} />
                    {session.series_id !== null && (
                        <Link
                            to="/sessions"
                            className="series-chip"
                            title="Occurrence d'une série récurrente — gérez « cette occurrence et les suivantes » depuis l'onglet Calendrier"
                        >
                            ↻ Série récurrente
                        </Link>
                    )}
                    {session.status === "scheduled" && (
                        <button className="btn" onClick={() => setEditing(true)}>
                            Modifier
                        </button>
                    )}
                    <button className="btn" onClick={() => void handleExport()} disabled={exporting}>
                        {exporting ? "Export…" : "Exporter en CSV"}
                    </button>
                    <SessionControls
                        session={session}
                        onUpdated={(s) => {
                            setSession(s);
                            load();
                        }}
                    />
                </div>
            </div>

            {session.started_at && <p className="session-times">Démarrée à {formatTime(session.started_at)}</p>}
            {session.group_ids.length > 0 && (
                <div className="report-summary">
                    <span className="report-pill report-pill--present">{presentCount} présent(s)</span>
                    <span className="report-pill report-pill--absent">{rows.length - presentCount} absent(s)</span>
                    <span className="report-pill">{rows.length} étudiant(s)</span>
                </div>
            )}

            <section className="card">
                <div className="card__header">
                    <h2 className="card__title">Présences</h2>
                    <button
                        className="btn btn--ghost"
                        onClick={() => setConfirmReset(true)}
                        disabled={session.status === "cancelled"}
                        title="Efface l'état de présence, conserve l'historique des scans"
                    >
                        Réinitialiser les présences
                    </button>
                </div>

                {rows.length === 0 ? (
                    <EmptyState
                        text={
                            session.group_ids.length === 0
                                ? "Aucun groupe associé — seuls les étudiants présents apparaîtront ici."
                                : "Aucun étudiant dans les groupes sélectionnés."
                        }
                    />
                ) : (
                    <>
                        <table className="table">
                            <thead>
                                <tr>
                                    <SortHeader label="Étudiant" sortKey="name" spec={spec} onSort={toggle} />
                                    <SortHeader label="Numéro" sortKey="student_number" spec={spec} onSort={toggle} />
                                    <SortHeader label="Groupe" sortKey="group" spec={spec} onSort={toggle} />
                                    <SortHeader label="Présence" sortKey="present" spec={spec} onSort={toggle} />
                                    <SortHeader label="Heure" sortKey="scanned_at" spec={spec} onSort={toggle} />
                                    {session.status === "running" && <th>Actions</th>}
                                </tr>
                            </thead>
                            <tbody>
                                {rosterPagination.slice(sortedRows).map((r) => (
                                    <tr key={r.studentId} className={r.present ? "row--present" : undefined}>
                                        <td>
                                            <Link to={`/students/${r.studentId}`}>{r.name}</Link>
                                        </td>
                                        <td>{r.studentNumber ?? "—"}</td>
                                        <td>{r.groupName ?? "—"}</td>
                                        <td>
                                            <span className={r.present ? "presence presence--yes" : "presence presence--no"}>
                                                {r.present ? "Présent(e)" : "Absent(e)"}
                                            </span>
                                        </td>
                                        <td>{r.present ? formatTime(r.scannedAt) : "—"}</td>
                                        {session.status === "running" && (
                                            <td>
                                                {!r.present && (
                                                    <button
                                                        className="btn btn--ghost btn--sm"
                                                        onClick={() => void handleMarkPresent(r.studentId)}
                                                        disabled={markingId !== null}
                                                        title="Marque la présence sans scan de carte (correction enseignant)"
                                                    >
                                                        {markingId === r.studentId ? "…" : "Marquer présent(e)"}
                                                    </button>
                                                )}
                                            </td>
                                        )}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        <PaginationBar pagination={rosterPagination} label="étudiant(s)" />
                    </>
                )}
            </section>

            <section className="card">
                <h2 className="card__title">Historique des scans</h2>
                {scans.length === 0 ? (
                    <EmptyState text="Aucun scan enregistré." />
                ) : (
                    <>
                        <table className="table">
                            <thead>
                                <tr>
                                    <SortHeader label="Heure" sortKey="scanned_at" spec={scanSpec} onSort={toggleScans} />
                                    <SortHeader label="Résultat" sortKey="result" spec={scanSpec} onSort={toggleScans} />
                                    <SortHeader label="Étudiant" sortKey="student_name" spec={scanSpec} onSort={toggleScans} />
                                    <SortHeader label="Carte (UID)" sortKey="uid" spec={scanSpec} onSort={toggleScans} />
                                </tr>
                            </thead>
                            <tbody>
                                {scansPagination.slice(sortedScans).map((row, i) => (
                                    <tr key={`${row.scanned_at}-${row.uid}-${i}`} className={`scan-row scan-row--${row.result}`}>
                                        <td>{formatTime(row.scanned_at)}</td>
                                        <td>{SCAN_RESULT_LABEL[row.result]}</td>
                                        <td>{row.student_name ?? "—"}</td>
                                        <td>{row.uid ?? "—"}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        <PaginationBar pagination={scansPagination} label="scan(s)" />
                    </>
                )}
            </section>

            {confirmReset && (
                <ConfirmDialog
                    title="Réinitialiser les présences"
                    message="Toutes les présences de cette session seront effacées. L'historique des scans est conservé. Cette action est irréversible."
                    confirmLabel="Réinitialiser"
                    danger
                    busy={resetting}
                    onConfirm={() => void handleReset()}
                    onCancel={() => setConfirmReset(false)}
                />
            )}

            {editing && (
                <Modal title={`Modifier — ${session.label}`} onClose={() => setEditing(false)} width="wide">
                    <SessionEditDialog
                        row={session}
                        onChanged={load}
                        onDone={() => setEditing(false)}
                    />
                </Modal>
            )}
        </div>
    );
}
