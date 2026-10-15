// Header-click sort state: none → ascending → descending → none.

import { useCallback, useState } from "react";

import type { SortSpec } from "../lib/sort";

export interface SortState<K extends string> {
    spec: SortSpec<K> | null;
    toggle: (key: K) => void;
}

export function useSortState<K extends string>(): SortState<K> {
    const [spec, setSpec] = useState<SortSpec<K> | null>(null);
    const toggle = useCallback((key: K) => {
        setSpec((s) =>
            s === null || s.key !== key
                ? { key, dir: "asc" }
                : s.dir === "asc"
                  ? { key, dir: "desc" }
                  : null,
        );
    }, []);
    return { spec, toggle };
}
