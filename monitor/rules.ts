/**
 * Every pattern the rule-based classifier uses lives in this file (BRIEF section 6),
 * so it can be read and tuned in one place. No LLM, no API keys.
 *
 * A finding needs BOTH a category pattern (this file) and, to affect status, a
 * mention of something the integration uses (match.ts). Patterns only decide
 * *what kind* of change it is.
 */
import type { Category } from "../lib/schema.ts";

export interface CategoryRule {
  category: Exclude<Category, "broken_doc_link" | "provider_incident" | "other">;
  /** Short name shown in matchedTerms, so every flag explains itself. */
  name: string;
  pattern: RegExp;
}

/** `a` and `b` within `maxChars` of each other, in either order, inside one sentence-ish span. */
function near(a: RegExp, b: RegExp, maxChars = 60): RegExp {
  const gap = `[^.!?\\n]{0,${maxChars}}?`;
  return new RegExp(`(?:${a.source})${gap}(?:${b.source})|(?:${b.source})${gap}(?:${a.source})`, "i");
}

const CHANGE_VERB = /\b(?:chang|renam|replac|split|requir|review|deprecat|remov|new|granular|mandatory|enforc|must)\w*/;

export const CATEGORY_RULES: CategoryRule[] = [
  // --- Removal: already gone, or the changelog verb "Removes X" ---------------
  { category: "endpoint_removed", name: "has-been-removed", pattern: /\b(?:has|have) been (?:removed|retired|shut down|turned off|disabled|discontinued|sunset)\b/i },
  { category: "endpoint_removed", name: "is-now-removed", pattern: /\b(?:is|are|was|were) (?:now )?(?:removed|retired|discontinued|shut down|turned off|no longer available)\b/i },
  { category: "endpoint_removed", name: "returns-410", pattern: /\breturns? (?:an? )?(?:HTTP )?(?:status )?410\b/i },
  { category: "endpoint_removed", name: "removes-verb", pattern: /(?:^|\n|›\s*)(?:remove|removes|removed|removing)\b/i },
  { category: "endpoint_removed", name: "retired", pattern: /(?<!\b(?:will be|to be|being|be) )\bretired\b/i },
  { category: "endpoint_removed", name: "no-longer-works", pattern: /\bno longer (?:available|works?|accessible|returns?)\b/i },

  // --- Version sunset ---------------------------------------------------------
  { category: "version_sunset", name: "version-will-be-sunset", pattern: /\bversion\s+\S+\s+(?:will be|is|has been)\s+(?:sunset|retired|deprecated|removed|closing down|discontinued|unsupported)\b/i },
  { category: "version_sunset", name: "version-end-of-support", pattern: /\b(?:api )?versions?\b[^.\n]{0,60}\b(?:sunset|end of support|no longer supported|reach(?:es)? end of)/i },

  // --- Deprecation: still works, will stop ------------------------------------
  { category: "endpoint_deprecated", name: "deprecat*", pattern: /\bdeprecat(?:e|ed|es|ion|ions|ing)\b/i },
  { category: "endpoint_deprecated", name: "will-be-retired", pattern: /\bwill (?:be )?(?:retired|removed|sunset|discontinued|shut ?down|turned off|disabled|closing down|stop working|no longer (?:be )?(?:supported|available|work))\b/i },
  { category: "endpoint_deprecated", name: "end-of-life", pattern: /\bend[- ]of[- ](?:life|support)\b/i },
  { category: "endpoint_deprecated", name: "no-longer-supported", pattern: /\bno longer (?:be )?supported\b/i },
  { category: "endpoint_deprecated", name: "sunset", pattern: /\bsunset(?:s|ting)?\b/i },
  { category: "endpoint_deprecated", name: "scheduled-for-removal", pattern: /\bscheduled for (?:removal|retirement|deprecation)\b/i },

  // --- Scope / auth / rate limit / webhook ------------------------------------
  { category: "scope_changed", name: "scope-near-change", pattern: near(/\bscopes?\b/, CHANGE_VERB) },
  {
    category: "auth_change",
    name: "auth-near-change",
    pattern: near(
      /\b(?:tokens?|oauth|pkce|authori[sz]ation|authenticat\w*|client secrets?|refresh tokens?|api keys?)\b/,
      /\b(?:chang|requir|new|deprecat|rotat|expir|enforc|mandatory|must)\w*/,
    ),
  },
  {
    category: "rate_limit_change",
    name: "rate-limit-near-change",
    pattern: near(/\brate[- ]limit(?:s|ed|ing)?\b/, /\b(?:chang|reduc|new|lower|increas|tier|updat|enforc|appl|adjust)\w*/),
  },
  {
    category: "webhook_change",
    name: "webhook-near-change",
    pattern: near(
      /\b(?:webhooks?|event payloads?|events api|event subscriptions?)\b/,
      /\b(?:chang|renam|remov|deprecat|no longer|replac|new field|format)\w*/,
    ),
  },
];

