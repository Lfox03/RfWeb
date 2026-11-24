// Helpers shared by every api:verify section: check counter, polling, the
// cookie-aware HTTP test client and the "remote caller" simulation. Purely
// self-contained (no application imports) — importing this module never
// triggers application code, so it cannot run before environment.ts.
import assert from "node:assert/strict";

let checks = 0;

export function getCheckCount(): number {
    return checks;
}

export function ok(label: string, condition: boolean): void {
    assert.ok(condition, label);
    checks += 1;
    console.log(`  ✔ ${label}`);
}

// Polls a condition (the scan loop runs on its own rhythm: 500 ms between
// scans, 1.5 s of waiting while the reader is offline).
export async function waitFor(label: string, condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await condition()) return;
        if (Date.now() > deadline) throw new Error(`délai dépassé : ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

export interface ApiResponse {
    status: number;
    body: any;
}

export class Client {
    cookie: string | undefined = undefined;

    async call(method: string, route: string, body?: unknown): Promise<ApiResponse> {
        const headers: Record<string, string> = { ...this.extraHeaders };
        if (body !== undefined) headers["content-type"] = "application/json";
        if (this.cookie) headers.cookie = this.cookie;
        const res = await fetch(`${this.base}${route}`, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const setCookie = res.headers.get("set-cookie");
        if (setCookie) this.cookie = setCookie.split(";")[0];
        let parsed: unknown = null;
        const text = await res.text();
        if (text) {
            try {
                parsed = JSON.parse(text);
            } catch {
                /* empty response */
            }
        }
        return { status: res.status, body: parsed };
    }

    constructor(
        public readonly base: string,
        /** Extra request headers (e.g. the X-Forwarded-For of a simulated remote client). */
        private readonly extraHeaders: Record<string, string> = {},
    ) {}
}

// The suite binds to 127.0.0.1, so a REMOTE caller is simulated through
// X-Forwarded-For (honored because TRUST_PROXY=1 — same mechanism as
// the rate-limit section): used wherever a check must assert the anonymous
// behaviour WITHOUT the loopback kiosk exception. TEST-NET-3 (RFC 5737).
export const REMOTE_IP = "203.0.113.9";
export const REMOTE_HEADERS = { "x-forwarded-for": REMOTE_IP };
