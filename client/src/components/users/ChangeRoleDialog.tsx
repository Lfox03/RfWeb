import { useState } from "react";
import type { FormEvent } from "react";

import { changeUserRole } from "../../api/users";
import { toUiMessage } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { ROLE_LABEL } from "../../lib/format";
import type { UserAccount, UserRole } from "../../types/domain";
import { Modal } from "../common/Modal";

interface ChangeRoleDialogProps {
    target: UserAccount;
    onClose: () => void;
    onChanged: (user: UserAccount) => void;
}

// Admin dialog: change another administrator/teacher's role. The server also
// refuses self-role-changes (SELF_ROLE_CHANGE) — the page never opens this
// dialog for the current user, this is the explicit confirmation step.
export function ChangeRoleDialog({ target, onClose, onChanged }: ChangeRoleDialogProps) {
    const { push } = useToast();
    const [role, setRole] = useState<UserRole>(target.role);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async (e: FormEvent): Promise<void> => {
        e.preventDefault();
        if (role === target.role) {
            onClose();
            return;
        }
        setError(null);
        setSaving(true);
        try {
            const updated = await changeUserRole(target.id, role);
            push("success", `Rôle de « ${updated.username} » modifié : ${ROLE_LABEL[updated.role]}.`);
            onChanged(updated);
            onClose();
        } catch (err) {
            setError(toUiMessage(err));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal title="Changer le rôle" onClose={onClose}>
            <form className="form" onSubmit={(e) => void submit(e)}>
                <p className="dialog-note">
                    Rôle de <strong>{target.username}</strong> — le changement est appliqué immédiatement aux sessions
                    en cours de cet utilisateur.
                </p>
                <div className="field">
                    <label htmlFor="role-select">Rôle</label>
                    <select id="role-select" value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
                        <option value="teacher">{ROLE_LABEL.teacher}</option>
                        <option value="admin">{ROLE_LABEL.admin}</option>
                        <option value="kiosk">{ROLE_LABEL.kiosk}</option>
                    </select>
                    {role === "kiosk" && (
                        <p className="field__hint">
                            Le compte ne pourra plus ouvrir le tableau de bord : uniquement la page de pointage (lecture
                            seule).
                        </p>
                    )}
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
                    <button type="submit" className="btn btn--primary" disabled={saving || role === target.role}>
                        {saving ? "Enregistrement…" : "Enregistrer"}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
