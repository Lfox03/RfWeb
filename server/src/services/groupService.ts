// Groups service — application rules on top of groupRepository.

import { ConflictError, NotFoundError } from "../core/errors";
import { logger } from "../core/logger";
import { groupRepository, studentRepository } from "../db";
import type { GroupRow } from "../db/types";

const groupLog = logger.child({ component: "group" });

export interface GroupWithCount extends GroupRow {
    student_count: number;
}

function uniqueConflict(err: unknown): never {
    if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new ConflictError("GROUP_NAME_TAKEN", "Ce nom de groupe existe déjà.");
    }
    throw err;
}

export function list(): GroupWithCount[] {
    return groupRepository.findAll().map((group) => ({
        ...group,
        student_count: studentRepository.findByGroup(group.id).length,
    }));
}

export function get(id: number): GroupRow {
    const group = groupRepository.findById(id);
    if (!group) throw new NotFoundError("Groupe");
    return group;
}

export function create(name: string): GroupRow {
    try {
        return groupRepository.create(name);
    } catch (err) {
        return uniqueConflict(err);
    }
}

export function rename(id: number, name: string): GroupRow {
    get(id);
    try {
        const renamed = groupRepository.rename(id, name);
        if (!renamed) throw new NotFoundError("Groupe");
        return renamed;
    } catch (err) {
        return uniqueConflict(err);
    }
}

// Deletes the group; associated students are kept (FK SET NULL).
export function remove(id: number): void {
    get(id);
    groupRepository.remove(id);
    groupLog.info("group.deleted", { group_id: id });
}
