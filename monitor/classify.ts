/**
 * Rule-based classifier (BRIEF section 6). Turns one changed entry into a Finding,
 * or null when no category pattern fires. Every decision is recorded in
 * matchedTerms so a flag can be explained without reading this code.
 */
import type { Category, Finding, IntegrationManifest, SourceType } from "../lib/schema.ts";
import { daysBetween, findDates, headingYear, leadingDate, pickEffectiveDate, type FoundDate } from "./dates.ts";
import { affectedItems, findMatches, termsFor } from "./match.ts";
import {
  BASELINE_MAX_AGE_DAYS,
  CATEGORY_PRIORITY,
  CATEGORY_RULES,
  CONFLICT_PATTERNS,
  INCIDENT_STALE_DAYS,
  ONGOING_LABELS,
  RESOLVED_LABELS,
  RESOLVED_PROSE,
  STATUS_UPDATE_LABEL,
  VERSION_IN_HEADING,
} from "./rules.ts";
import { severityOf } from "./score.ts";
import { normalizeText, shortHash } from "./util.ts";

/** One unit of changed content: a feed item, or one entry of a page block. */
export interface Candidate {
  integration: string;
  sourceId: string;
  sourceType: SourceType;
  /** Human label for templates, e.g. "Slack changelog feed". */
  sourceLabel: string;
  /** The source's own URL; part of the finding id. */
  sourceUrl: string;
  /** Where a human should click: the feed item's link, or page URL + #anchor. */
  evidenceUrl: string;
  /** Stable key within the source: feed item id, or the entry's first line. */
  key: string;
  title?: string;
  /** Heading path of the page block, e.g. "Breaking changes › Version 2026-03-10". */
  context?: string;
  categories?: string[];
  text: string;
  /** The whole block the entry came from; used only as a fallback for dates. */
  blockText?: string;
  publishedAt?: string;
  /**
   * Pages only: date of the nearest dated block at or above this one, in page order.
   * Lets a first run tell that "June" under an old section is old. Never a deadline.
   */
  pageDate?: string;
}

export interface ClassifyOptions {
  today: string; // YYYY-MM-DD
  /** First run for this source: skip old history instead of flagging years of changelog. */
  baseline: boolean;
}

const EXCERPT_MAX = 300;

const CATEGORY_WORD: Partial<Record<Category, string>> = {
  endpoint_deprecated: "deprecation",
  endpoint_removed: "removal",
  version_sunset: "version-sunset",
  scope_changed: "scope-change",
  auth_change: "auth-change",
  rate_limit_change: "rate-limit-change",
  webhook_change: "webhook-change",
};

const SOURCE_LABEL: Record<SourceType, string> = {
  rss: "changelog feed",
  changelog_page: "changelog",
  deprecations_page: "deprecations page",
  status_page: "status page",
  docs_page: "docs page",
};

export function sourceLabel(manifest: IntegrationManifest, type: SourceType): string {
  return `${manifest.name} ${SOURCE_LABEL[type]}`;
}

/** A quote of at most 300 chars around the interesting positions, cut at word boundaries. */
export function makeExcerpt(text: string, anchors: number[], max = EXCERPT_MAX): string {
  const flat = text.replace(/\s/g, " ");
  if (flat.trim().length <= max) return normalizeText(flat);
  const lo = Math.max(0, Math.min(...anchors));
  const hi = Math.max(...anchors);
  const budget = max - 2; // room for two ellipses
  let start = Math.max(0, lo - 80);
  if (hi - start > budget - 40) start = Math.max(0, lo - 40);
  let end = Math.min(flat.length, start + budget);
  if (end === flat.length) start = Math.max(0, end - budget);
  if (start > 0) {
    const sp = flat.indexOf(" ", start);
    if (sp !== -1 && sp < lo) start = sp + 1;
  }
  if (end < flat.length) {
    const sp = flat.lastIndexOf(" ", end);
    if (sp > start) end = sp;
  }
  const core = normalizeText(flat.slice(start, end));
  return (start > 0 ? "…" : "") + core + (end < flat.length ? "…" : "");
}

function quoteList(items: string[], max = 3): string {
  const q = items.slice(0, max).map((i) => `\`${i}\``);
  const rest = items.length > max ? ` and ${items.length - max} more` : "";
  if (q.length <= 1) return q.join("") + rest;
  return q.slice(0, -1).join(", ") + " and " + q.at(-1) + rest;
}

