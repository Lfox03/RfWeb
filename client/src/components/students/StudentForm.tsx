import { useState } from "react";
import type { FormEvent } from "react";

import type { GroupRow, StudentWithCardRow } from "../../types/domain";
import type { StudentInput } from "../../api/students";

interface StudentFormProps {
    groups: GroupRow[];
    initial?: StudentWithCardRow | null;
    busy?: boolean;
    onSubmit: (values: StudentInput) => void;
    onCancel: () => void;
}

// Create/edit student. Empty optional fields are submitted as null (backend
// clears them on PATCH). The card is managed separately (assign workflow).
export function StudentForm({ groups, initial, busy, onSubmit, onCancel }: StudentFormProps) {
    const [firstName, setFirstName] = useState(initial?.first_name ?? "");
    const [lastName, setLastName] = useState(initial?.last_name ?? "");
    const [studentNumber, setStudentNumber] = useState(initial?.student_number ?? "");
    const [groupId, setGroupId] = useState<string>(initial?.group_id != null ? String(initial.group_id) : "");
    const [email, setEmail] = useState(initial?.email ?? "");

    const handleSubmit = (e: FormEvent): void => {
        e.preventDefault();
        const trimmed = firstName.trim();
        if (!trimmed) return;
        onSubmit({
            firstName: trimmed,
            lastName: lastName.trim() || null,
            studentNumber: studentNumber.trim() || null,
            groupId: groupId === "" ? null : Number(groupId),
            email: email.trim() || null,
        });
    };

    return (
        <form className="form" onSubmit={handleSubmit}>
            <div className="field-row">
                <div className="field">
                    <label htmlFor="st-first">Prénom</label>
                    <input id="st-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} required maxLength={100} autoFocus />
                </div>
                <div className="field">
                    <label htmlFor="st-last">Nom</label>
                    <input id="st-last" value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={100} />
                </div>
            </div>

            <div className="field-row">
                <div className="field">
                    <label htmlFor="st-number">Numéro étudiant</label>
                    <input id="st-number" value={studentNumber} onChange={(e) => setStudentNumber(e.target.value)} maxLength={50} />
                </div>
                <div className="field">
                    <label htmlFor="st-group">Groupe</label>
                    <select id="st-group" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                        <option value="">Aucun</option>
                        {groups.map((g) => (
                            <option key={g.id} value={g.id}>
                                {g.name}
                            </option>
                        ))}
                    </select>
                </div>
            </div>

            <div className="field">
                <label htmlFor="st-email">E-mail</label>
                <input id="st-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} />
            </div>

            <div className="form__actions">
                <button type="button" className="btn" onClick={onCancel} disabled={busy}>
                    Annuler
                </button>
                <button type="submit" className="btn btn--primary" disabled={busy || !firstName.trim()}>
                    {initial ? "Enregistrer" : "Créer l'étudiant"}
                </button>
            </div>
        </form>
    );
}
