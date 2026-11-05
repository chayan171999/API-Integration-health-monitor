/** Rule-based classifier (BRIEF section 6): categories, relevance, dates, confidence, templates. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IntegrationManifest } from "../lib/schema.ts";
import { classifyEntry, classifyIncident, makeExcerpt, type Candidate } from "../monitor/classify.ts";
import { findDates, pickEffectiveDate } from "../monitor/dates.ts";
import { findMatches, termsFor } from "../monitor/match.ts";

const TODAY = "2026-11-05";

const slack: IntegrationManifest = {
  slug: "slack",
  name: "Slack",
  provider: "Slack",
  authMethod: "oauth2",
  uses: {
    endpoints: ["chat.postMessage", "files.getUploadURLExternal"],
    scopes: ["chat:write", "users:read"],
    webhooksOrEvents: ["message.channels"],
    keywords: ["bot token"],
    statusComponents: ["API", "file uploads"],
  },
  sources: [{ id: "slack-changelog", type: "rss", url: "https://docs.slack.dev/changelog/rss.xml" }],
  docLinks: [],
};

const github: IntegrationManifest = {
  slug: "github",
  name: "GitHub",
  provider: "GitHub",
  authMethod: "oauth2",
  apiVersion: "2022-11-28",
  uses: {
    endpoints: ["GET /repos/{owner}/{repo}/issues", "PATCH /repos/{owner}/{repo}/issues/{issue_number}", "GET /user"],
    scopes: ["repo"],
    webhooksOrEvents: ["issues", "pull_request"],
  },
  sources: [{ id: "github-rest-breaking-changes", type: "deprecations_page", url: "https://docs.github.com/en/rest/about-the-rest-api/breaking-changes" }],
  docLinks: [],
};

function entry(text: string, over: Partial<Candidate> = {}): Candidate {
  return {
    integration: "slack",
    sourceId: "slack-changelog",
    sourceType: "rss",
    sourceLabel: "Slack changelog feed",
    sourceUrl: "https://docs.slack.dev/changelog/rss.xml",
    evidenceUrl: "https://docs.slack.dev/changelog/2026-10-01-thing",
    key: "item-1",
    text,
    publishedAt: "2026-10-01T00:00:00Z",
    ...over,
  };
}

const classify = (c: Candidate, m = slack, baseline = false) => classifyEntry(c, m, { today: TODAY, baseline });

describe("category detection", () => {
  const cases: [string, string][] = [
    ["chat.postMessage is deprecated and will stop working on March 1, 2027.", "endpoint_deprecated"],
    ["chat.postMessage will be retired on December 1, 2026.", "endpoint_deprecated"],
    ["chat.postMessage has been removed. Calls now fail.", "endpoint_removed"],
    ["Removes the legacy field from chat.postMessage responses.", "endpoint_removed"],
    ["Calls to chat.postMessage now returns 410 Gone.", "endpoint_removed"],
    ["Apps must request the new chat:write scope; the scope has been renamed.", "scope_changed"],
    ["Bot token rotation is now required for all apps.", "auth_change"],
    ["We are reducing the rate limit for chat.postMessage to 1 request per second.", "rate_limit_change"],
    ["The message.channels event payload format is changing.", "webhook_change"],
  ];
  for (const [text, category] of cases) {
    it(`${category}: "${text.slice(0, 50)}…"`, () => {
      assert.equal(classify(entry(text))?.category, category);
    });
  }

  it("feature announcements with no category language produce no finding", () => {
    assert.equal(classify(entry("chat.postMessage now supports rich text blocks. Try it today!")), null);
  });

  it("future 'will be removed' is a deprecation, not a removal", () => {
    assert.equal(classify(entry("chat.postMessage will be removed on January 15, 2027."))?.category, "endpoint_deprecated");
  });

  it("feed labels count as category language (e.g. GitHub's 'Retired' type)", () => {
    const f = classify(entry("Uploading via chat.postMessage attachments is going away.", { categories: ["Retired"] }));
    assert.equal(f?.category, "endpoint_removed");
  });
});

describe("relevance (manifest matching)", () => {
  const terms = termsFor(slack);
  const hit = (text: string) => findMatches(text, terms).map((m) => `${m.term}:${m.exact ? "exact" : "fuzzy"}`);

  it("exact identifier match", () => {
    assert.deepEqual(hit("Use chat.postMessage instead."), ["chat.postMessage:exact"]);
  });
  it("does not match a longer identifier (files.upload vs files.uploadV2 style)", () => {
    assert.deepEqual(hit("chat.postMessageV2 is new"), []);
    assert.deepEqual(hit("see chat.postMessage.extra"), []);
  });
  it("case and dots-vs-slashes are fuzzy", () => {
    assert.deepEqual(hit("CHAT.POSTMESSAGE is deprecated"), ["chat.postMessage:fuzzy"]);
    assert.deepEqual(hit("the chat/postMessage method"), ["chat.postMessage:fuzzy"]);
  });
  it("sentence-ending period is still a match", () => {
    assert.deepEqual(hit("We changed chat.postMessage."), ["chat.postMessage:exact"]);
  });
  it("keywords are case-insensitive and plural-tolerant (prose)", () => {
    assert.deepEqual(hit("Legacy Bot Tokens are going away"), ["bot token:exact"]);
  });
  it("scopes with punctuation match anywhere", () => {
    assert.deepEqual(hit("requires chat:write"), ["chat:write:exact"]);
    assert.deepEqual(hit("requires chat:write.public"), []);
  });

  const gh = termsFor(github);
  const ghHit = (text: string) => findMatches(text, gh).map((m) => `${m.term}:${m.exact ? "exact" : "fuzzy"}`);
  it("HTTP endpoints: same path matches, a different method right before it doesn't", () => {
    assert.deepEqual(ghHit("Affected endpoints\nPATCH /repos/{owner}/{repo}/issues/{issue_number}"), ["PATCH /repos/{owner}/{repo}/issues/{issue_number}:exact"]);
    assert.deepEqual(ghHit("DELETE /repos/{owner}/{repo}/issues/{issue_number}"), []);
  });
  it("HTTP endpoints: a sub-path is a different endpoint", () => {
    assert.deepEqual(ghHit("GET /repos/{owner}/{repo}/issues/events"), []);
    assert.deepEqual(ghHit("GET /user/repository_invitations and GET /users/{username}"), []);
  });
  it("HTTP endpoints: different placeholder names are fuzzy", () => {
    assert.deepEqual(ghHit("GET /repos/{org}/{name}/issues"), ["GET /repos/{owner}/{repo}/issues:fuzzy"]);
  });
  it("bare-word scopes/events need 'scope'/'webhook' nearby", () => {
    assert.deepEqual(ghHit("Open the repo settings and file issues."), []);
    assert.deepEqual(ghHit("The classic repo scope is being split."), ["repo:exact"]);
    assert.deepEqual(ghHit("The issues webhook payload changes."), ["issues:exact"]);
  });
  it("the pinned API version is a manifest item", () => {
    assert.deepEqual(ghHit("Version 2022-11-28 will be sunset"), ["2022-11-28:exact"]);
  });
});

describe("dates", () => {
  const ref = new Date("2026-10-01T12:00:00Z");
  it("only dates after a trigger word become deadlines", () => {
    const ds = findDates("Posted October 1, 2026. The method will be retired on December 1, 2026.", ref);
    assert.equal(ds.length, 2);
    assert.deepEqual(ds.map((d) => d.triggered), [false, true]);
    assert.equal(pickEffectiveDate(ds, TODAY, false)?.date, "2026-12-01");
  });
  it("relative words like 'today' are never dates", () => {
    assert.deepEqual(findDates("Starting today, all apps must migrate.", ref), []);
  });
  it("nearest future triggered date wins", () => {
    const ds = findDates("Warnings start on December 1, 2026 and calls fail after March 1, 2027.", ref);
    assert.equal(pickEffectiveDate(ds, TODAY, false)?.date, "2026-12-01");
  });
  it("month-only dates are kept but marked approximate", () => {
    const [d] = findDates("assistant_view will be deprecated in February 2027.", ref);
    assert.equal(d?.date, "2027-02-01");
    assert.equal(d?.approximate, true);
  });
  it("past dates are a deadline only for removal/sunset wording", () => {
    const ds = findDates("It was retired on September 1, 2026.", ref);
    assert.equal(pickEffectiveDate(ds, TODAY, false), undefined);
    assert.equal(pickEffectiveDate(ds, TODAY, true)?.date, "2026-09-01");
  });
});

describe("confidence + severity", () => {
  it("high: pattern + exact match + stated date", () => {
    const f = classify(entry("chat.postMessage will be retired on December 1, 2026."))!;
    assert.equal(f.confidence, "high");
    assert.equal(f.effectiveDate, "2026-12-01");
    assert.equal(f.severity, "red"); // 26 days away
    assert.deepEqual(f.affects, ["chat.postMessage"]);
    assert.match(f.summary, /`chat\.postMessage` alongside deprecation language, effective 2026-12-01/);
    assert.equal(f.suggestedAction, "Review use of `chat.postMessage` before 2026-12-01.");
  });
  it("medium: pattern + exact match, no date -> yellow", () => {
    const f = classify(entry("chat.postMessage is deprecated."))!;
    assert.equal(f.confidence, "medium");
    assert.equal(f.effectiveDate, undefined);
    assert.equal(f.severity, "yellow");
    assert.match(f.summary, /with no date stated/);
  });
  it("low: fuzzy match only -> never red", () => {
    const f = classify(entry("Chat.PostMessage has been removed."))!;
    assert.equal(f.confidence, "low");
    assert.equal(f.severity, "yellow");
  });
  it("low: conflicting language (postponed)", () => {
    const f = classify(entry("The chat.postMessage deprecation has been postponed until further notice."))!;
    assert.equal(f.confidence, "low");
    assert.ok(f.matchedTerms.some((t) => t.startsWith("conflict:")));
  });
  it("irrelevant change -> info with empty affects (never changes status)", () => {
    const f = classify(entry("The reminders.add method is deprecated and will be retired on December 1, 2026."))!;
    assert.deepEqual(f.affects, []);
    assert.equal(f.severity, "info");
    assert.match(f.summary, /Informational only/);
  });
  it("every decision is explained in matchedTerms", () => {
    const f = classify(entry("chat.postMessage will be retired on December 1, 2026."))!;
    assert.ok(f.matchedTerms.some((t) => t.startsWith("pattern:")));
    assert.ok(f.matchedTerms.some((t) => t.startsWith("uses:chat.postMessage")));
    assert.ok(f.matchedTerms.some((t) => t.startsWith("date:2026-12-01")));
  });
  it("finding id is stable for the same source + entry", () => {
    const a = classify(entry("chat.postMessage is deprecated."))!;
    const b = classify(entry("chat.postMessage is deprecated. (Edited for clarity.)"))!;
    assert.equal(a.id, b.id);
  });
});

describe("version scoping", () => {
  const ghEntry = (context: string, text: string) =>
    entry(text, { integration: "github", sourceId: "github-rest-breaking-changes", sourceType: "deprecations_page", context, publishedAt: undefined });

  it("a change under a newer API version than the pinned one is info (upgrade note)", () => {
    const f = classifyEntry(
      ghEntry("Breaking changes › Version 2026-03-10", "Remove the state_reason param\nAffected endpoints\nPATCH /repos/{owner}/{repo}/issues/{issue_number}"),
      github,
      { today: TODAY, baseline: true },
    )!;
    assert.equal(f.category, "endpoint_removed");
    assert.equal(f.appliesToVersion, "2026-03-10");
    assert.equal(f.severity, "info");
    assert.match(f.suggestedAction, /No action while pinned to 2022-11-28/);
  });
  it("a change under an older version than the pinned one is ignored", () => {
    assert.equal(classifyEntry(ghEntry("Version 2021-01-01", "Removes GET /user field"), github, { today: TODAY, baseline: false }), null);
  });
});

describe("baseline (first run)", () => {
  it("skips old history", () => {
    assert.equal(classify(entry("chat.postMessage is deprecated.", { publishedAt: "2019-03-01T00:00:00Z" }), slack, true), null);
    assert.equal(classify(entry("chat.postMessage is deprecated.", { publishedAt: undefined, context: "Changelog › 2020" }), slack, true), null);
    assert.equal(classify(entry("chat.postMessage is deprecated.", { publishedAt: undefined, pageDate: "2017-12-31" }), slack, true), null);
  });
  it("keeps old announcements whose deadline is still ahead", () => {
    const f = classify(entry("chat.postMessage will be retired on March 1, 2027.", { publishedAt: "2025-01-01T00:00:00Z" }), slack, true);
    assert.equal(f?.effectiveDate, "2027-03-01");
  });
  it("after the baseline, an old date doesn't hide a newly appearing entry", () => {
    assert.ok(classify(entry("chat.postMessage is deprecated.", { publishedAt: "2019-03-01T00:00:00Z" }), slack, false));
  });
});

describe("status-page incidents", () => {
  const incident = (title: string, text: string, publishedAt = "2026-11-05T08:00:00Z") =>
    entry(text, { sourceId: "slack-status", sourceType: "status_page", title, publishedAt });

  it("ongoing incident on a used component is open + yellow", () => {
    const f = classifyIncident(incident("Elevated errors", "Nov 5, 08:00 UTC\nInvestigating - Some file uploads are failing."), slack, { today: TODAY, baseline: false })!;
    assert.equal(f.status, "open");
    assert.deepEqual(f.affects, ["file uploads"]);
    assert.equal(f.severity, "yellow");
  });
  it("latest update label decides (Statuspage lists newest first)", () => {
    const f = classifyIncident(incident("Elevated errors", "Resolved - All good.\nInvestigating - API errors."), slack, { today: TODAY, baseline: false })!;
    assert.equal(f.status, "resolved");
  });
  it("prose-only feeds: 'has been resolved' means resolved", () => {
    const f = classifyIncident(incident("Issues with file uploads", "The issue has been resolved."), slack, { today: TODAY, baseline: false })!;
    assert.equal(f.status, "resolved");
  });
  it("incident in an unused component is info", () => {
    const f = classifyIncident(incident("Huddles degraded", "Investigating - Huddle summaries are delayed."), slack, { today: TODAY, baseline: false })!;
    assert.deepEqual(f.affects, []);
    assert.equal(f.severity, "info");
  });
  it("scheduled maintenance is not a finding", () => {
    assert.equal(classifyIncident(incident("Maintenance", "Scheduled - Planned work on the API."), slack, { today: TODAY, baseline: false }), null);
  });
  it("an 'ongoing' item older than a few days is treated as stale", () => {
    const f = classifyIncident(incident("API errors", "Investigating - API errors.", "2026-10-20T00:00:00Z"), slack, { today: TODAY, baseline: false })!;
    assert.equal(f.status, "resolved");
  });
});

describe("excerpt", () => {
  it("is at most 300 chars and quotes around the match", () => {
    const long = "Intro. ".repeat(80) + "chat.postMessage is deprecated." + " Outro.".repeat(80);
    const ex = makeExcerpt(long, [long.indexOf("chat.postMessage")]);
    assert.ok(ex.length <= 300, `length ${ex.length}`);
    assert.ok(ex.includes("chat.postMessage is deprecated."));
    assert.ok(ex.startsWith("…") && ex.endsWith("…"));
  });
});
