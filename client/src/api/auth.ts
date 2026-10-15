// Authentication endpoints. The session is an HTTP-only cookie set by the
// backend; the client never stores nor reads any token.

import { get, post, postEmpty } from "./client";
import type { AuthUser } from "../types/domain";

export async function login(username: string, password: string): Promise<AuthUser> {
    const res = await post<{ user: AuthUser }>("/auth/login", { username, password });
    return res.user;
}

export async function fetchCurrentUser(): Promise<AuthUser> {
    const res = await get<{ user: AuthUser | null }>("/auth/me");
    return res.user as AuthUser;
}

export function logout(): Promise<void> {
    return postEmpty<void>("/auth/logout");
}
