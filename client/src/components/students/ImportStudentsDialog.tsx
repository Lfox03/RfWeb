import { useState } from "react";
import type { ChangeEvent, FormEvent } from "react";

import { toUiMessage } from "../../api/client";
import { importStudentsCsv } from "../../api/students";
import type { StudentImportResult } from "../../api/students";
import { useToast } from "../../hooks/useToast";

const MAX_ERROR_LINES_SHOWN = 20;

interface ImportStudentsDialogProps {
    // Called when the dialog closes; imported count triggers a list refresh.
    onFinished: (imported: number) => void;
}

// Bulk student import from a CSV file (prénom, nom, groupe, email, id). The
// file is read client-side and sent as raw text/csv; the server parses it and
// returns per-line errors for the rows it skipped.
export function ImportStudentsDialog({ onFinished }: ImportStudentsDialogProps) {
    const { push } = useToast();
    const [file, setFile] = useState<File | null>(null);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<StudentImportResult | null>(null);

    const pickFile = (e: ChangeEvent<HTMLInputElement>): void => {
        setFile(e.target.files?.[0] ?? null);
        setResult(null);
    };

    const submit = async (e: FormEvent): Promise<void> => {
        e.preventDefault();
        if (!file || busy) return;
        setBusy(true);
        try {
            const res = await importStudentsCsv(await file.text());
            setResult(res);
            if (res.imported > 0) push("success", `${res.imported} étudiant(s) importé(s).`);
            else push("warning", "Aucun étudiant importé.");
        } catch (err) {
            push("danger", toUiMessage(err));
        } finally {
            setBusy(false);
        }
    };

    const close = (): void => {
        onFinished(result?.imported ?? 0);
    };

    return (
        <form className="form" onSubmit={(e) => void submit(e)}>
            <div className="field">
                <label htmlFor="import-csv-file">Fichier CSV</label>
                <input
                    id="import-csv-file"
                    type="file"
                    accept=".csv,text/csv"
                    onChange={pickFile}
                    disabled={busy || result !== null}
                />
            </div>

            <p className="muted import-csv__hint">
                Structure attendue : <code>prénom, nom, groupe, email, id</code> — une ligne d&apos;en-tête puis une
                ligne par étudiant. Seuls le prénom et le nom sont obligatoires ; un groupe inexistant est créé
                automatiquement ; « id » est le numéro de carte RFID, attribué à l&apos;étudiant.
            </p>

            {result === null ? (
                <div className="form__actions">
                    <button type="button" className="btn" onClick={close} disabled={busy}>
                        Annuler
                    </button>
                    <button type="submit" className="btn btn--primary" disabled={!file || busy}>
                        {busy ? "Import en cours…" : "Importer"}
                    </button>
                </div>
            ) : (
                <>
                    <p>
                        <strong>
                            {result.imported} étudiant(s) importé(s)
                            {result.skipped > 0 ? `, ${result.skipped} ligne(s) ignorée(s)` : ""}.
                        </strong>
                    </p>
                    {result.groups_created.length > 0 && (
                        <p className="muted">Groupe(s) créé(s) : {result.groups_created.join(", ")}.</p>
                    )}
                    {result.errors.length > 0 && (
                        <ul className="import-csv__errors">
                            {result.errors.slice(0, MAX_ERROR_LINES_SHOWN).map((issue) => (
                                <li key={`${issue.line}-${issue.message}`}>
                                    Ligne {issue.line} : {issue.message}
                                </li>
                            ))}
                            {result.errors.length > MAX_ERROR_LINES_SHOWN && (
                                <li className="muted">… et {result.errors.length - MAX_ERROR_LINES_SHOWN} autre(s).</li>
                            )}
                        </ul>
                    )}
                    <div className="form__actions">
                        <button type="button" className="btn btn--primary" onClick={close}>
                            Fermer
                        </button>
                    </div>
                </>
            )}
        </form>
    );
}
