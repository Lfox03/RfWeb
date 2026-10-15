import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { beep, nextCard } from "../api/reader";
import { ApiError, toUiMessage } from "../api/client";
import { getCard } from "../api/cards";
import { listGroups } from "../api/groups";
import {
    createSession,
    getActiveSession,
    listAttendance,
    listScans,
} from "../api/sessions";
import { listStudents } from "../api/students";
import { useWebSocket } from "../hooks/useWebSocket";
import { useToast } from "../hooks/useToast";
import { formatDate, formatDateTime, formatTime, fullName, SCAN_RESULT_LABEL } from "../lib/format";
import type {
    CardWithStudentRow,
    GroupRow,
    SessionScanRow,
    SessionWithGroups,
} from "../types/domain";
import type { ServerEvent } from "../types/websocket";
import { Loading, ErrorState, EmptyState } from "../components/common/StateBlocks";
import { Modal } from "../components/common/Modal";
import { StatusBadge } from "../components/common/StatusBadge";
import { SessionForm } from "../components/sessions/SessionForm";
import type { SessionFormValues } from "../components/sessions/SessionForm";
import { SessionControls } from "../components/sessions/SessionControls";

interface DashboardData {
    attendanceCount: number;
    totalStudents: number | null;
    scans: SessionScanRow[];
}

// Card test result (dashboard): scanned UID + associated card
// (null = card never registered → "unknown").
interface CardTestResult {
    uid: string;
    hexId: string | null;
    card: CardWithStudentRow | null;
}

