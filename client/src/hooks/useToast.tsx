// Small non-intrusive toast notifications (scan feedback, action results).
// Provider renders the stack; components call useToast().push(...).

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

export type ToastKind = "success" | "info" | "warning" | "danger";

export interface Toast {
    id: number;
    kind: ToastKind;
    text: string;
}

interface ToastContextValue {
    push: (kind: ToastKind, text: string) => void;
    dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const AUTO_DISMISS_MS = 4_500;

const KIND_SYMBOL: Record<ToastKind, string> = {
    success: "✓",
    info: "ℹ",
    warning: "⚠",
    danger: "✕",
};

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);
    const nextId = useRef(1);

    const dismiss = useCallback((id: number) => {
        setToasts((list) => list.filter((t) => t.id !== id));
    }, []);

    const push = useCallback(
        (kind: ToastKind, text: string) => {
            const id = nextId.current++;
            setToasts((list) => [...list.slice(-4), { id, kind, text }]);
            setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
        },
        [dismiss],
    );

    const value = useMemo<ToastContextValue>(() => ({ push, dismiss }), [push, dismiss]);

    return (
        <ToastContext.Provider value={value}>
            {children}
            <div className="toasts" aria-live="polite" aria-atomic="false">
                {toasts.map((toast) => (
                    <div key={toast.id} className={`toast toast--${toast.kind}`} role="status">
                        <span className="toast__icon" aria-hidden="true">
                            {KIND_SYMBOL[toast.kind]}
                        </span>
                        <span className="toast__text">{toast.text}</span>
                        <button className="toast__close" onClick={() => dismiss(toast.id)} aria-label="Fermer">
                            ×
                        </button>
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
}

export function useToast(): ToastContextValue {
    const ctx = useContext(ToastContext);
    if (!ctx) throw new Error("useToast must be used inside ToastProvider");
    return ctx;
}