export function classifyEntry(c: Candidate, manifest: IntegrationManifest, opts: ClassifyOptions): Finding | null {
  const header = [c.title, c.context].filter(Boolean).join("\n");
  const full = header ? `${header}\n${c.text}` : c.text;
  const labels = c.categories?.length ? `\n[${c.categories.join(", ")}]` : "";
  const detectOn = full + labels;

  // 1. Category: every rule that fires, highest-priority category wins.
  const hits = CATEGORY_RULES.map((rule) => ({ rule, m: rule.pattern.exec(detectOn) })).filter(
    (h): h is { rule: (typeof CATEGORY_RULES)[number]; m: RegExpExecArray } => h.m !== null,
  );
  if (hits.length === 0) return null;
  hits.sort((a, b) => CATEGORY_PRIORITY.indexOf(a.rule.category) - CATEGORY_PRIORITY.indexOf(b.rule.category));
  const category = hits[0]!.rule.category;
  const categoryHit = hits[0]!.m;

  // 2. Version scoping: a change listed under an API version other than the pinned one.
  let appliesToVersion: string | undefined;
  const vm = c.context ? VERSION_IN_HEADING.exec(c.context) : null;
  if (vm && manifest.apiVersion && /^\d{4}-\d{2}-\d{2}/.test(manifest.apiVersion)) {
    const pinned = manifest.apiVersion.slice(0, 10);
    if (vm[1]! < pinned) return null; // already part of the version we're pinned to
    if (vm[1]! > pinned) appliesToVersion = vm[2] ? `${vm[1]}.${vm[2]}` : vm[1];
  }

  // 3. Relevance against the manifest.
  const matches = findMatches(full, termsFor(manifest));
  const affects = affectedItems(matches);
  const exact = matches.some((m) => m.exact);

  // 4. Dates: from the entry; fall back to its block (e.g. a deadline in another paragraph).
  const reference = new Date((c.publishedAt ?? opts.today).slice(0, 10) + "T12:00:00Z");
  let dates: FoundDate[] = findDates(c.text, reference);
  if (!dates.some((d) => d.triggered) && c.blockText && c.blockText !== c.text) {
    dates = dates.concat(findDates(c.blockText, reference));
  }
  const allowPast = category === "endpoint_removed" || category === "version_sunset";
  const effective = pickEffectiveDate(dates, opts.today, allowPast);
  const publishedAt = c.publishedAt?.slice(0, 10) ?? leadingDate(c.blockText ?? c.text, reference);

  // 5. First run: don't flag years of history. Version-scoped entries are kept (upgrade notes).
  if (opts.baseline && !appliesToVersion) {
    // Also: a year in the heading path ("Changelog › 2020"), or the nearest dated block above on the page.
    const known = [
      publishedAt,
      ...dates.map((d) => d.date),
      ...(c.context ? findDates(c.context, reference).map((d) => d.date) : []),
      headingYear(c.context),
      c.pageDate,
    ]
      .filter((d): d is string => !!d)
      .sort();
    const newest = known.at(-1);
    const upcoming = effective && effective.date >= opts.today;
    if (newest && daysBetween(newest, opts.today) > BASELINE_MAX_AGE_DAYS && !upcoming) return null;
  }

  // 6. Confidence (BRIEF 6.4).
  const conflicts = CONFLICT_PATTERNS.filter((p) => p.pattern.test(full));
  const confidence: Finding["confidence"] =
    affects.length === 0 || !exact || conflicts.length ? "low" : effective ? "high" : "medium";

  // 7. Evidence trail.
  const matchedTerms = [
    ...hits.map((h) => `pattern:${h.rule.name} "${normalizeText(h.m[0]).slice(0, 40)}"`),
    ...matches.map((m) => `${m.exact ? "uses" : "fuzzy"}:${m.term} "${m.matchedText}"`),
    ...(effective ? [`date:${effective.date} "${effective.text}"`] : []),
    ...(appliesToVersion ? [`version:${appliesToVersion} (pinned ${manifest.apiVersion})`] : []),
    ...conflicts.map((p) => `conflict:${p.name}`),
  ].filter((t, i, all) => all.indexOf(t) === i);

  // Quote the source itself (title + text), not the heading path we joined with "›",
  // unless the evidence only appears in the heading.
  const firstExact = matches.find((m) => m.exact) ?? matches[0];
  const quote = [c.title, c.text].filter(Boolean).join("\n");
  const inQuote = [categoryHit[0].replace(/^[\s›]+/, ""), firstExact?.matchedText].filter((s): s is string => !!s).map((s) => quote.indexOf(s));
  const excerpt =
    inQuote.length > 0 && inQuote.every((i) => i >= 0)
      ? makeExcerpt(quote, inQuote)
      : makeExcerpt(full, [categoryHit.index < full.length ? categoryHit.index : 0, ...(firstExact ? [firstExact.index] : [])]);

  // 8. Template summary + action.
  const word = CATEGORY_WORD[category] ?? "change";
  const items = quoteList(affects);
  let summary: string;
  let suggestedAction: string;
  if (affects.length === 0) {
    summary = `${c.sourceLabel} has ${word} language, but none of the endpoints, scopes, events or keywords ${manifest.name} uses are mentioned. Informational only.`;
    suggestedAction = "No action needed unless you start using what this changes.";
  } else {
    const when = effective
      ? `, effective ${effective.date}` + (effective.approximate ? ` (stated as "${effective.text}"; no exact day given)` : "")
      : ", with no date stated";
    summary = `${c.sourceLabel} mentions ${items} alongside ${word} language${when}.`;
    if (appliesToVersion) {
      summary += ` It is listed under API version ${appliesToVersion}; ${manifest.name} is pinned to ${manifest.apiVersion}, so it applies only when you upgrade.`;
    }
    if (!exact) summary += " The match is approximate (spelling or case differs), so confidence is low.";
    if (conflicts.length) summary += ` The text also has wording that may walk the change back (${conflicts.map((p) => p.name).join(", ")}).`;

    if (appliesToVersion) {
      suggestedAction = `No action while pinned to ${manifest.apiVersion}. Review before upgrading to ${appliesToVersion}.`;
    } else if (effective && effective.date >= opts.today) {
      suggestedAction = `Review use of ${items} before ${effective.date}.`;
    } else if (effective) {
      suggestedAction = `Check that ${items} still works: the stated date (${effective.date}) has passed.`;
    } else if (category === "endpoint_removed") {
      suggestedAction = `Check that ${items} still works and plan a migration now.`;
    } else {
      suggestedAction = `Review use of ${items} and confirm the timeline with ${manifest.provider}.`;
    }
  }

  const base = {
    category,
    affects,
    effectiveDate: effective?.date,
    confidence,
    appliesToVersion,
  };
  return {
    id: shortHash(`${c.sourceUrl}\n${c.key}`),
    integration: c.integration,
    sourceId: c.sourceId,
    sourceUrl: c.evidenceUrl,
    detectedAt: opts.today,
    publishedAt,
    effectiveDate: base.effectiveDate,
    category,
    severity: severityOf(base, opts.today),
    affects,
    matchedTerms,
    excerpt,
    summary,
    suggestedAction,
    confidence,
    classifiedBy: "rules",
    status: "open",
    appliesToVersion,
    lastSeenAt: opts.today,
  };
}

