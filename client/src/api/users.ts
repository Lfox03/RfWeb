// User-management endpoints (admin-only). The server hashes every password
// with scrypt; the plaintext only ever travels over the existing HTTP API.

import { getList, patch, post } from "./client";
import type { ListResult } from "../types/api";
import type { UserAccount, UserRole } from "../types/domain";

export function listUsers(): Promise<ListResult<UserAccount>> {
    return getList<UserAccount>("/users");
}

export function createUser(username: string, password: string, role: UserRole): Promise<UserAccount> {
    return post<UserAccount>("/users", { username, password, role });
}

export function changeUserRole(id: number, role: UserRole): Promise<UserAccount> {
    return patch<UserAccount>(`/users/${id}`, { role });
}

export function resetUserPassword(id: number, password: string): Promise<void> {
    return patch<null>(`/users/${id}`, { password }).then(() => undefined);
}
