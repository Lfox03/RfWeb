// Tests unitaires des helpers du planning (npm run test:client — node --test via tsx).
// Tout est testé sur des dates LOCALES ou construit à partir de Date locales :
// les assertions tiennent dans n'importe quel fuseau (UTC sur la CI, Europe
// sur les postes de l'école), y compris au travers d'un changement d'heure.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    addLocalDays,
    blockFromRow,
    blocksForDate,
    formatMinutes,
    formatWeekRangeLabel,
    layoutDay,
    localDateKey,
    parseLocalDate,
    startOfWeekLocal,
    weekDates,
    WEEKDAY_SHORT_FR,
} from "./calendar";
import type { CalendarBlock } from "./calendar";
import type { CalendarSessionRow } from "../types/domain";

// ═══ Dates locales « YYYY-MM-DD » ═════════════════════════════════════════

test("parseLocalDate : minuit LOCAL (jamais l'interprétation UTC de « YYYY-MM-DD »)", () => {
    const d = parseLocalDate("2026-10-12");
    assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()], [2026, 9, 12, 0]);
    assert.equal(localDateKey(d), "2026-10-12");
});

test("addLocalDays : bornes de mois et d'année franchies proprement", () => {
    assert.equal(addLocalDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addLocalDays("2027-01-01", -1), "2026-12-31");
    assert.equal(addLocalDays("2026-10-30", 3), "2026-11-02");
    assert.equal(addLocalDays("2026-02-27", 2), "2026-03-01"); // 2026 non bissextile
    // Composition cohérente (arithmétique safe DST quel que soit le fuseau).
    assert.equal(addLocalDays(addLocalDays("2026-03-26", 3), 4), addLocalDays("2026-03-26", 7));
});

test("startOfWeekLocal : semaine LUNDI→DIMANCHE (le dimanche appartient à sa semaine)", () => {
    assert.equal(startOfWeekLocal(parseLocalDate("2026-10-12")), "2026-10-12"); // lundi
    assert.equal(startOfWeekLocal(parseLocalDate("2026-10-17")), "2026-10-12"); // samedi
    assert.equal(startOfWeekLocal(parseLocalDate("2026-10-18")), "2026-10-12"); // dimanche
    assert.equal(startOfWeekLocal(parseLocalDate("2026-10-19")), "2026-10-19"); // lundi suivant
});

test("weekDates : les 7 jours consécutifs de la semaine", () => {
    assert.deepEqual(weekDates("2026-10-12"), [
        "2026-10-12",
        "2026-10-13",
        "2026-10-14",
        "2026-10-15",
        "2026-10-16",
        "2026-10-17",
        "2026-10-18",
    ]);
    assert.equal(WEEKDAY_SHORT_FR[1], "Lun"); // index = getDay() JS
});

test("formatWeekRangeLabel : libellé français, mois omis quand identique", () => {
    const norm = (s: string): string => s.replace(/[  ]/g, " "); // espaces fins/insécables
    assert.equal(norm(formatWeekRangeLabel("2026-10-12")), "12 – 18 octobre 2026");
    assert.equal(norm(formatWeekRangeLabel("2026-09-28")), "28 septembre – 4 octobre 2026");
    assert.equal(norm(formatWeekRangeLabel("2026-12-28")), "28 décembre 2026 – 3 janvier 2027");
});

test("formatMinutes : HH:MM padding + enroulement des débordements", () => {
    assert.equal(formatMinutes(0), "00:00");
    assert.equal(formatMinutes(540), "09:00");
    assert.equal(formatMinutes(1439), "23:59");
    assert.equal(formatMinutes(1445), "00:05"); // bloc débordant minuit
    assert.equal(formatMinutes(-5), "23:55");
});

// ═══ Blocs : occurrence « murale » vs session autonome (fuseau navigateur) ═══

const rowOf = (over: Partial<CalendarSessionRow>): CalendarSessionRow =>
    ({
        duration_minutes: 60,
        occurrence_date: null,
        local_time: null,
        scheduled_at: "2026-06-01T08:00:00.000Z",
        ...over,
    }) as CalendarSessionRow;

