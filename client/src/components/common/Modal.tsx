import { useEffect } from "react";
import type { ReactNode } from "react";

interface ModalProps {
    title: string;
    onClose: () => void;
    children: ReactNode;
    width?: "normal" | "wide";
}

// Lightweight modal dialog (no dependency): overlay + Escape handling.
export function Modal({ title, onClose, children, width = "normal" }: ModalProps) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    return (
        <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
            <div
                className={`modal ${width === "wide" ? "modal--wide" : ""}`}
                role="dialog"
                aria-modal="true"
                aria-label={title}
            >
                <header className="modal__header">
                    <h2>{title}</h2>
                    <button className="modal__close" onClick={onClose} aria-label="Fermer">
                        ×
                    </button>
                </header>
                <div className="modal__body">{children}</div>
            </div>
        </div>
    );
}
