// Tests unitaires des helpers de tri (npm run test:client — node --test via tsx).
// Le comportement contractuel : collation française, nombres « naturels »,
// valeurs manquantes TOUJOURS en dernier, stabilité des égalités, et
// transparence totale quand aucune colonne n'est triée.

import assert from "node:assert/strict";
import { test } from "node:test";

import { sortRows } from "./sort";
import type { SortGetters, SortSpec } from "./sort";

interface Row {
    id: number;
    name: string | null;
    num: number | null;
}

const getters: SortGetters<Row, "name" | "num"> = {
    name: (r) => r.name,
    num: (r) => r.num,
};

const by = (key: "name" | "num", dir: "asc" | "desc"): SortSpec<"name" | "num"> => ({ key, dir });

test("spec null : le tableau est rendu tel quel (aucun tri, pas de copie)", () => {
    const rows: Row[] = [
        { id: 1, name: "Zoe", num: 2 },
        { id: 2, name: "École", num: 1 },
    ];
    assert.strictEqual(sortRows(rows, null, getters), rows);
});

test("numérique : ascendant puis descendant", () => {
    const rows: Row[] = [
        { id: 1, name: "a", num: 3 },
        { id: 2, name: "b", num: 1 },
        { id: 3, name: "c", num: 2 },
    ];
    assert.deepEqual(
        sortRows(rows, by("num", "asc"), getters).map((r) => r.num),
        [1, 2, 3],
    );
    assert.deepEqual(
        sortRows(rows, by("num", "desc"), getters).map((r) => r.num),
        [3, 2, 1],
    );
});

test("collation française : accents et casse ignorés (École < élan < Zoe)", () => {
    const rows = ["Zoe", "École", "élan"].map((name, id) => ({ id, name, num: 0 }));
    assert.deepEqual(
        sortRows(rows, by("name", "asc"), getters).map((r) => r.name),
        ["École", "élan", "Zoe"],
    );
});

test("chaînes numériques naturelles : G1 avant G2 avant G10", () => {
    const rows = ["G10", "G2", "G1"].map((name, id) => ({ id, name, num: 0 }));
    assert.deepEqual(
        sortRows(rows, by("name", "asc"), getters).map((r) => r.name),
        ["G1", "G2", "G10"],
    );
});

test("horodatages ISO : l'ordre lexicale est l'ordre chronologique", () => {
    const rows = ["2026-06-02T08:00:00.000Z", "2026-06-01T18:00:00.000Z", "2026-06-01T07:30:00.000Z"].map(
        (name, id) => ({ id, name, num: 0 }),
    );
    assert.deepEqual(
        sortRows(rows, by("name", "asc"), getters).map((r) => r.name),
        ["2026-06-01T07:30:00.000Z", "2026-06-01T18:00:00.000Z", "2026-06-02T08:00:00.000Z"],
    );
});

test("valeurs manquantes : dernières dans les DEUX sens (null ET undefined)", () => {
    const rows: Row[] = [
        { id: 1, name: null, num: 1 },
        { id: 2, name: "b", num: 2 },
        { id: 3, name: "a", num: null },
    ];
    assert.deepEqual(
        sortRows(rows, by("name", "asc"), getters).map((r) => r.name),
        ["a", "b", null],
    );
    assert.deepEqual(
        sortRows(rows, by("name", "desc"), getters).map((r) => r.name),
        ["b", "a", null],
    );
    assert.deepEqual(
        sortRows(rows, by("num", "asc"), getters).map((r) => r.num),
        [1, 2, null],
    );
    assert.deepEqual(
        sortRows(rows, by("num", "desc"), getters).map((r) => r.num),
        [2, 1, null],
    );
});

test("égalité sur la colonne triée : ordre d'origine conservé (stabilité)", () => {
    const rows: Row[] = [
        { id: 10, name: "dup", num: 1 },
        { id: 11, name: "dup", num: 1 },
        { id: 12, name: "dup", num: 1 },
    ];
    assert.deepEqual(
        sortRows(rows, by("num", "asc"), getters).map((r) => r.id),
        [10, 11, 12],
    );
    // Deux valeurs nulles entre elles : aussi l'ordre d'origine.
    const nuls: Row[] = [
        { id: 20, name: null, num: 0 },
        { id: 21, name: null, num: 0 },
    ];
    assert.deepEqual(
        sortRows(nuls, by("name", "asc"), getters).map((r) => r.id),
        [20, 21],
    );
});