test("blockFromRow : occurrence de série → date locale + heure MURALE", () => {
    const block = blockFromRow(
        rowOf({ occurrence_date: "2026-06-01", local_time: "08:30", duration_minutes: 45 }),
    );
    assert.equal(block.date, "2026-06-01");
    assert.deepEqual([block.startMinutes, block.endMinutes], [8 * 60 + 30, 8 * 60 + 30 + 45]);
    assert.equal(block.wallClock, true);
});

test("blockFromRow : session autonome → instant converti dans le fuseau du navigateur", () => {
    const when = new Date(2026, 5, 1, 14, 30); // 14:30 LOCAL, quel que soit le fuseau
    const block = blockFromRow(rowOf({ scheduled_at: when.toISOString(), duration_minutes: 90 }));
    assert.equal(block.date, "2026-06-01");
    assert.deepEqual([block.startMinutes, block.endMinutes], [870, 960]);
    assert.equal(block.wallClock, false);
});

test("blockFromRow : durée absente = 0 (jamais NaN dans la grille)", () => {
    const block = blockFromRow(rowOf({ duration_minutes: null as unknown as number }));
    assert.equal(block.endMinutes, block.startMinutes);
});

test("blocksForDate : filtre sur le jour de grille", () => {
    const blocks = [
        blockFromRow(rowOf({ occurrence_date: "2026-06-01", local_time: "08:00" })),
        blockFromRow(rowOf({ occurrence_date: "2026-06-02", local_time: "08:00" })),
    ];
    assert.equal(blocksForDate(blocks, "2026-06-01").length, 1);
    assert.equal(blocksForDate(blocks, "2026-06-03").length, 0);
});

// ═══ layoutDay : attribution des colonnes aux chevauchements ═══════════════

const block = (start: number, end: number): CalendarBlock => ({
    row: rowOf({}),
    date: "2026-06-01",
    startMinutes: start,
    endMinutes: end,
    wallClock: false,
});

const placedOf = (blocks: CalendarBlock[], start: number) =>
    layoutDay(blocks).find((b) => b.startMinutes === start);

test("layoutDay : pas de chevauchement → une seule colonne chacun", () => {
    const placed = layoutDay([block(540, 600), block(660, 720)]);
    assert.deepEqual(placed.map((b) => [b.col, b.cols]), [
        [0, 1],
        [0, 1],
    ]);
});

test("layoutDay : deux blocs qui se chevauchent → 2 colonnes distinctes", () => {
    const a = placedOf([block(540, 600), block(570, 630)], 540)!;
    const b = placedOf([block(540, 600), block(570, 630)], 570)!;
    assert.deepEqual([a.cols, b.cols], [2, 2]);
    assert.notEqual(a.col, b.col);
});

test("layoutDay : contiguïté = PAS un chevauchement (fin exclusive)", () => {
    const placed = layoutDay([block(540, 600), block(600, 660)]);
    assert.deepEqual(placed.map((b) => b.cols), [1, 1]);
});

test("layoutDay : chevauchement transitif → le même amas partage ses colonnes", () => {
    // A 9:00–10:00 · B 9:30–10:30 · C 10:00–11:00 : un seul amas de 2 colonnes,
    // jamais de bloc caché.
    const blocks = [block(540, 600), block(570, 630), block(600, 660)];
    const a = placedOf(blocks, 540)!;
    const b = placedOf(blocks, 570)!;
    const c = placedOf(blocks, 600)!;
    assert.deepEqual([a.cols, b.cols, c.cols], [2, 2, 2]);
    assert.equal(c.col, a.col); // C reprend la colonne libérée par A
    assert.notEqual(c.col, b.col);
});

test("layoutDay : trois blocs réellement simultanés → 3 colonnes", () => {
    const blocks = [block(540, 720), block(570, 660), block(630, 690)];
    const placed = layoutDay(blocks);
    assert.deepEqual(placed.map((b) => b.cols), [3, 3, 3]);
    assert.deepEqual(new Set(placed.map((b) => b.col)), new Set([0, 1, 2]));
});

test("layoutDay : amas séparés → chacun son nombre de colonnes", () => {
    const blocks = [block(540, 600), block(570, 630), block(660, 720)];
    const first = layoutDay(blocks).filter((b) => b.startMinutes < 600);
    const last = placedOf(blocks, 660)!;
    assert.deepEqual(first.map((b) => b.cols), [2, 2]);
    assert.deepEqual([last.col, last.cols], [0, 1]); // amas isolé : pleine largeur
});
