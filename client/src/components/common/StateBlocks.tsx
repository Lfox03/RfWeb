import { toUiMessage } from "../../api/client";

// Shared async-state blocks so every screen behaves the same: loading,
// empty, and error with retry.

export function Loading({ text = "Chargement…" }: { text?: string }) {
    return (
        <div className="state state--loading" role="status" aria-live="polite">
            <span className="state__spinner" aria-hidden="true" />
            <span>{text}</span>
        </div>
    );
}

export function EmptyState({ text }: { text: string }) {
    return <div className="state state--empty">{text}</div>;
}

interface ErrorStateProps {
    error: unknown;
    onRetry?: () => void;
    text?: string;
}

export function ErrorState({ error, onRetry, text = "Impossible de charger les données." }: ErrorStateProps) {
    console.debug("[UI] Error state:", error);
    return (
        <div className="state state--error" role="alert">
            <p className="state__message">
                {text}
                <br />
                <span className="state__detail">{toUiMessage(error)}</span>
            </p>
            {onRetry && (
                <button className="btn" onClick={onRetry}>
                    Réessayer
                </button>
            )}
        </div>
    );
}
