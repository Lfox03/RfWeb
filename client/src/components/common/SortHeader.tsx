// Clickable table header: asc → desc → no sort (the default server order).
import type { SortSpec } from "../../lib/sort";

interface SortHeaderProps<K extends string> {
    label: string;
    sortKey: K;
    spec: SortSpec<K> | null;
    onSort: (key: K) => void;
    className?: string;
}

export function SortHeader<K extends string>({ label, sortKey, spec, onSort, className }: SortHeaderProps<K>) {
    const active = spec?.key === sortKey;
    return (
        <th
            scope="col"
            className={`table__sortable${className ? ` ${className}` : ""}`}
            aria-sort={!active ? "none" : spec.dir === "asc" ? "ascending" : "descending"}
        >
            <button type="button" className="table__sort" onClick={() => onSort(sortKey)} title={`Trier par ${label.toLowerCase()}`}>
                {label}
                <span
                    className={`table__sort-icon${active ? " table__sort-icon--active" : ""}`}
                    aria-hidden="true"
                >
                    {active ? (spec.dir === "asc" ? "▲" : "▼") : "↕"}
                </span>
            </button>
        </th>
    );
}
