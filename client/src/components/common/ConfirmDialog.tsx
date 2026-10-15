import { useState } from "react";
import { Modal } from "./Modal";

interface ConfirmDialogProps {
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
    busy?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}

// Destructive-action confirmation. The caller decides whether to keep the
// dialog mounted while the action runs (busy) — see call sites.
export function ConfirmDialog({
    title,
    message,
    confirmLabel = "Confirmer",
    danger = false,
    busy = false,
    onConfirm,
    onCancel,
}: ConfirmDialogProps) {
    const [submitting, setSubmitting] = useState(false);
    const disabled = busy || submitting;

    return (
        <Modal title={title} onClose={onCancel}>
            <p className="confirm__message">{message}</p>
            <div className="confirm__actions">
                <button className="btn" onClick={onCancel} disabled={disabled}>
                    Annuler
                </button>
                <button
                    className={`btn ${danger ? "btn--danger" : "btn--primary"}`}
                    onClick={() => {
                        setSubmitting(true);
                        onConfirm();
                    }}
                    disabled={disabled}
                >
                    {confirmLabel}
                </button>
            </div>
        </Modal>
    );
}
