import { del, getList, patch, post } from "./client";
import type { ListResult } from "../types/api";
import type { GroupRow } from "../types/domain";

export function listGroups(): Promise<ListResult<GroupRow>> {
    return getList<GroupRow>("/groups");
}

export function createGroup(name: string): Promise<GroupRow> {
    return post<GroupRow>("/groups", { name });
}

export function renameGroup(id: number, name: string): Promise<GroupRow> {
    return patch<GroupRow>(`/groups/${id}`, { name });
}

export function deleteGroup(id: number): Promise<void> {
    return del<void>(`/groups/${id}`);
}
