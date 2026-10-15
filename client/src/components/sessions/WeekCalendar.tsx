// Grille hebdomadaire du planning : colonne d'heures configurable + 7 colonnes
// de jours (lundi → dimanche), blocs positionnés par heure de début et durée.
// Les blocs qui se chevauchent se partagent la largeur du jour (colonnes
// côte à côte) — jamais masqués ; un bloc hors plage horaire est ramené sur
// son bord (clip visuel, tooltip = horaires réels).
//
// Navigation : semaine précédente / suivante / « Aujourd'hui ». La plage
// horaire visible est configurable (bornes du cours les plus tôt / plus tard),
// persistée en localStorage par l'appelant.
//
// Ajout par glisser : un clic ou un glisser vertical dans une colonne vide
// sélectionne un créneau (aimanté au quart d'heure, jour + heures rendus à
// l'appelant qui ouvre le dialogue de création pré-rempli). Un simple clic
// vaut créneau d'une heure à partir du point cliqué.

import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import {
    addLocalDays,
    blockFromRow,
    formatMinutes,
    formatWeekRangeLabel,
    layoutDay,
    localDateKey,
    startOfWeekLocal,
    weekDates,
    WEEKDAY_SHORT_FR,
    type CalendarBlock,
    type PlacedBlock,
} from "../../lib/calendar";
import { parseLocalDate } from "../../lib/calendar";
import { SESSION_STATUS_LABEL } from "../../lib/format";
import type { CalendarSessionRow, SessionStatus } from "../../types/domain";

const HOUR_PX = 48;
const SNAP_MINUTES = 15;
const CLICK_SLOT_MINUTES = 60;
const STATUSES: SessionStatus[] = ["scheduled", "running", "completed", "cancelled"];

export interface CalendarRange {
    startHour: number;
    endHour: number;
}

interface WeekCalendarProps {
    weekStart: string; // « YYYY-MM-DD » du lundi affiché
    rows: CalendarSessionRow[]; // occurrences de la semaine (getCalendar)
    range: CalendarRange;
    onRangeChange: (range: CalendarRange) => void;
    onWeekChange: (monday: string) => void;
    onSelect: (row: CalendarSessionRow) => void;
    // Créneau choisi par clic/glisser dans une colonne vide : jour local +
    // minutes bornées (aimantées au quart d'heure, dans la plage visible).
    onCreateRange: (date: string, startMinutes: number, endMinutes: number) => void;
}

function hourOptions(): number[] {
    return Array.from({ length: 24 }, (_, h) => h);
}

