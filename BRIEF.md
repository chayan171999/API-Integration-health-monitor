# Project brief: API Integration Health Monitor

Save this as `BRIEF.md` in an empty repo and tell Claude Code: "Read BRIEF.md and do step 1 of the build order. Stop after each step so I can review."

## 0. Ground rules (override everything below)

* Focused working slice, not a product. 8–10 integrations monitored well beats 100 monitored badly.
* No API keys by default. The core system must run with zero secrets:
   * Change detection and classification are rule-based (keywords, patterns, date extraction, matching against what each integration uses). No LLM is required.
   * The scheduled job uses GitHub Actions' built-in `GITHUB_TOKEN` to commit results. Nothing to create, store or rotate.
   * No authenticated calls to any provider API.
   * The AI layer (section 8) is an optional add-on, switched off unless configured, and the system must work fully without it.
* No paid accounts. Free tiers only: GitHub (repo + Actions), Vercel Hobby (or GitHub Pages).
* If any secret is ever added, it lives only in `.env.local` (gitignored) or GitHub Actions secrets. Commit only `.env.example` with empty values. Never log secrets or send them to the browser.
* Evidence over vibes. Every flag links to the source that caused it, with a quoted excerpt. If the system isn't sure, it says so.
* Simple storage. No database. State is JSON files committed to the repo by the scheduled job, so the git history is the audit log.

## 1. The problem

Any product that connects to third-party APIs (a SaaS app, an automation platform, an AI agent with tools, an internal data pipeline) depends on those APIs staying the same. They don't:

* endpoints get deprecated and later switched off,
* OAuth scopes are renamed, split, or moved behind review,
* API versions are sunset on a published date,
* auth flows change (new token formats, mandatory PKCE, new app requirements),
* rate limits change,
* docs pages move, so links in your docs and code comments break.

Most teams find out when users start reporting failures. That's the worst time: the fix is urgent, users have already had a bad experience, and the warning was usually public weeks earlier in a changelog nobody was watching.

Watching changelogs by hand doesn't scale. At ~10 minutes per integration per week, 50 integrations is ~8 hours a week of reading, and people still miss things.

Goal: a system that watches each integration's provider sources daily, decides whether anything that changed affects what that integration actually uses, and shows each integration as green / yellow / red with the reason, the evidence and the deadline. A human only reads what's flagged.

Who uses it: whoever owns integration quality: an integrations PM, platform engineer, or ops lead. They open one page each morning and know what's broken, what will break and when, and what to fix first.

## 2. What success looks like