export type IncidentState = "ongoing" | "resolved" | "scheduled";

export function incidentState(text: string, publishedAt: string | undefined, today: string): IncidentState {
  const label = STATUS_UPDATE_LABEL.exec(text)?.[1];
  let state: IncidentState;
  if (label) {
    state = ONGOING_LABELS.has(label) ? "ongoing" : RESOLVED_LABELS.has(label) ? "resolved" : "scheduled";
  } else {
    state = RESOLVED_PROSE.test(text) ? "resolved" : "ongoing";
  }
  if (state === "ongoing" && publishedAt && daysBetween(publishedAt, today) > INCIDENT_STALE_DAYS) state = "resolved";
  return state;
}

/**
 * Status-page items. Returns an open finding for an ongoing incident, a resolved one
 * (so an existing finding can be closed), or null for scheduled maintenance.
 */
export function classifyIncident(c: Candidate, manifest: IntegrationManifest, opts: ClassifyOptions): Finding | null {
  const state = incidentState(c.text, c.publishedAt, opts.today);
  if (state === "scheduled") return null;
  const full = [c.title, c.text].filter(Boolean).join("\n");
  const matches = findMatches(full, termsFor(manifest, { statusPage: true }));
  const affects = affectedItems(matches);
  const label = STATUS_UPDATE_LABEL.exec(c.text)?.[1];
  const latest = c.text.split("\n").find((l) => STATUS_UPDATE_LABEL.test(l) || l.length > 40) ?? c.text;
  const excerpt = makeExcerpt(`${c.title ?? ""}: ${latest}`, [0]);

  const summary =
    state === "ongoing"
      ? `${manifest.provider} status page reports an ongoing incident` +
        (affects.length ? ` affecting ${quoteList(affects)}` : ` in components ${manifest.name} doesn't list as used`) +
        (label ? ` (latest update: ${label}).` : ".")
      : `${manifest.provider} status page marks this incident resolved.`;
  const suggestedAction =
    state === "ongoing" && affects.length
      ? `Watch for failures in ${quoteList(affects)} until ${manifest.provider} marks this resolved.`
      : "No action needed.";

  const base = { category: "provider_incident" as const, affects, effectiveDate: undefined, confidence: affects.length ? ("high" as const) : ("low" as const), appliesToVersion: undefined };
  return {
    id: shortHash(`${c.sourceUrl}\n${c.key}`),
    integration: c.integration,
    sourceId: c.sourceId,
    sourceUrl: c.evidenceUrl,
    detectedAt: opts.today,
    publishedAt: c.publishedAt?.slice(0, 10),
    category: "provider_incident",
    severity: severityOf(base, opts.today),
    affects,
    matchedTerms: [
      `incident:${state}${label ? ` "${label}"` : ""}`,
      ...matches.map((m) => `uses:${m.term} "${m.matchedText}"`),
    ].filter((t, i, all) => all.indexOf(t) === i),
    excerpt,
    summary,
    suggestedAction,
    confidence: base.confidence,
    classifiedBy: "rules",
    status: state === "ongoing" ? "open" : "resolved",
    lastSeenAt: opts.today,
  };
}
