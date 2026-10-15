import { useState } from "react";

import { cancelSession, startSession, stopSession } from "../../api/sessions";
import { toUiMessage } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import type { SessionWithGroups } from "../../types/domain";

interface SessionControlsProps {
    session: SessionWithGroups;
    onUpdated: (session: SessionWithGroups) => void;
}

// Session lifecycle controls. Buttons follow the backend state machine
// (scheduled→running→completed, scheduled/running→cancelled) so no invalid
// transition is offered. The backend stays authoritative; a 409 is surfaced
// cleanly via a toast.
export function SessionControls({ session, onUpdated }: SessionControlsProps) {
    const { push } = useToast();
    const [busy, setBusy] = useState<string | null>(null);

    const run = async (action: "start" | "stop" | "cancel"): Promise<void> => {
        setBusy(action);
        try {
            const updated =
                action === "start"
                    ? await startSession(session.id)
                    : action === "stop"
                      ? await stopSession(session.id)
                      : await cancelSession(session.id);
            onUpdated(updated);
        } catch (err) {
            push("danger", toUiMessage(err));
        } finally {
            setBusy(null);
        }
    };

    if (session.status === "completed" || session.status === "cancelled") {
        return <p className="controls-hint">Session terminée — aucune action disponible.</p>;
    }

    return (
        <div className="controls">
            {session.status === "scheduled" && (
                <button className="btn btn--primary" onClick={() => void run("start")} disabled={busy !== null}>
                    {busy === "start" ? "Démarrage…" : "Démarrer"}
                </button>
            )}
            {session.status === "running" && (
                <button className="btn btn--danger" onClick={() => void run("stop")} disabled={busy !== null}>
                    {busy === "stop" ? "Arrêt…" : "Arrêter"}
                </button>
            )}
            <button
                className="btn btn--ghost"
                onClick={() => void run("cancel")}
                disabled={busy !== null}
                title="Annuler la session"
            >
                {busy === "cancel" ? "Annulation…" : "Annuler"}
            </button>
        </div>
    );
}
