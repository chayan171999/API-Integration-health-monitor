/**
 * Date extraction (BRIEF 6.3). A date becomes an effectiveDate only when a trigger
 * word ("on", "by", "starting", "effective", ...) sits right before it. The nearest
 * future one wins. Dates are never invented: month-only dates ("in February 2027")
 * are kept but flagged approximate, and anything without a month is ignored.
 */
import * as chrono from "chrono-node";
import { DATE_TRIGGER, DATE_TRIGGER_WINDOW } from "./rules.ts";

export interface FoundDate {
  date: string; // YYYY-MM-DD
  text: string; // as written in the source
  index: number;
  triggered: boolean; // a trigger word precedes it
  approximate: boolean; // day not stated (first of month used)
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** @param reference date the text was published (or today), used for year-less dates like "December 1". */
export function findDates(text: string, reference: Date): FoundDate[] {
  const out: FoundDate[] = [];
  for (const r of chrono.parse(text, reference)) {
    const s = r.start;
    if (!/\d/.test(r.text)) continue; // "today", "tomorrow", "next Monday": relative, not a stated date
    if (!s.isCertain("month")) continue; // "today", "next week", bare times: not a stated date
    if (!s.isCertain("day") && !s.isCertain("year")) continue; // "in December": too vague
    const y = s.get("year");
    const m = s.get("month");
    const d = s.isCertain("day") ? s.get("day") : 1;
    if (!y || !m || !d) continue;
    const before = text.slice(Math.max(0, r.index - DATE_TRIGGER_WINDOW), r.index);
    out.push({
      date: iso(y, m, d),
      text: r.text,
      index: r.index,
      triggered: DATE_TRIGGER.test(before),
      approximate: !s.isCertain("day"),
    });
  }
  return out;
}

/** A short date-only first line ("November 2, 2026") is the entry's publish date, not a deadline. */
export function leadingDate(text: string | undefined, reference: Date): string | undefined {
  const first = text?.split("\n", 1)[0]?.trim();
  if (!first || first.length > 30) return undefined;
  const d = findDates(first, reference)[0];
  return d && d.text.length >= first.length - 2 ? d.date : undefined;
}

/** "2017 shortform changelog entries", "Changelog › 2020": the section's year, as its last day. */
export function headingYear(heading: string | undefined): string | undefined {
  const years = [...(heading ?? "").matchAll(/\b(19\d{2}|20\d{2})\b/g)].map((m) => m[1]!);
  return years.length ? `${years.at(-1)}-12-31` : undefined;
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso.slice(0, 10) + "T00:00:00Z");
  const b = Date.parse(toIso.slice(0, 10) + "T00:00:00Z");
  return Math.round((b - a) / 86_400_000);
}

/**
 * The deadline: nearest triggered date on/after today. If there is none and
 * `allowPast` is set (removal/sunset wording), the most recent triggered past date.
 */
export function pickEffectiveDate(dates: FoundDate[], today: string, allowPast: boolean): FoundDate | undefined {
  const triggered = dates.filter((d) => d.triggered);
  const future = triggered.filter((d) => d.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  if (future[0]) return future[0];
  if (!allowPast) return undefined;
  return triggered.sort((a, b) => b.date.localeCompare(a.date))[0];
}
