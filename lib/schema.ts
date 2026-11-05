/**
 * Zod schemas for every JSON file under /data (BRIEF section 5).
 * The monitor validates on read and on write; the dashboard validates at build time.
 */
import { z } from "zod";

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase slug (a-z, 0-9, -)");
const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();
const hash = z.string().regex(/^[0-9a-f]{16}$/, "16-char hex hash");

// ---------------------------------------------------------------------------
// 5.1 Integration manifest — /data/integrations/<slug>.json (hand-written)
// ---------------------------------------------------------------------------

export const AuthMethod = z.enum(["oauth2", "api_key", "bearer", "basic", "other"]);

export const SourceType = z.enum([
  "rss",
  "changelog_page",
  "deprecations_page",
  "status_page",
  "docs_page",
]);
export type SourceType = z.infer<typeof SourceType>;

export const Source = z.object({
  id: slug,
  type: SourceType,
  url: z.url({ protocol: /^https$/ }),
  note: z.string().optional(),
  /**
   * Extension to the brief: optional CSS selector for the main content of an HTML
   * page, so site chrome (nav, sidebars, "in this article" lists) does not create
   * diff noise. Ignored for feeds. Defaults to main/article/body.
   */
  selector: z.string().optional(),
});
export type Source = z.infer<typeof Source>;