/** When several categories fire, the first in this list wins. */
export const CATEGORY_PRIORITY: Category[] = [
  "endpoint_removed",
  "version_sunset",
  "endpoint_deprecated",
  "scope_changed",
  "auth_change",
  "rate_limit_change",
  "webhook_change",
];

/** Language that walks a change back. Any hit makes confidence "low" (BRIEF 6.4: conflicting patterns). */
export const CONFLICT_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "postponed", pattern: /\b(?:postpon|delay|extend|paus)\w*/i },
  { name: "reversed", pattern: /\b(?:revers|cancel|rolled back|roll back|undeprecat|un-deprecat)\w*/i },
  { name: "no-longer-deprecated", pattern: /\bno longer (?:be )?deprecated\b/i },
];

/**
 * A date only counts as a deadline when one of these words precedes it closely
 * ("on", "by", "starting", "after", "effective", ...). Bare dates (post dates,
 * version names) never become an effectiveDate.
 */
export const DATE_TRIGGER = /\b(?:on|by|starting|start(?:s|ing)? on|after|effective|beginning|until|as of|no later than|before|from|through|in)\b[^.\n]{0,12}$/i;

/** How far before a date (in characters) to look for a trigger word. */
export const DATE_TRIGGER_WINDOW = 25;

// ---------------------------------------------------------------------------
// Status pages
// ---------------------------------------------------------------------------

/** Atlassian Statuspage-style update labels; the first one in a feed item is the latest. */
export const STATUS_UPDATE_LABEL =
  /\b(Investigating|Identified|Monitoring|Update|Resolved|Completed|Postmortem|Scheduled|In progress|Verifying)\s+-\s/;

export const ONGOING_LABELS = new Set(["Investigating", "Identified", "Monitoring", "Update", "In progress", "Verifying"]);
export const RESOLVED_LABELS = new Set(["Resolved", "Completed", "Postmortem"]);

/** For status feeds without labels (e.g. Slack): prose that means it's over. */
export const RESOLVED_PROSE =
  /\b(?:has been|have been|was|were|is now|are now)\s+(?:resolved|fixed|restored|mitigated)\b|\bwe(?:'ve| have) fixed\b|\bfunctioning normally\b|\bresolved\b/i;

/** An incident still "ongoing" after this many days is treated as stale, not current. */
export const INCIDENT_STALE_DAYS = 3;

// ---------------------------------------------------------------------------
// API versions in headings, e.g. "Version 2026-03-10" (GitHub) or "2026-09-30.endive" (Stripe)
// ---------------------------------------------------------------------------

export const VERSION_IN_HEADING = /\b(\d{4}-\d{2}-\d{2})(?:\.([a-z]+))?\b/;

/** On a first run (no previous snapshot), ignore entries whose newest date is older than this. */
export const BASELINE_MAX_AGE_DAYS = 180;