1. A dashboard shows every monitored integration with a status, a one-line reason, and days until the nearest deadline.
2. Clicking an integration shows the evidence: the changed source, the excerpt, why it matters to this integration, confidence, and a suggested next action.
3. A scheduled job runs daily with no human involved and commits its results.
4. Irrelevant changes (a new feature in an API you don't use) do not change an integration's status. Low noise is a core requirement.
5. A backtest shows the monitor would have caught real past breaking changes, with how many days of warning it would have given.
6. The README compares the manual baseline (time per integration by hand) with the automated version.

## 3. Scope

### In scope

* 8–10 integrations across different providers. Suggested: GitHub, Slack, Notion, Gmail (Google Workspace), Google Calendar, Stripe, HubSpot, Linear, Discord, Zoom. Swap any whose public sources are hard to reach.
* A manifest per integration describing what it uses and which public sources to watch.
* Daily collection, change detection, rule-based classification, status scoring.
* Dashboard: overview, detail page, metrics, backtest.
* Backtest on 3–5 real historical breaking changes plus some irrelevant entries.
* A daily digest as a Markdown file in the repo.

### Out of scope (say so in README)

* Fixing integrations.
* Authenticated API probes.
* User accounts, admin UI, multi-tenant anything.

## 4. Tech stack

* Language: TypeScript throughout.
* Monitor: Node script in `/monitor`, run by GitHub Actions on a daily cron (plus manual `workflow_dispatch`). It writes JSON into `/data` and commits using the built-in `GITHUB_TOKEN` (`permissions: contents: write`).
* Dashboard: Next.js (App Router, static export) + Tailwind, reading the JSON at build time. Deploy on Vercel Hobby or GitHub Pages; each commit triggers a rebuild.
* Validation: Zod schemas for every JSON file.
* Parsing: `rss-parser` for feeds, an HTML-to-readable-text library for pages, `chrono-node` (or similar) for extracting dates from text.
* Ask before adding other dependencies.

## 5. Data model (`lib/schema.ts`)

### 5.1 Integration manifest — `/data/integrations/<slug>.json` (written by hand)

```ts
interface IntegrationManifest {
  slug: string;                 // "slack"
  name: string;                 // "Slack"
  provider: string;
  authMethod: "oauth2" | "api_key" | "bearer" | "basic" | "other";
  apiVersion?: string;          // version you're pinned to, if any
  uses: {
    endpoints: string[];        // e.g. ["chat.postMessage", "conversations.list"]
    scopes: string[];           // e.g. ["chat:write", "channels:read"]
    webhooksOrEvents: string[]; // e.g. ["message.channels"]
    keywords?: string[];        // extra terms that make a change relevant, e.g. ["legacy tokens"]
  };
  sources: {
    id: string;                 // "slack-changelog"
    type: "rss" | "changelog_page" | "deprecations_page" | "status_page" | "docs_page";
    url: string;
    note?: string;
  }[];
  docLinks: string[];           // docs URLs your own docs/code point to (checked for 404s/redirects)
}
```

### 5.2 Snapshot — `/data/snapshots/<slug>/<sourceId>.json`

Last fetched normalised text split into blocks (or feed item IDs), a hash per block, fetch time, HTTP status. Used only to detect what changed since the last run.

### 5.3 Finding — `/data/findings/<slug>.json`

```ts
type Severity = "red" | "yellow" | "info";
type Category =
  | "endpoint_deprecated" | "endpoint_removed"
  | "scope_changed" | "auth_change"
  | "version_sunset" | "rate_limit_change"
  | "webhook_change" | "broken_doc_link"
  | "provider_incident" | "other";

interface Finding {
  id: string;                   // stable hash of source url + key excerpt
  integration: string;
  sourceId: string;
  sourceUrl: string;
  detectedAt: string;           // ISO date first seen
  publishedAt?: string;         // date on the announcement, if stated
  effectiveDate?: string;       // when it breaks / sunsets, if stated
  category: Category;
  severity: Severity;
  affects: string[];            // manifest items it touches
  matchedTerms: string[];       // which keywords/patterns fired (explains the decision)
  excerpt: string;              // quote from the source, <= 300 chars
  summary: string;              // what changed and why it matters to THIS integration (template-generated; AI-written only if section 8 is on)
  suggestedAction: string;      // template, e.g. "Review use of chat.postMessage before 2026-12-01"
  confidence: "high" | "medium" | "low";
  classifiedBy: "rules" | "ai";
  status: "open" | "acknowledged" | "resolved" | "dismissed";
  dismissReason?: string;
}
```

### 5.4 Status — `/data/status.json` (computed, never hand-edited)

```ts
interface IntegrationStatus {
  integration: string;
  status: "green" | "yellow" | "red" | "unknown";
  reason: string;
  nextDeadline?: string;
  daysToDeadline?: number;
  openFindings: number;
  lastChecked: string;
  sourcesOk: number;
  sourcesFailed: number;
}
```

### 5.5 Run log — `/data/runs/<date>.json`

Integrations checked, sources fetched / failed, changed blocks, findings created, duration. Feeds the metrics page.

## 6. Rule-based classifier (the core, no API keys)

Runs only on new feed items or changed text blocks.

1. Category detection with keyword/regex patterns, e.g.:
   * `deprecat(ed|ion|ing)`, `will be (retired|removed|sunset)`, `end of life`, `no longer supported` → deprecation
   * `removed`, `has been (shut down|turned off|disabled)`, `returns 410` → removal
   * `scope(s)?` near `rename|replace|split|require|review` → scope change
   * `token|oauth|pkce|authorization|client secret` near `change|require|new` → auth change
   * `version \S+ (will be|is) (sunset|retired)` → version sunset
   * `rate limit` near `change|reduce|new` → rate-limit change
   * incident / outage wording on status pages → provider incident

   Keep patterns in one file (`monitor/rules.ts`) so they're easy to read and tune.
2. Relevance: the block must mention at least one item from `uses` (endpoint, scope, event, keyword, or the pinned API version). Exact and simple fuzzy matching (case, dots vs slashes, plurals). No match → `affects: []` → severity `info`.
3. Dates: extract dates near words like "on", "by", "starting", "after", "effective". The nearest future date becomes `effectiveDate`. Never invent one.
4. Confidence:
   * high: category pattern + exact manifest match + a stated date,
   * medium: category pattern + exact match, no date,
   * low: fuzzy match only, or conflicting patterns.
5. Summary and action come from templates, e.g. "Slack changelog mentions `chat.postMessage` alongside deprecation language, effective 2026-12-01. Review usage before then."
6. Dedupe: the same announcement seen again, or on two sources, updates the existing finding.

## 7. Status rules (deterministic code, testable)

Red if any open finding:

* is `endpoint_removed`, or `version_sunset` / `endpoint_deprecated` / `scope_changed` / `auth_change` with `effectiveDate` within 30 days or already past, and `affects` is non-empty.

Yellow if any open finding:

* touches a used item but the deadline is > 30 days away or unstated,
* is a `broken_doc_link`,
* is an ongoing `provider_incident`,
* or has `low` confidence on something that would otherwise be red.

Unknown if more than half the integration's sources failed to fetch.

Green otherwise. Findings with empty `affects` are `info`: visible on the detail page, never change status.

Write unit tests for these rules.

## 8. Optional AI layer (off by default)

The system must be complete without this. Add it only after the backtest shows where rules fall short.

* What it does: re-checks only findings the rules marked `low` or `medium` confidence, plus changed blocks with category language but no manifest match. It returns category, affects, dates, a better summary and confidence, validated with Zod. It may not raise severity without a quoted excerpt.
* Preferred no-key option: GitHub Models called from the Action with the built-in `GITHUB_TOKEN` (`permissions: models: read`). Verify this is still available and free for the account before building it; if not, skip it.
* Alternative: any LLM API key stored as an Actions secret, read from env. If the env var is missing, the step is skipped and logged, never an error.
* Cap calls per run. Mark AI-classified findings `classifiedBy: "ai"`.
* In the backtest, report rules-only vs rules+AI side by side.

## 9. Pipeline (`/monitor`)

1. Collect: fetch each source (respect robots.txt, polite generic User-Agent, timeout, one retry). RSS → new item IDs. Pages → readable text split into blocks.
2. Diff: compare with snapshot; only new items or changed blocks go forward.
3. Link check: HEAD/GET each `docLinks` URL; 404/410 or redirect to a generic page → `broken_doc_link`.
4. Classify: section 6 rules (then section 8 if enabled).
5. Score: section 7 → `status.json`.
6. Digest: `/data/digests/<date>.md` with new reds, new yellows, and deadlines in the next 14 days.
7. Commit: message like `monitor: 2026-11-05: 1 red, 2 yellow, 7 green`.

## 10. Dashboard pages

1. `/` Overview: counts by status; table sorted red → yellow → unknown → green, then by days to deadline (integration, status, reason, next deadline, last checked); an "upcoming deadlines" strip for the next 60 days.
2. `/integrations/[slug]` Detail: status and reason; what the integration uses; sources with fetch health; open findings with category, severity, affects, matched terms, dates, excerpt, source link, confidence, suggested action; info findings collapsed; status history from run logs.
3. `/metrics`: integrations monitored; % green; open findings by severity; sources OK vs failed (the monitor's own health); noise rate (dismissed ÷ total findings); lead time (days between `detectedAt` and `effectiveDate`).
4. `/backtest`: results table from section 11.

Acknowledging or dismissing a finding = editing its JSON via a commit or PR. A UI for this is listed as a next step.

## 11. Backtest (what makes it credible)

1. Find 3–5 real, publicly announced breaking changes from the last 1–2 years across the monitored providers. Verify each from the provider's own changelog or deprecation page. Record announcement date, effective date and source link in `/data/backtest/cases.json`.
2. Pick 3–5 irrelevant changelog entries (features in APIs the manifests don't use) as negatives.
3. Store the announcement text in the case file (paste it manually if no archive is reachable, and note that).
4. Run classify + score on each case against the relevant manifest.
5. Report: caught or missed, correct category and affects, stayed quiet on negatives, days of warning it would have given.
6. Log what it got wrong and what you changed (rules, manifest) in `docs/backtest.md`.

## 12. Build order

Do these one at a time. Finish and check each before starting the next; stop after each step for review.

1. Repo scaffold, Zod schemas, manifests for 3 integrations (e.g. GitHub, Slack, Stripe) with sources verified reachable. Fetch script writing snapshots. Run locally.
2. Diff, link check, rule-based classifier, dedupe, status scoring, unit tests for rules. Run twice locally to confirm unchanged sources produce no new findings.
3. Dashboard overview and detail pages reading the JSON. Deploy.
4. GitHub Action on a daily cron, committing with `GITHUB_TOKEN`.
5. Expand to 8–10 integrations. Run log, digest and `/metrics`.
6. Backtest, `/backtest` page, `docs/backtest.md`. Tune rules from what it missed.
7. Optional: AI layer (section 8), with rules-only vs rules+AI comparison in the backtest.
8. README; final deploy; screenshots.

## 13. README must cover

* The problem in one paragraph and who it's for.
* Manual baseline vs automated: time to check one integration by hand (timed for 2–3 integrations), extrapolated; the monitor's run time and cost (zero without the AI layer).
* Key decisions: no API keys by default; manifest of "what we use" so only relevant changes alert; rules first, AI only as an optional second opinion on uncertain cases; deterministic status rules; JSON-in-git as storage and audit log; `unknown` instead of false green when sources fail.
* Backtest results and what was corrected.
* Metrics shown and why.
* Limitations: depends on providers announcing changes publicly; manifests are hand-written; keyword rules miss changes phrased unusually; page diffs can be noisy; no live API checks.
* What's next: generating manifests from code, live smoke tests with test accounts, opening tickets for reds, owner routing and time-to-resolve tracking, using dismissals to tune rules, scaling to hundreds of integrations.
* Setup: `npm install`, run the monitor locally, run the dashboard, enable the Action. No keys needed.
