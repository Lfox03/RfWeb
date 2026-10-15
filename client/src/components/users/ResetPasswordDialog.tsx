import { useState } from "react";
import type { FormEvent } from "react";

import { resetUserPassword } from "../../api/users";
import { toUiMessage } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import type { UserAccount } from "../../types/domain";
import { Modal } from "../common/Modal";

const PASSWORD_MIN = 8;

interface ResetPasswordDialogProps {
    target: UserAccount;
    isSelf: boolean;
    onClose: () => void;
    onSaved: () => void;
}

// Admin password reset. The current password is never requested (the admin
// is already authenticated) and never displayed. The confirmation field is a
// client-side convenience only — the server re-validates the new password.
export function ResetPasswordDialog({ target, isSelf, onClose, onSaved }: ResetPasswordDialogProps) {
    const { push } = useToast();
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async (e: FormEvent): Promise<void> => {
        e.preventDefault();
        if (password.length < PASSWORD_MIN) {
            setError(`Mot de passe invalide : au moins ${PASSWORD_MIN} caractères.`);
            return;
        }
        if (password !== confirm) {
            setError("Les mots de passe ne correspondent pas.");
            return;
        }
        setError(null);
        setSaving(true);
        try {
            await resetUserPassword(target.id, password);
            // Plaintext leaves this component's state as soon as the call ends.
            setPassword("");
            setConfirm("");
            push("success", isSelf ? "Votre mot de passe a été modifié." : `Mot de passe de « ${target.username} » modifié.`);
            onSaved();
            onClose();
        } catch (err) {
            setError(toUiMessage(err));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal title="Modifier le mot de passe" onClose={onClose}>
            <form className="form" onSubmit={(e) => void submit(e)}>
                <p className="dialog-note">
                    Mot de passe de <strong>{target.username}</strong>.
                    {isSelf
                        ? " Les autres sessions ouvertes avec ce compte seront fermées ; votre session actuelle reste active."
                        : " Les sessions actuellement ouvertes de cet utilisateur seront fermées."}
                </p>
                <div className="field">
                    <label htmlFor="pwd-new">Nouveau mot de passe</label>
                    <input
                        id="pwd-new"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        maxLength={200}
                        autoComplete="new-password"
                        autoFocus
                        required
                    />
                </div>
                <div className="field">
                    <label htmlFor="pwd-confirm">Confirmer le mot de passe</label>
                    <input
                        id="pwd-confirm"
                        type="password"
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                        maxLength={200}
                        autoComplete="new-password"
                        required
                    />
                </div>

                {error && (
                    <p className="form-error" role="alert">
                        {error}
                    </p>
                )}

                <div className="form__actions">
                    <button type="button" className="btn" onClick={onClose} disabled={saving}>
                        Annuler
                    </button>
                    <button type="submit" className="btn btn--primary" disabled={saving}>
                        {saving ? "Enregistrement…" : "Modifier"}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