export function DashboardPage() {
    const { readerOnline, activeSession, epoch, subscribe } = useWebSocket();
    const { push } = useToast();

    const [groups, setGroups] = useState<GroupRow[] | null>(null);
    const [groupsError, setGroupsError] = useState<unknown>(null);
    const [creating, setCreating] = useState(false);
    const [busy, setBusy] = useState(false);
    const [beeping, setBeeping] = useState(false);
    const [scanning, setScanning] = useState(false);
    const [cardTest, setCardTest] = useState<CardTestResult | null>(null);
    const [data, setData] = useState<DashboardData | null>(null);
    const [session, setSession] = useState<SessionWithGroups | null>(activeSession);

    const sessionId = session?.id ?? null;

    const loadGroups = useCallback((): void => {
        setGroupsError(null);
        listGroups()
            .then((res) => setGroups(res.rows))
            .catch((err) => setGroupsError(err));
    }, []);

    // Load the active session explicitly (the WS snapshot may arrive later
    // than the page mount; HTTP gives an immediate first paint).
    useEffect(() => {
        getActiveSession()
            .then((s) => setSession((prev) => prev ?? s))
            .catch((err) => console.debug("[DASH] Failed to load active session:", err));
    }, [epoch]);

    // Keep in sync with WS lifecycle events.
    useEffect(() => {
        if (activeSession) setSession(activeSession);
        else if (activeSession === null && epoch > 0) setSession(null);
    }, [activeSession, epoch]);

    // Attendance count + recent scans for the active session. The expected
    // roster size FOLLOWS the session's groups: sum of the checked groups'
    // effectifs (a student belongs to exactly one group, so the union count
    // is the sum), or all students when the session has no group.
    const groupIds = session?.group_ids ?? [];
    const groupIdsKey = groupIds.join(",");
    useEffect(() => {
        if (!sessionId) {
            setData(null);
            return;
        }
        let cancelled = false;
        void (async () => {
            try {
                const [att, scans, students] = await Promise.all([
                    listAttendance(sessionId),
                    listScans(sessionId),
                    groupIds.length > 0 ? Promise.resolve(null) : listStudents(),
                ]);
                if (cancelled) return;
                const totalStudents =
                    groupIds.length > 0 && groups
                        ? groupIds.reduce(
                              (sum, id) => sum + (groups.find((g) => g.id === id)?.student_count ?? 0),
                              0,
                          )
                        : students?.rows.length ?? null;
                setData({
                    attendanceCount: att.rows.length,
                    totalStudents,
                    scans: scans.rows.slice(-8).reverse(),
                });
            } catch (err) {
                console.debug("[DASH] Failed to load session stats:", err);
            }
        })();
        return () => {
            cancelled = true;
        };
        // groupIdsKey/groups: the roster size depends on the session's groups.
    }, [sessionId, epoch, groupIdsKey, groups]);

    // Live scan feed + presence counter updates without a full reload.
    useEffect(() => {
        return subscribe((event: ServerEvent) => {
            if (event.event === "attendance:scanned" && event.content.sessionId === sessionId) {
                const c = event.content;
                const row: SessionScanRow = {
                    scan_id: -c.scannedAt.length,
                    student_id: c.studentId,
                    student_name: c.studentName,
                    uid: c.uid,
                    result: c.result,
                    scanned_at: c.scannedAt,
                };
                setData((d) =>
                    d
                        ? {
                              ...d,
                              attendanceCount:
                                  c.result === "accepted" || c.result === "manual"
                                      ? d.attendanceCount + 1
                                      : d.attendanceCount,
                              scans: [row, ...d.scans].slice(0, 8),
                          }
                        : d,
                );
            }
        });
    }, [subscribe, sessionId]);

    useEffect(() => {
        loadGroups();
    }, [loadGroups]);

    const groupsLabel = (ids: number[]): string =>
        ids.length === 0
            ? "Tous les étudiants"
            : ids.map((id) => groups?.find((g) => g.id === id)?.name ?? `Groupe ${id}`).join(", ");

    const handleCreate = async (values: SessionFormValues): Promise<void> => {
        setBusy(true);
        try {
            const created = await createSession(values);
            setSession(created);
            setCreating(false);
            push("success", "Session créée.");
        } catch (err) {
            push("danger", toUiMessage(err));
        } finally {
            setBusy(false);
        }
    };

    const handleBeep = async (): Promise<void> => {
        setBeeping(true);
        try {
            await beep();
        } catch (err) {
            push("warning", toUiMessage(err));
        } finally {
            setBeeping(false);
        }
    };

    // Card test: reads a card on the reader then displays its association
    // (student number, holder, status). 404 card → "unknown".
    const handleScanCard = async (): Promise<void> => {
        setScanning(true);
        setCardTest(null);
        try {
            const probe = await nextCard();
            try {
                const card = await getCard(probe.uid);
                setCardTest({ uid: probe.uid, hexId: probe.hexId ?? null, card });
            } catch (err) {
                if (err instanceof ApiError && err.status === 404) {
                    setCardTest({ uid: probe.uid, hexId: probe.hexId ?? null, card: null });
                } else {
                    throw err;
                }
            }
        } catch (err) {
            // 504 (no card presented) is a normal outcome of the test, not an
            // error: informational toast; the others (busy/offline) are still
            // reported.
            push(err instanceof ApiError && err.code === "READER_TIMEOUT" ? "info" : "danger", toUiMessage(err));
        } finally {
            setScanning(false);
        }
    };

    const scanLabel = (row: SessionScanRow): string => {
        const who = row.student_name ?? `Carte ${row.uid ?? "?"}`;
        return `${who} — ${SCAN_RESULT_LABEL[row.result]}`;
    };

    return (
        <div className="page">
            <div className="page__header">
                <h1>Tableau de bord</h1>
                <button className="btn btn--primary" onClick={() => setCreating(true)}>
                    Nouvelle session
                </button>
            </div>

            <div className="cards">
                <section className="card">
                    <h2 className="card__title">Lecteur RFID</h2>
                    <p className={`reader-state ${readerOnline ? "reader-state--ok" : "reader-state--off"}`}>
                        <span className="indicator__dot" aria-hidden="true" />
                        {readerOnline === null ? "État inconnu…" : readerOnline ? "Connecté" : "Déconnecté"}
                    </p>
                    <button className="btn btn--ghost" onClick={() => void handleBeep()} disabled={beeping || readerOnline === false}>
                        {beeping ? "Test en cours…" : "Tester le bip"}
                    </button>
                </section>

                <section className="card">
                    <h2 className="card__title">Test de carte</h2>
                    <p className="cardtest__hint">
                        {session
                            ? "Indisponible pendant qu'une session utilise le lecteur."
                            : ""}
                    </p>
                    <button
                        className="btn"
                        onClick={() => void handleScanCard()}
                        disabled={scanning || readerOnline === false || session !== null}
                    >
                        {scanning ? "Lecture en cours — présentez la carte…" : "Tester une carte"}
                    </button>
                    {cardTest && (
                        <div className={`cardtest__result${cardTest.card === null ? " cardtest__result--unknown" : ""}`}>
                            <p className="cardtest__uid">
                                Carte lue : <code className="uid">{cardTest.uid}</code>
                                {cardTest.hexId && <span className="muted"> (hex {cardTest.hexId})</span>}
                            </p>
                            {cardTest.card === null ? (
                                <p className="cardtest__unknown">Carte inconnue — jamais enregistrée dans le système.</p>
                            ) : (
                                <>
                                    <p className="cardtest__row">
                                        <span className="cardtest__label">Statut</span>
                                        {cardTest.card.revoked_at === null ? (
                                            <span className="cardtest__ok">Active</span>
                                        ) : (
                                            <span className="cardtest__ko">Retirée le {formatDate(cardTest.card.revoked_at)}</span>
                                        )}
                                    </p>
                                    {cardTest.card.student ? (
                                        <>
                                            <p className="cardtest__row">
                                                <span className="cardtest__label">Associée à</span>
                                                <Link to={`/students/${cardTest.card.student.id}`} className="table__link">
                                                    {fullName(cardTest.card.student.first_name, cardTest.card.student.last_name)}
                                                </Link>
                                            </p>
                                            <p className="cardtest__row">
                                                <span className="cardtest__label">Numéro étudiant</span>
                                                {cardTest.card.student.student_number ?? "—"}
                                            </p>
                                            <p className="cardtest__row">
                                                <span className="cardtest__label">Groupe</span>
                                                {cardTest.card.student.group_id === null
                                                    ? "—"
                                                    : groups?.find((g) => g.id === cardTest.card?.student?.group_id)?.name ??
                                                      `Groupe ${cardTest.card.student.group_id}`}
                                            </p>
                                        </>
                                    ) : (
                                        <p className="cardtest__unknown">Aucune personne associée (carte en stock).</p>
                                    )}
                                </>
                            )}
                        </div>
                    )}
                </section>

                <section className="card card--wide">
                    <h2 className="card__title">Session active</h2>
                    {session === null ? (
                        <EmptyState text="Aucune session active." />
                    ) : (
                        <>
                            <div className="session-summary">
                                <div>
                                    <p className="session-summary__label">{session.label}</p>
                                    <p className="session-summary__meta">
                                        {groupsLabel(session.group_ids)} ·{" "}
                                        {formatDateTime(session.started_at ?? session.scheduled_at)}
                                    </p>
                                </div>
                                <StatusBadge status={session.status} />
                            </div>
                            {data ? (
                                <p className="session-summary__count">
                                    {data.attendanceCount}
                                    {data.totalStudents !== null ? ` / ${data.totalStudents}` : ""} étudiant(s) présent(s)
                                </p>
                            ) : (
                                <Loading text="Chargement des présences…" />
                            )}
                            <SessionControls session={session} onUpdated={setSession} />
                        </>
                    )}
                </section>
            </div>

            <section className="card">
                <h2 className="card__title">Derniers scans</h2>
                {!session ? (
                    <EmptyState text="Aucune session active — les scans s'afficheront ici." />
                ) : !data ? (
                    <Loading text="Chargement des scans…" />
                ) : data.scans.length === 0 ? (
                    <EmptyState text="Aucun scan pour le moment." />
                ) : (
                    <ul className="scan-feed">
                        {data.scans.map((row, i) => (
                            <li key={`${row.scanned_at}-${row.uid}-${i}`} className={`scan-feed__item scan-feed__item--${row.result}`}>
                                <span className="scan-feed__time">{formatTime(row.scanned_at)}</span>
                                <span className="scan-feed__text">{scanLabel(row)}</span>
                            </li>
                        ))}
                    </ul>
                )}
                {session && (
                    <p className="card__footer">
                        <Link to={`/sessions/${session.id}`}>Voir le détail de la session →</Link>
                    </p>
                )}
            </section>

            {groupsError !== null && (
                <ErrorState error={groupsError} onRetry={loadGroups} text="Impossible de charger les groupes." />
            )}

            {groups === null && groupsError === null && <Loading text="Chargement des groupes…" />}

            {creating && (
                <Modal title="Nouvelle session" onClose={() => setCreating(false)}>
                    <SessionForm
                        groups={groups ?? []}
                        busy={busy}
                        onSubmit={(v) => void handleCreate(v)}
                        onCancel={() => setCreating(false)}
                    />
                </Modal>
            )}
        </div>
    );
}
