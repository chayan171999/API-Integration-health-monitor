/** Diff, dedupe, link verdicts, robots.txt, block extraction. No network. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Finding, IntegrationManifest, Snapshot } from "../lib/schema.ts";
import type { CollectResult } from "../monitor/collect.ts";
import { excerptOverlap, mergeFindings } from "../monitor/dedupe.ts";
import { diffSnapshot } from "../monitor/diff.ts";
import { extractBlocks } from "../monitor/extract.ts";
import { judgeRedirect } from "../monitor/links.ts";
import { parseRobots } from "../monitor/robots.ts";

const TODAY = "2026-11-05";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "aaaaaaaaaaaaaaaa",
    integration: "slack",
    sourceId: "slack-changelog",
    sourceUrl: "https://docs.slack.dev/changelog/x",
    detectedAt: "2026-11-01",
    category: "endpoint_deprecated",
    severity: "yellow",
    affects: ["chat.postMessage"],
    matchedTerms: [],
    excerpt: "chat.postMessage is deprecated and will be retired soon for all apps on the platform",
    summary: "s",
    suggestedAction: "a",
    confidence: "medium",
    classifiedBy: "rules",
    status: "open",
    ...over,
  };
}

describe("dedupe", () => {
  it("same id again: refreshes evidence, keeps detectedAt and human decisions", () => {
    const existing = [finding({ status: "dismissed", dismissReason: "we migrated" })];
    const r = mergeFindings(existing, [finding({ detectedAt: TODAY, effectiveDate: "2027-01-01", lastSeenAt: TODAY })]);
    assert.equal(r.created.length, 0);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0]!.status, "dismissed");
    assert.equal(r.findings[0]!.dismissReason, "we migrated");
    assert.equal(r.findings[0]!.detectedAt, "2026-11-01");
    assert.equal(r.findings[0]!.effectiveDate, "2027-01-01");
  });

  it("same announcement on a second source: one finding, alsoSeenIn records the other", () => {
    const r = mergeFindings([finding()], [finding({ id: "bbbbbbbbbbbbbbbb", sourceId: "slack-changelog-page", sourceUrl: "https://docs.slack.dev/changelog/#x" })]);
    assert.equal(r.findings.length, 1);
    assert.deepEqual(r.findings[0]!.alsoSeenIn, [{ sourceId: "slack-changelog-page", sourceUrl: "https://docs.slack.dev/changelog/#x" }]);
  });

  it("irrelevant (info) duplicates across sources merge by quoted text", () => {
    const a = finding({ affects: [], excerpt: "The Assistant messaging experience (assistant_view) will be deprecated in February 2027." });
    const b = finding({ id: "bbbbbbbbbbbbbbbb", sourceId: "slack-changelog-page", affects: [], excerpt: "…experience (assistant_view) will be deprecated in February 2027. The assistant-related methods…" });
    assert.ok(excerptOverlap(a.excerpt, b.excerpt) >= 0.6);
    assert.equal(mergeFindings([a], [b]).findings.length, 1);
  });

  it("different announcements stay separate", () => {
    const r = mergeFindings([finding()], [finding({ id: "cccccccccccccccc", sourceId: "slack-changelog-page", affects: ["users:read"], excerpt: "users:read scope now requires review by the platform team before install" })]);
    assert.equal(r.findings.length, 2);
    assert.equal(r.created.length, 1);
  });

  it("incidents close automatically when the status page says resolved", () => {
    const open = finding({ category: "provider_incident", affects: ["API"] });
    const r = mergeFindings([open], [{ ...open, status: "resolved" }]);
    assert.equal(r.findings[0]!.status, "resolved");
  });

  it("a finding first seen already resolved is not recorded", () => {
    const r = mergeFindings([], [finding({ category: "provider_incident", status: "resolved" })]);
    assert.equal(r.findings.length, 0);
  });

  it("changelog findings never auto-close: only humans resolve them", () => {
    const r = mergeFindings([finding()], [finding({ status: "resolved" })]);
    assert.equal(r.findings[0]!.status, "open");
  });
});

describe("diff", () => {
  const manifest: IntegrationManifest = {
    slug: "slack",
    name: "Slack",
    provider: "Slack",
    authMethod: "oauth2",
    uses: { endpoints: [], scopes: [], webhooksOrEvents: [] },
    sources: [{ id: "page", type: "changelog_page", url: "https://example.com/changelog" }],
    docLinks: [],
  };
  const source = manifest.sources[0]!;
  const html = (extra = "") =>
    `<main><h2 id="a">Thing deprecated</h2><p>November 2, 2026</p><p>Old paragraph.</p>${extra}<h2>Other</h2><ul><li><p>Item one</p><ul><li>sub</li></ul></li><li>Item two</li></ul></main>`;

  function result(body: string, previous?: Snapshot): CollectResult {
    const blocks = extractBlocks(body);
    return {
      previous,
      liveItems: [],
      liveBlocks: blocks,
      snapshot: {
        integration: "slack",
        sourceId: "page",
        url: source.url,
        sourceType: source.type,
        format: "page",
        lastAttemptAt: `${TODAY}T00:00:00Z`,
        fetchedAt: `${TODAY}T00:00:00Z`,
        httpStatus: 200,
        ok: true,
        consecutiveFailures: 0,
        items: [],
        blocks: blocks.map(({ entries, ...b }) => ({ ...b, entryHashes: entries.map((e) => e.hash) })),
      },
    };
  }

  it("unchanged page -> no candidates", () => {
    const first = result(html());
    const second = result(html(), first.snapshot);
    assert.equal(diffSnapshot(manifest, source, second, { all: false }).candidates.length, 0);
  });

  it("one new paragraph -> exactly that entry, with heading context, anchor and page date", () => {
    const first = result(html());
    const second = result(html("<p>New: it will be retired on Dec 1, 2026.</p>"), first.snapshot);
    const d = diffSnapshot(manifest, source, second, { all: false });
    assert.equal(d.changedBlocks, 1);
    assert.equal(d.candidates.length, 1);
    assert.equal(d.candidates[0]!.text, "New: it will be retired on Dec 1, 2026.");
    assert.equal(d.candidates[0]!.context, "Thing deprecated");
    assert.equal(d.candidates[0]!.evidenceUrl, "https://example.com/changelog#a");
    assert.equal(d.candidates[0]!.pageDate, "2026-11-02");
  });

  it("a top-level list item and its nested list stay one entry", () => {
    const blocks = extractBlocks(html());
    const other = blocks.find((b) => b.heading === "Other")!;
    assert.deepEqual(other.entries.map((e) => e.text), ["Item one\nsub", "Item two"]);
  });

  it("--reclassify (all) returns every entry", () => {
    const first = result(html());
    assert.equal(diffSnapshot(manifest, source, result(html(), first.snapshot), { all: true }).candidates.length, 4); // date line, old paragraph, item one (+sub), item two
  });
});

describe("link verdicts", () => {
  it("trailing slash / locale redirects are fine", () => {
    assert.equal(judgeRedirect("https://docs.slack.dev/reference/methods/chat.postMessage", "https://docs.slack.dev/reference/methods/chat.postMessage/"), "ok");
    assert.equal(judgeRedirect("https://docs.github.com/rest/issues", "https://docs.github.com/en/rest/issues"), "ok");
  });
  it("redirect to a generic page or a top-level section is broken", () => {
    assert.equal(judgeRedirect("https://docs.stripe.com/api/charges/old", "https://docs.stripe.com/"), "broken");
    assert.equal(judgeRedirect("https://docs.example.com/rest/issues/issues", "https://docs.example.com/rest"), "broken");
    assert.equal(judgeRedirect("https://docs.example.com/a/b", "https://docs.example.com/404"), "broken");
  });
  it("redirect to another specific page is 'moved'", () => {
    assert.equal(judgeRedirect("https://api.slack.com/methods/chat.postMessage", "https://docs.slack.dev/reference/methods/chat.postMessage/"), "moved");
  });
});

describe("robots.txt", () => {
  const robots = parseRobots(
    "User-agent: ia_archiver\nDisallow: /docs\n\nUser-agent: *\nDisallow: /private\nAllow: /private/ok$\nDisallow: /*.pdf$",
    "api-health-monitor",
  );
  it("applies the * group, longest match, $ anchors", () => {
    assert.equal(robots.isAllowed("/docs"), true);
    assert.equal(robots.isAllowed("/private/x"), false);
    assert.equal(robots.isAllowed("/private/ok"), true);
    assert.equal(robots.isAllowed("/a/b.pdf"), false);
    assert.equal(robots.isAllowed("/a/b.pdf?x"), true);
  });
  it("a group naming our product token wins over *", () => {
    const r = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: api-health-monitor\nAllow: /", "api-health-monitor");
    assert.equal(r.isAllowed("/changelog"), true);
  });
});
