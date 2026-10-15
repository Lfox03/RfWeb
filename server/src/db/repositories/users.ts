// "Application users" repository (schema only — no
// authentication before Phase 3).

import type { DatabaseHandle } from "../database";
import { isoNow } from "../types";
import type { UserRow, UserRole } from "../types";

export interface NewUser {
    username: string;
    // Placeholder until password hashing is implemented
    // (Phase 3) ; never store a cleartext password here.
    passwordHash: string;
    role?: UserRole;
}

export function createUserRepository(db: DatabaseHandle) {
    return {
        create(input: NewUser): UserRow {
            const role = input.role ?? "teacher";
            const info = db
                .prepare(
                    `INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`,
                )
                .run(input.username, input.passwordHash, role);
            return this.findById(Number(info.lastInsertRowid))!;
        },

        findById(id: number): UserRow | undefined {
            return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
        },

        findByUsername(username: string): UserRow | undefined {
            return db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;
        },

        // Username only (no password_hash leaves the repository) — used to
        // display who created a session. NULL when the user no longer exists.
        usernameById(id: number): string | null {
            const row = db.prepare("SELECT username FROM users WHERE id = ?").get(id) as
                | { username: string }
                | undefined;
            return row?.username ?? null;
        },

        findAll(): UserRow[] {
            return db.prepare("SELECT * FROM users ORDER BY username ASC").all() as UserRow[];
        },

        count(): number {
            return (db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c;
        },

        updateRole(id: number, role: UserRole): UserRow | undefined {
            db.prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ?").run(role, isoNow(), id);
            return this.findById(id);
        },

        setPasswordHash(id: number, passwordHash: string): UserRow | undefined {
            db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(passwordHash, isoNow(), id);
            return this.findById(id);
        },
    };
}

export type UserRepository = ReturnType<typeof createUserRepository>;
