/**
 * Status rules (BRIEF section 7). Pure, deterministic functions: same findings +
 * same date in, same status out. Covered by test/score.test.ts.
 */
import type { Category, Finding, IntegrationManifest, IntegrationStatus, Severity, Snapshot } from "../lib/schema.ts";
import { daysBetween } from "./dates.ts";

export const RED_WINDOW_DAYS = 30;

/** Categories that turn red once their effectiveDate is within RED_WINDOW_DAYS (or past). */
const DEADLINE_CATEGORIES = new Set<Category>(["version_sunset", "endpoint_deprecated", "scope_changed", "auth_change"]);

type SeverityInput = Pick<Finding, "category" | "affects" | "effectiveDate" | "confidence" | "appliesToVersion">;

/** Would this finding be red if we were certain about it? */
function wouldBeRed(f: SeverityInput, today: string): boolean {
  if (f.category === "endpoint_removed") return true;
  if (!DEADLINE_CATEGORIES.has(f.category) || !f.effectiveDate) return false;
  return daysBetween(today, f.effectiveDate) <= RED_WINDOW_DAYS; // includes already past
}

export function severityOf(f: SeverityInput, today: string): Severity {
  if (f.category === "broken_doc_link") return "yellow";
  if (f.affects.length === 0) return "info"; // touches nothing we use: never changes status
  if (f.appliesToVersion) return "info"; // only matters when upgrading past the pinned version
  if (f.category === "provider_incident") return "yellow";
  if (wouldBeRed(f, today)) return f.confidence === "low" ? "yellow" : "red";
  return "yellow"; // touches a used item; deadline > 30 days away or unstated
}

/** Findings that drive status: open ones. Acknowledged ones still count toward the next deadline. */
const isOpen = (f: Finding) => f.status === "open";
const isActive = (f: Finding) => f.status === "open" || f.status === "acknowledged";

const CATEGORY_LABEL: Record<Category, string> = {
  endpoint_deprecated: "Deprecation",
  endpoint_removed: "Removal",
  scope_changed: "Scope change",
  auth_change: "Auth change",
  version_sunset: "Version sunset",
  rate_limit_change: "Rate-limit change",
  webhook_change: "Webhook change",
  broken_doc_link: "Broken doc link",
  provider_incident: "Ongoing incident",
  other: "Change",
};

export function categoryLabel(c: Category): string {
  return CATEGORY_LABEL[c];
}

function listItems(items: string[], max = 2): string {
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown} +${items.length - max} more` : shown;
}

function describe(f: Finding, today: string): string {
  const what = `${categoryLabel(f.category)}: ${listItems(f.affects)}`;
  if (!f.effectiveDate) return what;
  const days = daysBetween(today, f.effectiveDate);
  const when = days < 0 ? `${-days} days ago` : days === 0 ? "today" : `in ${days} days`;
  return `${what}, effective ${f.effectiveDate} (${when})`;
}

/** Most urgent first: red before yellow, then earliest deadline, then undated. */
function byUrgency(today: string) {
  const rank: Record<Severity, number> = { red: 0, yellow: 1, info: 2 };
  return (a: Finding, b: Finding) =>
    rank[severityOf(a, today)] - rank[severityOf(b, today)] ||
    (a.effectiveDate ?? "9999").localeCompare(b.effectiveDate ?? "9999");
}

/** Commit subject for a run, e.g. "monitor: 2026-11-05: 1 red, 2 yellow, 7 green". */
export function commitSubject(date: string, statuses: Pick<IntegrationStatus, "status">[]): string {
  const count = (s: IntegrationStatus["status"]) => statuses.filter((x) => x.status === s).length;
  const parts = [`${count("red")} red`, `${count("yellow")} yellow`, `${count("green")} green`];
  if (count("unknown") > 0) parts.push(`${count("unknown")} unknown`);
  return `monitor: ${date}: ${parts.join(", ")}`;
}

export interface SourceHealth {
  ok: number;
  failed: number;
}

/** A source with no snapshot yet counts as failed: we can't vouch for it. */
export function sourceHealth(manifest: IntegrationManifest, snapshots: Snapshot[]): SourceHealth {
  let ok = 0;
  for (const s of manifest.sources) {
    if (snapshots.find((x) => x.sourceId === s.id)?.ok) ok++;
  }
  return { ok, failed: manifest.sources.length - ok };
}

export function computeStatus(
  manifest: IntegrationManifest,
  findings: Finding[],
  health: SourceHealth,
  today: string,
  lastChecked: string,
): IntegrationStatus {
  const open = findings.filter(isOpen).sort(byUrgency(today));
  const red = open.filter((f) => severityOf(f, today) === "red");
  const yellow = open.filter((f) => severityOf(f, today) === "yellow");
  const total = health.ok + health.failed;
  const failingNote = health.failed > 0 ? `; ${health.failed} of ${total} sources failing` : "";

  const deadlines = findings
    .filter((f) => isActive(f) && f.effectiveDate && severityOf(f, today) !== "info")
    .map((f) => f.effectiveDate!)
    .sort();
  const nextDeadline = deadlines[0];

  let status: IntegrationStatus["status"];
  let reason: string;
  if (red.length) {
    status = "red";
    reason = describe(red[0]!, today) + (red.length > 1 ? ` (+${red.length - 1} more red)` : "") + failingNote;
  } else if (yellow.length) {
    status = "yellow";
    reason = describe(yellow[0]!, today) + (yellow.length > 1 ? ` (+${yellow.length - 1} more)` : "") + failingNote;
  } else if (health.failed > total / 2) {
    status = "unknown";
    reason = `${health.failed} of ${total} sources failed to fetch, so a green here can't be trusted`;
  } else {
    status = "green";
    reason = "No open findings touch what this integration uses" + failingNote;
  }

  return {
    integration: manifest.slug,
    status,
    reason,
    nextDeadline,
    daysToDeadline: nextDeadline ? daysBetween(today, nextDeadline) : undefined,
    openFindings: open.filter((f) => severityOf(f, today) !== "info").length,
    lastChecked,
    sourcesOk: health.ok,
    sourcesFailed: health.failed,
  };
}
