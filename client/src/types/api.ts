// Response envelopes produced by the Phase 3 backend (server/src/api/http.ts).

export interface DataEnvelope<T> {
    data: T;
}

export interface ListEnvelope<T> {
    data: T[];
    meta: { total: number };
}

export interface ErrorEnvelope {
    error: { code: string; message: string };
}

// Normalized list result: rows + authoritative total from meta.total.
export interface ListResult<T> {
    rows: T[];
    total: number;
}
