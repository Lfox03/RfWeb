// Client-side pagination state for tables: the API still returns every row,
// only one page is displayed. Pure state — the rendered bar lives in
// components/common/PaginationBar.tsx.

import { useCallback, useEffect, useState } from "react";

export const PAGE_SIZES = [10, 25, 50, 100];
export const DEFAULT_PAGE_SIZE = 25;

export interface Pagination {
    /** 1-based, always within 1…pageCount. */
    page: number;
    pageSize: number;
    pageCount: number;
    total: number;
    /** 1-based index of the first visible row (0 when the table is empty). */
    from: number;
    /** 1-based index of the last visible row. */
    to: number;
    setPage: (page: number) => void;
    setPageSize: (pageSize: number) => void;
    /** Back to page 1 — call it whenever the filter/sort inputs change. */
    reset: () => void;
    /** Rows of the current page (the input is the full sorted list). */
    slice: <T>(rows: T[]) => T[];
}

export function usePagination(total: number): Pagination {
    const [page, setPageState] = useState(1);
    const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE);

    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    // A narrower filter (or deleted rows) can leave the user past the last
    // page: display the last page immediately, then resync the state.
    const visiblePage = Math.min(page, pageCount);
    useEffect(() => {
        if (page > pageCount) setPageState(pageCount);
    }, [page, pageCount]);

    const setPage = useCallback((next: number): void => {
        setPageState(Math.max(1, next));
    }, []);

    const setPageSize = useCallback((size: number): void => {
        setPageSizeState(size);
        setPageState(1);
    }, []);

    const reset = useCallback((): void => setPageState(1), []);

    const slice = useCallback(
        <T>(rows: T[]): T[] =>
            rows.length <= pageSize ? rows : rows.slice((visiblePage - 1) * pageSize, visiblePage * pageSize),
        [visiblePage, pageSize],
    );

    const from = total === 0 ? 0 : (visiblePage - 1) * pageSize + 1;
    const to = Math.min(total, visiblePage * pageSize);

    return { page: visiblePage, pageSize, pageCount, total, from, to, setPage, setPageSize, reset, slice };
}
