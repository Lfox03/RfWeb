import { get, post, postEmpty } from "./client";
import type { CardWithStudentRow } from "../types/domain";

export function getCard(uid: string): Promise<CardWithStudentRow> {
    return get<CardWithStudentRow>(`/cards/${encodeURIComponent(uid)}`);
}

// Register a card in stock (unassigned).
export function registerCard(uid: string): Promise<CardWithStudentRow> {
    return post<CardWithStudentRow>("/cards", { uid });
}

export function revokeCard(uid: string): Promise<CardWithStudentRow> {
    return postEmpty<CardWithStudentRow>(`/cards/${encodeURIComponent(uid)}/revoke`);
}
