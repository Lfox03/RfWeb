// Development dataset — NEVER executed automatically at startup, only via
// `npm run db:seed`. Idempotent : creates only what is missing, never overwrites
// existing data.
//
// The admin account is created with a REAL scrypt hash (Phase 3 — authentication).
// Password : SEED_ADMIN_PASSWORD environment variable, default "admin"
// (DEVELOPMENT account only — must be changed on any real installation).
// If the admin account still exists with the Phase 2 placeholder hash
// (prefix "!"), it is re-hashed (the placeholder was never a secret).

import type { DatabaseHandle } from "./database";
import { hashPassword } from "../auth/password";
import { createCardRepository } from "./repositories/cards";
import { createGroupRepository } from "./repositories/groups";
import { createStudentRepository } from "./repositories/students";
import { createUserRepository } from "./repositories/users";

export interface SeedSummary {
    groupsCreated: string[];
    studentsCreated: string[];
    usersCreated: string[];
    usersRehashed: string[];
}

export async function seedDatabase(db: DatabaseHandle): Promise<SeedSummary> {
    const groups = createGroupRepository(db);
    const students = createStudentRepository(db);
    const cards = createCardRepository(db);
    const users = createUserRepository(db);

    const summary: SeedSummary = {
        groupsCreated: [],
        studentsCreated: [],
        usersCreated: [],
        usersRehashed: [],
    };

    const ensureGroup = (name: string) => {
        const existing = groups.findByName(name);
        if (existing) return existing;
        summary.groupsCreated.push(name);
        return groups.create(name);
    };

    const g1 = ensureGroup("G1");
    const g2 = ensureGroup("G2");

    const demoStudents: Array<{ first: string; last: string; uid: string; groupId: number }> = [
        { first: "Ada", last: "Lovelace", uid: "9000001", groupId: g1.id },
        { first: "Alan", last: "Turing", uid: "9000002", groupId: g2.id },
    ];

    for (const demo of demoStudents) {
        if (!students.findByCardUid(demo.uid)) {
            const student = students.create({ firstName: demo.first, lastName: demo.last, groupId: demo.groupId });
            cards.assignToStudent(demo.uid, student.id);
            summary.studentsCreated.push(`${demo.first} ${demo.last} (card ${demo.uid})`);
        }
    }

    const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "admin";
    const admin = users.findByUsername("admin");
    if (!admin) {
        users.create({ username: "admin", passwordHash: await hashPassword(adminPassword), role: "admin" });
        summary.usersCreated.push("admin (admin role)");
    } else if (admin.password_hash.startsWith("!")) {
        // Placeholder Phase 2 → real hash (same behavior as "create").
        users.setPasswordHash(admin.id, await hashPassword(adminPassword));
        summary.usersRehashed.push("admin (placeholder replaced by a scrypt hash)");
    }

    return summary;
}