export const IntegrationManifest = z
  .object({
    slug,
    name: z.string().min(1),
    provider: z.string().min(1),
    authMethod: AuthMethod,
    apiVersion: z.string().optional(),
    uses: z.object({
      endpoints: z.array(z.string().min(1)),
      scopes: z.array(z.string().min(1)),
      webhooksOrEvents: z.array(z.string().min(1)),
      keywords: z.array(z.string().min(1)).optional(),
      /**
       * Extension to the brief: component names as they appear on the provider's
       * status page (case-sensitive), e.g. ["API Requests", "Webhooks"]. Only these
       * make an incident relevant; an outage in a product you don't use stays info.
       */
      statusComponents: z.array(z.string().min(1)).optional(),
    }),
    sources: z.array(Source).min(1),
    docLinks: z.array(z.url({ protocol: /^https$/ })),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    for (const s of m.sources) {
      if (seen.has(s.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate source id "${s.id}"`, path: ["sources"] });
      }
      seen.add(s.id);
    }
  });
export type IntegrationManifest = z.infer<typeof IntegrationManifest>;

// ---------------------------------------------------------------------------
// 5.2 Snapshot — /data/snapshots/<slug>/<sourceId>.json
// Only used to detect what changed since the last run.
// ---------------------------------------------------------------------------

/** A feed entry. Only IDs + a content hash are kept; the text is re-read from the live feed. */
export const SnapshotItem = z.object({
  id: z.string().min(1),
  title: z.string(),
  link: z.string().optional(),
  publishedAt: isoDateTime.optional(),
  hash,
});
export type SnapshotItem = z.infer<typeof SnapshotItem>;

/** A section of a page: one heading plus the text under it (long sections are chunked). */
export const SnapshotBlock = z.object({
  id: z.string().min(1), // heading slug + occurrence/chunk index; stable across runs
  heading: z.string().optional(),
  /** id attribute of the nearest heading, for deep links in evidence (url#anchor). */
  anchor: z.string().optional(),
  text: z.string(),
  hash,
  /**
   * Hash per entry (a top-level list item, or a paragraph) inside the block. The diff
   * classifies only entries whose hash is new, not every entry of a changed block.
   */
  entryHashes: z.array(hash).optional(),
});
export type SnapshotBlock = z.infer<typeof SnapshotBlock>;

export const Snapshot = z.object({
  integration: slug,
  sourceId: slug,
  url: z.url(),
  sourceType: SourceType,
  format: z.enum(["feed", "page"]).optional(), // unset until the first successful fetch
  /** Time of the most recent fetch attempt (success or failure). */
  lastAttemptAt: isoDateTime,
  /** Time of the most recent successful fetch; the content below is from this fetch. */
  fetchedAt: isoDateTime.optional(),
  httpStatus: z.number().int().nullable(), // null = network error / blocked before a response
  ok: z.boolean(),
  error: z.string().optional(),
  finalUrl: z.string().optional(), // after redirects
  consecutiveFailures: z.number().int().min(0),
  /** Hash over all item/block hashes: a cheap "did anything change at all" check. */
  contentHash: hash.optional(),
  items: z.array(SnapshotItem),
  blocks: z.array(SnapshotBlock),
});
export type Snapshot = z.infer<typeof Snapshot>;

// ---------------------------------------------------------------------------
// 5.3 Finding — /data/findings/<slug>.json (array of findings)
// ---------------------------------------------------------------------------

export const Severity = z.enum(["red", "yellow", "info"]);
export type Severity = z.infer<typeof Severity>;

export const Category = z.enum([
  "endpoint_deprecated",
  "endpoint_removed",
  "scope_changed",
  "auth_change",
  "version_sunset",
  "rate_limit_change",
  "webhook_change",
  "broken_doc_link",
  "provider_incident",
  "other",
]);
export type Category = z.infer<typeof Category>;

export const Finding = z.object({
  id: hash, // stable hash of source url + key excerpt
  integration: slug,
  sourceId: slug,
  sourceUrl: z.url(),
  detectedAt: isoDate,
  publishedAt: isoDate.optional(),
  effectiveDate: isoDate.optional(),
  category: Category,
  severity: Severity,
  affects: z.array(z.string()),
  matchedTerms: z.array(z.string()),
  excerpt: z.string().max(300),
  summary: z.string(),
  suggestedAction: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  classifiedBy: z.enum(["rules", "ai"]),
  status: z.enum(["open", "acknowledged", "resolved", "dismissed"]),
  dismissReason: z.string().optional(),
  // --- Extensions to the brief (all optional) ---
  /** Set when the change is scoped to an API version newer than the pinned one: info until you upgrade. */
  appliesToVersion: z.string().optional(),
  /** Other sources that carried the same announcement (dedupe keeps one finding). */
  alsoSeenIn: z.array(z.object({ sourceId: slug, sourceUrl: z.url() })).optional(),
  /** Last run that saw this finding's evidence again. */
  lastSeenAt: isoDate.optional(),
});
export type Finding = z.infer<typeof Finding>;

export const FindingsFile = z.array(Finding);

// ---------------------------------------------------------------------------
// Link check results — /data/links/<slug>.json (extension: feeds the detail page)
// ---------------------------------------------------------------------------

export const LinkCheck = z.object({
  url: z.url(),
  verdict: z.enum(["ok", "moved", "broken", "error"]),
  httpStatus: z.number().int().nullable(),
  finalUrl: z.string().optional(),
  note: z.string().optional(),
});
export type LinkCheck = z.infer<typeof LinkCheck>;

export const LinksFile = z.object({
  integration: slug,
  checkedAt: isoDateTime,
  links: z.array(LinkCheck),
});

// ---------------------------------------------------------------------------
// 5.4 Status — /data/status.json (computed, never hand-edited)
// ---------------------------------------------------------------------------

export const IntegrationStatus = z.object({
  integration: slug,
  status: z.enum(["green", "yellow", "red", "unknown"]),
  reason: z.string(),
  nextDeadline: isoDate.optional(),
  daysToDeadline: z.number().int().optional(),
  openFindings: z.number().int().min(0),
  lastChecked: isoDateTime,
  sourcesOk: z.number().int().min(0),
  sourcesFailed: z.number().int().min(0),
});
export type IntegrationStatus = z.infer<typeof IntegrationStatus>;

export const StatusFile = z.object({
  generatedAt: isoDateTime,
  integrations: z.array(IntegrationStatus),
});

// ---------------------------------------------------------------------------
// 5.5 Run log — /data/runs/<date>.json
// ---------------------------------------------------------------------------

export const RunLog = z.object({
  date: isoDate,
  startedAt: isoDateTime,
  durationMs: z.number().int().min(0),
  integrationsChecked: z.array(slug),
  sources: z.array(
    z.object({
      integration: slug,
      sourceId: slug,
      ok: z.boolean(),
      httpStatus: z.number().int().nullable(),
      error: z.string().optional(),
      newItems: z.number().int().min(0),
      changedBlocks: z.number().int().min(0),
    }),
  ),
  sourcesFetched: z.number().int().min(0),
  sourcesFailed: z.number().int().min(0),
  changedBlocks: z.number().int().min(0),
  findingsCreated: z.number().int().min(0),
  statusCounts: z
    .object({
      green: z.number().int().min(0),
      yellow: z.number().int().min(0),
      red: z.number().int().min(0),
      unknown: z.number().int().min(0),
    })
    .optional(),
});
export type RunLog = z.infer<typeof RunLog>;
