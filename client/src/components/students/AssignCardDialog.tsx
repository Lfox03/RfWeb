import { useState } from "react";

import { assignCard } from "../../api/students";
import { nextCard } from "../../api/reader";
import { ApiError, toUiMessage } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { fullName } from "../../lib/format";
import type { CardWithStudentRow, StudentWithCardRow } from "../../types/domain";
import { Modal } from "../common/Modal";

interface AssignCardDialogProps {
    student: StudentWithCardRow;
    onClose: () => void;
    onAssigned: (card: CardWithStudentRow) => void;
}

// Assign-or-replace an RFID card for a student. Two input paths:
//   1. "Présenter une carte" → server one-shot read (POST /reader/next-card);
//   2. manual UID entry (decimal number).
// The browser never touches the hardware directly.
export function AssignCardDialog({ student, onClose, onAssigned }: AssignCardDialogProps) {
    const { push } = useToast();
    const [uid, setUid] = useState("");
    const [probing, setProbing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const hasCurrent = student.card_uid !== null;

    const probe = async (): Promise<void> => {
        setError(null);
        setProbing(true);
        try {
            const probe = await nextCard();
            setUid(probe.uid);
        } catch (err) {
            if (err instanceof ApiError && err.code === "READER_TIMEOUT") {
                setError("Aucune carte détectée. Réessayez ou saisissez le numéro manuellement.");
            } else if (err instanceof ApiError && err.code === "READER_OFFLINE") {
                setError("Lecteur RFID hors ligne. Saisissez le numéro de carte manuellement.");
            } else if (err instanceof ApiError && err.code === "READER_BUSY") {
                setError("Le lecteur est occupé par une session en cours. Saisissez le numéro manuellement.");
            } else {
                setError(toUiMessage(err));
            }
        } finally {
            setProbing(false);
        }
    };

    const submit = async (): Promise<void> => {
        const value = uid.trim();
        if (!/^\d+$/.test(value)) {
            setError("Le numéro de carte doit contenir uniquement des chiffres.");
            return;
        }
        setError(null);
        setSaving(true);
        try {
            const card = await assignCard(student.id, value);
            push("success", `Carte ${card.uid} associée.`);
            onAssigned(card);
            onClose();
        } catch (err) {
            // Conflicts (already assigned to someone else) come back in French.
            setError(toUiMessage(err));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal title="Associer une carte RFID" onClose={onClose}>
            {hasCurrent && (
                <p className="dialog-note">
                    Cet étudiant possède déjà la carte <strong>{student.card_uid}</strong>. En associer une nouvelle
                    retirera l'ancienne (l'historique est conservé).
                </p>
            )}

            <div className="probe">
                <div className={`probe__status ${probing ? "probe__status--active" : ""}`} aria-live="polite">
                    {probing ? (
                        <>
                            <span className="probe__pulse" aria-hidden="true" />
                            En attente d'une carte… Présentez une carte au lecteur.
                        </>
                    ) : (
                        "Présentez une carte au lecteur, ou saisissez le numéro manuellement."
                    )}
                </div>
                <button className="btn" onClick={() => void probe()} disabled={probing || saving}>
                    {probing ? "Lecture en cours…" : "Présenter une carte"}
                </button>
            </div>

            <div className="field">
                <label htmlFor="card-uid">Numéro de carte (UID)</label>
                <input
                    id="card-uid"
                    value={uid}
                    onChange={(e) => setUid(e.target.value.replace(/\D/g, ""))}
                    inputMode="numeric"
                    placeholder="Ex. 9000001"
                    disabled={probing || saving}
                />
            </div>

            {error && <p className="form-error" role="alert">{error}</p>}

            <div className="form__actions">
                <button className="btn" onClick={onClose} disabled={saving}>
                    Annuler
                </button>
                <button
                    className="btn btn--primary"
                    onClick={() => void submit()}
                    disabled={saving || probing || !uid.trim()}
                >
                    {saving ? "Association…" : `Associer à ${fullName(student.first_name, student.last_name)}`}
                </button>
            </div>
        </Modal>
    );
}
