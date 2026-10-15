import { useState } from "react";
import type { FormEvent } from "react";

import { createUser } from "../../api/users";
import { toUiMessage } from "../../api/client";
import { useToast } from "../../hooks/useToast";
import { ROLE_LABEL } from "../../lib/format";
import type { UserAccount, UserRole } from "../../types/domain";
import { Modal } from "../common/Modal";

// Mirrors the backend username rule (validate.ts vUsername) for instant
// feedback; the server remains authoritative.
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const PASSWORD_MIN = 8;

interface CreateUserDialogProps {
    onClose: () => void;
    onCreated: (user: UserAccount) => void;
}

// Admin dialog: create an application account. The password is sent once to
// the API (hashed server-side with scrypt) and kept in this form state only.
export function CreateUserDialog({ onClose, onCreated }: CreateUserDialogProps) {
    const { push } = useToast();
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [role, setRole] = useState<UserRole>("teacher");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async (e: FormEvent): Promise<void> => {
        e.preventDefault();
        const name = username.trim();
        if (!USERNAME_RE.test(name)) {
            setError("Nom d'utilisateur invalide : 3 à 32 caractères (lettres, chiffres, « . », « _ », « - »).");
            return;
        }
        if (password.length < PASSWORD_MIN) {
            setError(`Mot de passe invalide : au moins ${PASSWORD_MIN} caractères.`);
            return;
        }
        setError(null);
        setSaving(true);
        try {
            const created = await createUser(name, password, role);
            push("success", `Utilisateur « ${created.username} » créé.`);
            onCreated(created);
            onClose();
        } catch (err) {
            // USERNAME_TAKEN / VALIDATION_ERROR / FORBIDDEN come back in French.
            setError(toUiMessage(err));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal title="Ajouter un utilisateur" onClose={onClose}>
            <form className="form" onSubmit={(e) => void submit(e)}>
                <div className="field">
                    <label htmlFor="new-username">Nom d'utilisateur</label>
                    <input
                        id="new-username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        maxLength={32}
                        autoComplete="off"
                        autoFocus
                        required
                    />
                </div>
                <div className="field">
                    <label htmlFor="new-password">Mot de passe</label>
                    <input
                        id="new-password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        maxLength={200}
                        autoComplete="new-password"
                        required
                    />
                </div>
                <div className="field">
                    <label htmlFor="new-role">Rôle</label>
                    <select id="new-role" value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
                        <option value="teacher">{ROLE_LABEL.teacher}</option>
                        <option value="admin">{ROLE_LABEL.admin}</option>
                        <option value="kiosk">{ROLE_LABEL.kiosk}</option>
                    </select>
                    <p className="field__hint">
                        « {ROLE_LABEL.kiosk} » : compte de borne, accès exclusivement à la page de pointage (lecture
                        seule).
                    </p>
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
                        {saving ? "Création…" : "Créer"}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
