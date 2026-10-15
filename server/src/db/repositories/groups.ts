// "Groups" repository.

import type { DatabaseHandle } from "../database";
import { isoNow } from "../types";
import type { GroupRow } from "../types";

export function createGroupRepository(db: DatabaseHandle) {
    return {
        create(name: string): GroupRow {
            const info = db.prepare("INSERT INTO groups (name) VALUES (?)").run(name);
            return this.findById(Number(info.lastInsertRowid))!;
        },

        findById(id: number): GroupRow | undefined {
            return db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as GroupRow | undefined;
        },

        findByName(name: string): GroupRow | undefined {
            return db.prepare("SELECT * FROM groups WHERE name = ?").get(name) as GroupRow | undefined;
        },

        findOrCreateByName(name: string): GroupRow {
            const existing = this.findByName(name);
            if (existing) return existing;
            try {
                return this.create(name);
            } catch (err) {
                // Race condition : the group has just been created.
                if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
                    return this.findByName(name)!;
                }
                throw err;
            }
        },

        findAll(): GroupRow[] {
            return db.prepare("SELECT * FROM groups ORDER BY name ASC").all() as GroupRow[];
        },

        rename(id: number, name: string): GroupRow | undefined {
            db.prepare("UPDATE groups SET name = ?, updated_at = ? WHERE id = ?").run(name, isoNow(), id);
            return this.findById(id);
        },

        remove(id: number): void {
            db.prepare("DELETE FROM groups WHERE id = ?").run(id);
        },
    };
}

export type GroupRepository = ReturnType<typeof createGroupRepository>;
