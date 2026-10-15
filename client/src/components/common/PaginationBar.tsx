// Pagination bar rendered under a table: number of visible rows selector +
// previous/next navigation. Self-hides when the list fits in the smallest
// page size (no point cluttering small tables).
import { PAGE_SIZES, type Pagination } from "../../hooks/usePagination";

interface PaginationBarProps {
    pagination: Pagination;
    /** Plural noun appended to the count, e.g. « étudiant(s) ». */
    label?: string;
}

export function PaginationBar({ pagination, label }: PaginationBarProps) {
    const { page, pageSize, pageCount, total, from, to, setPage, setPageSize } = pagination;
    if (total <= PAGE_SIZES[0]) return null;
    return (
        <nav className="pagination" aria-label="Pagination du tableau">
            <span className="pagination__info">
                Affichage {from}–{to} sur {total}
                {label ? ` ${label}` : ""}
            </span>
            <div className="pagination__controls">
                <label className="pagination__size">
                    Lignes
                    <select
                        value={pageSize}
                        onChange={(e) => setPageSize(Number(e.target.value))}
                        aria-label="Nombre de lignes affichées"
                    >
                        {PAGE_SIZES.map((n) => (
                            <option key={n} value={n}>
                                {n}
                            </option>
                        ))}
                    </select>
                </label>
                {pageCount > 1 && (
                    <div className="pagination__nav">
                        <button
                            type="button"
                            className="btn btn--sm"
                            onClick={() => setPage(page - 1)}
                            disabled={page <= 1}
                        >
                            ← Précédent
                        </button>
                        <span className="pagination__page">
                            Page {page} / {pageCount}
                        </span>
                        <button
                            type="button"
                            className="btn btn--sm"
                            onClick={() => setPage(page + 1)}
                            disabled={page >= pageCount}
                        >
                            Suivant →
                        </button>
                    </div>
                )}
            </div>
        </nav>
    );
}
