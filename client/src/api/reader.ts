import { get, post, postEmpty } from "./client";
import type { CardProbe, ReaderStatus } from "../types/domain";

export function getReaderStatus(): Promise<ReaderStatus> {
    return get<ReaderStatus>("/reader/status");
}

export function beep(): Promise<void> {
    return postEmpty<{ beep: string }>("/reader/beep").then(() => undefined);
}

// One-shot "present a card" read (long-poll until the server times out).
export function nextCard(): Promise<CardProbe> {
    return post<CardProbe>("/reader/next-card");
}
