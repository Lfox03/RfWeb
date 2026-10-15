// Column-sort helpers shared by every table (click a header: asc → desc →
// no sort). Pure functions only — the React state lives in hooks/useSort.ts.

export type SortDir = "asc" | "desc";

export interface SortSpec<K extends string> {
    key: K;
    dir: SortDir;
}

// Values a column can sort on. null/undefined are always displayed last,
// whatever the direction (they mean « non renseigné », not an extreme).
export type Sortable = string | number | null | undefined;

export type SortGetters<T, K extends string> = Record<K, (row: T) => Sortable>;

function compareValues(a: NonNullable<Sortable>, b: NonNullable<Sortable>): number {
    if (typeof a === "number" && typeof b === "number") return a - b;
    // ISO-8601 timestamps sort correctly as strings; names need the French
    // collation (accents and case insensitive), numeric:true handles « G2 »
    // before « G10 ».
    return String(a).localeCompare(String(b), "fr", { numeric: true, sensitivity: "base" });
}

// Returns a new array sorted by spec, or the input untouched when spec is
// null (the « no sort » default state). Ties keep their original order.
export function sortRows<T, K extends string>(
    rows: T[],
    spec: SortSpec<K> | null,
    getters: SortGetters<T, K>,
): T[] {
    if (!spec) return rows;
    const get = getters[spec.key];
    const sign = spec.dir === "asc" ? 1 : -1;
    const indexed = rows.map((row, i) => [row, i] as const);
    indexed.sort((a, b) => {
        const va = get(a[0]);
        const vb = get(b[0]);
        if (va === null || va === undefined) {
            if (vb === null || vb === undefined) return a[1] - b[1];
            return 1;
        }
        if (vb === null || vb === undefined) return -1;
        const cmp = compareValues(va, vb);
        return cmp !== 0 ? sign * cmp : a[1] - b[1];
    });
    return indexed.map(([row]) => row);
}