export function WeekCalendar({
    weekStart,
    rows,
    range,
    onRangeChange,
    onWeekChange,
    onSelect,
    onCreateRange,
}: WeekCalendarProps) {
    const days = useMemo(() => weekDates(weekStart), [weekStart]);
    // Ligne « maintenant » rafraîchie chaque minute (uniquement sur
    // aujourd'hui ; le reste de la grille est des données HTTP).
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), 60_000);
        return () => clearInterval(timer);
    }, []);

    // Glisser pour créer : l'ancre est le point d'enfoncement du bouton,
    // l'extrémité suit le curseur (les deux aimantés au quart d'heure).
    const [drag, setDrag] = useState<{ date: string; from: number; to: number } | null>(null);
    const dragRef = useRef<{ date: string; anchor: number; moved: boolean } | null>(null);

    const blocksByDay = useMemo(() => {
        const raw = new Map<string, CalendarBlock[]>();
        for (const date of days) raw.set(date, []);
        for (const row of rows) {
            const block = blockFromRow(row);
            raw.get(block.date)?.push(block);
        }
        const placed = new Map<string, PlacedBlock[]>();
        for (const [date, list] of raw) placed.set(date, layoutDay(list));
        return placed;
    }, [rows, days]);

    const rangeStart = range.startHour * 60;
    const rangeEnd = range.endHour * 60;
    const gridHeight = ((rangeEnd - rangeStart) / 60) * HOUR_PX;
    const todayKey = formatLocalToday();

    const shiftWeek = (deltaDays: number): void => {
        onWeekChange(addLocalDays(weekStart, deltaDays));
    };

    const setStart = (h: number): void => {
        // La plage reste strictement croissante (minimum 1 h).
        onRangeChange({ startHour: h, endHour: Math.max(h + 1, range.endHour) });
    };
    const setEnd = (h: number): void => {
        onRangeChange({ endHour: h, startHour: Math.min(h - 1, range.startHour) });
    };

    // Minutes → position verticale inversée : Y du curseur dans la colonne en
    // minutes locales bornées à la plage visible, aimantées au quart d'heure.
    const minutesAt = (clientY: number, el: HTMLElement): number => {
        const raw = rangeStart + ((clientY - el.getBoundingClientRect().top) / HOUR_PX) * 60;
        const snapped = Math.round(raw / SNAP_MINUTES) * SNAP_MINUTES;
        return Math.min(rangeEnd, Math.max(rangeStart, snapped));
    };

    const onDayPointerDown = (e: ReactPointerEvent<HTMLDivElement>, date: string): void => {
        // Uniquement la souris (le tactile garde son défilement natif) et
        // jamais sur un bloc existant (qui garde son clic « détail »).
        if (e.button !== 0 || e.pointerType !== "mouse") return;
        if ((e.target as HTMLElement).closest(".cal-block")) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const anchor = minutesAt(e.clientY, e.currentTarget);
        dragRef.current = { date, anchor, moved: false };
        setDrag({ date, from: anchor, to: anchor });
    };

    const onDayPointerMove = (e: ReactPointerEvent<HTMLDivElement>, date: string): void => {
        const d = dragRef.current;
        if (d === null || d.date !== date) return;
        const to = minutesAt(e.clientY, e.currentTarget);
        if (to !== d.anchor) d.moved = true;
        setDrag({ date, from: d.anchor, to });
    };

    const onDayPointerUp = (e: ReactPointerEvent<HTMLDivElement>, date: string): void => {
        const d = dragRef.current;
        dragRef.current = null;
        setDrag(null);
        if (d === null || d.date !== date) return;
        const to = minutesAt(e.clientY, e.currentTarget);
        let from = Math.min(d.anchor, to);
        let end = Math.max(d.anchor, to);
        if (!d.moved || end - from < SNAP_MINUTES) {
            // Simple clic : créneau d'une heure à partir du point cliqué,
            // remonté si la fin de plage est trop proche.
            from = d.anchor;
            end = Math.min(d.anchor + CLICK_SLOT_MINUTES, rangeEnd);
            if (end - from < SNAP_MINUTES) from = Math.max(rangeStart, rangeEnd - CLICK_SLOT_MINUTES);
        }
        onCreateRange(date, from, end);
    };

    const onDayPointerCancel = (): void => {
        dragRef.current = null;
        setDrag(null);
    };

    return (
        <div className="cal">
            <div className="cal__toolbar">
                <div className="cal__nav">
                    <button className="btn btn--sm" onClick={() => shiftWeek(-7)} aria-label="Semaine précédente">
                        &larr;
                    </button>
                    <button className="btn btn--sm" onClick={() => onWeekChange(todayMonday())}>
                        Aujourd'hui
                    </button>
                    <button className="btn btn--sm" onClick={() => shiftWeek(7)} aria-label="Semaine suivante">
                        &rarr;
                    </button>
                </div>
                <p className="cal__week-label">{formatWeekRangeLabel(weekStart)}</p>
                <div className="cal__range">
                    <label className="cal__range-field">
                        <span>De</span>
                        <select
                            value={range.startHour}
                            onChange={(e) => setStart(Number(e.target.value))}
                            aria-label="Heure de début de la plage affichée"
                        >
                            {hourOptions().map((h) => (
                                <option key={h} value={h} disabled={h >= range.endHour}>
                                    {formatMinutes(h * 60)}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="cal__range-field">
                        <span>à</span>
                        <select
                            value={range.endHour}
                            onChange={(e) => setEnd(Number(e.target.value))}
                            aria-label="Heure de fin de la plage affichée"
                        >
                            {hourOptions().map((h) => (
                                <option key={h} value={h} disabled={h <= range.startHour}>
                                    {formatMinutes(h * 60)}
                                </option>
                            ))}
                        </select>
                    </label>
                </div>
            </div>

            <div className="cal__legend" aria-label="Légende des statuts">
                {STATUSES.map((s) => (
                    <span key={s} className="cal__legend-item">
                        <span className={`cal__legend-dot cal__legend-dot--${s}`} aria-hidden="true" />
                        {SESSION_STATUS_LABEL[s]}
                    </span>
                ))}
                <span className="cal__legend-item">
                    <span aria-hidden="true">↻</span> série récurrente
                </span>
            </div>

            <div className="cal__scroll">
                <div
                    className="cal__grid"
                    style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(120px, 1fr))` }}
                    role="grid"
                    aria-label={`Semaine du ${formatWeekRangeLabel(weekStart)}`}
                >
                    <div className="cal__corner" aria-hidden="true" />
                    {days.map((date, i) => (
                        <div
                            key={date}
                            className={`cal__day-head ${date === todayKey ? "cal__day-head--today" : ""}`}
                            role="columnheader"
                        >
                            <span className="cal__day-name">{WEEKDAY_SHORT_FR[(i + 1) % 7]}</span>
                            <span className="cal__day-num">{formatDayNum(date)}</span>
                        </div>
                    ))}

                    <div className="cal__gutter" style={{ height: gridHeight }}>
                        {hourLabels(range).map(({ hour, label }) => (
                            <span key={hour} className="cal__hour" style={{ top: (hour - range.startHour) * HOUR_PX }}>
                                {label}
                            </span>
                        ))}
                    </div>

                    {days.map((date) => {
                        const dayBlocks = blocksByDay.get(date) ?? [];
                        const nowMinutes =
                            date === todayKey ? now.getHours() * 60 + now.getMinutes() : null;
                        return (
                            <div
                                key={date}
                                className={`cal__day ${date === todayKey ? "cal__day--today" : ""}`}
                                style={{ height: gridHeight }}
                                role="gridcell"
                                aria-label={`${formatDayNum(date)} — ${dayBlocks.length} cours`}
                                onPointerDown={(e) => onDayPointerDown(e, date)}
                                onPointerMove={(e) => onDayPointerMove(e, date)}
                                onPointerUp={(e) => onDayPointerUp(e, date)}
                                onPointerCancel={onDayPointerCancel}
                            >
                                <div
                                    className="cal__hours-lines"
                                    style={hourLinesStyle()}
                                    aria-hidden="true"
                                />
                                {nowMinutes !== null &&
                                    nowMinutes >= rangeStart &&
                                    nowMinutes <= rangeEnd && (
                                        <div
                                            className="cal__now"
                                            style={{ top: ((nowMinutes - rangeStart) / 60) * HOUR_PX }}
                                            aria-hidden="true"
                                        />
                                    )}
                                {dayBlocks.map((block) => (
                                    <CalendarBlockButton
                                        key={block.row.id}
                                        block={block}
                                        rangeStart={rangeStart}
                                        gridHeight={gridHeight}
                                        onSelect={onSelect}
                                    />
                                ))}
                                {drag !== null && drag.date === date && (
                                    <div
                                        className="cal-draft"
                                        style={{
                                            top: ((Math.min(drag.from, drag.to) - rangeStart) / 60) * HOUR_PX,
                                            height: Math.max((Math.abs(drag.to - drag.from) / 60) * HOUR_PX, 4),
                                        }}
                                        aria-hidden="true"
                                    >
                                        <span className="cal-draft__label">
                                            {drag.from === drag.to
                                                ? "Nouvelle séance"
                                                : `${formatMinutes(Math.min(drag.from, drag.to))} – ${formatMinutes(Math.max(drag.from, drag.to))}`}
                                        </span>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

function CalendarBlockButton({
    block,
    rangeStart,
    gridHeight,
    onSelect,
}: {
    block: PlacedBlock;
    rangeStart: number;
    gridHeight: number;
    onSelect: (row: CalendarSessionRow) => void;
}) {
    const pxPerMin = HOUR_PX / 60;
    const rawTop = (block.startMinutes - rangeStart) * pxPerMin;
    const rawBottom = (block.endMinutes - rangeStart) * pxPerMin;
    const top = Math.max(0, rawTop);
    const bottom = Math.min(gridHeight, rawBottom);
    const visibleHeight = Math.max(bottom - top, 18); // un bloc reste cliquable
    const clipped = rawTop < 0 || rawBottom > gridHeight;
    const width = 100 / block.cols;
    const left = block.col * width;
    const row = block.row;
    const times = `${formatMinutes(block.startMinutes)} – ${formatMinutes(block.endMinutes)}`;
    const groups = row.group_name ?? "Sans groupe";
    const title = [
        row.label,
        times + (block.wallClock ? ` · heure locale (${row.timezone})` : ""),
        groups,
        `${row.participant_count} participant(s) attendu(s)`,
        SESSION_STATUS_LABEL[row.status],
        row.series_label ? `Série : ${row.series_label}` : null,
    ]
        .filter(Boolean)
        .join("\n");

    return (
        <button
            type="button"
            className={`cal-block cal-block--${row.status}${clipped ? " cal-block--clipped" : ""}${
                row.status === "cancelled" ? " cal-block--cancelled" : ""
            }`}
            style={{
                top,
                height: visibleHeight,
                left: `calc(${left}% + 2px)`,
                width: `calc(${width}% - 4px)`,
            }}
            title={title}
            onClick={() => onSelect(row)}
        >
            <span className="cal-block__time">{times}</span>
            <span className="cal-block__label">
                {row.series_id !== null && <span aria-hidden="true">↻ </span>}
                {row.label}
            </span>
            {visibleHeight >= 44 && <span className="cal-block__meta">{groups}</span>}
            {visibleHeight >= 62 && (
                <span className="cal-block__meta">{row.participant_count} participant(s)</span>
            )}
            <span className="cal-block__status">{SESSION_STATUS_LABEL[row.status]}</span>
        </button>
    );
}

function hourLabels(range: CalendarRange): Array<{ hour: number; label: string }> {
    const labels: Array<{ hour: number; label: string }> = [];
    for (let h = range.startHour; h < range.endHour; h += 1) labels.push({ hour: h, label: formatMinutes(h * 60) });
    return labels;
}

// Lignes d'heures : dégradé répétitif d'un pixel, répété une fois par heure
// (le fond ne dépend pas de la hauteur totale de la grille).
function hourLinesStyle(): { backgroundImage: string; backgroundSize: string } {
    return {
        backgroundImage: "repeating-linear-gradient(to bottom, var(--border) 0 1px, transparent 1px 100%)",
        backgroundSize: `100% ${HOUR_PX}px`,
    };
}

function formatDayNum(dateKey: string): string {
    return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" }).format(parseLocalDate(dateKey));
}

function formatLocalToday(): string {
    return localDateKey(new Date());
}

function todayMonday(): string {
    return startOfWeekLocal(new Date());
}
