/** Status rules (BRIEF section 7). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Finding, IntegrationManifest } from "../lib/schema.ts";
import { commitSubject, computeStatus, severityOf } from "../monitor/score.ts";

const TODAY = "2026-11-05";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "0000000000000001",
    integration: "slack",
    sourceId: "slack-changelog",
    sourceUrl: "https://docs.slack.dev/changelog/",
    detectedAt: TODAY,
    category: "endpoint_deprecated",
    severity: "yellow",
    affects: ["chat.postMessage"],
    matchedTerms: [],
    excerpt: "chat.postMessage is deprecated",
    summary: "",
    suggestedAction: "",
    confidence: "high",
    classifiedBy: "rules",
    status: "open",
    ...over,
  };
}

const manifest: IntegrationManifest = {
  slug: "slack",
  name: "Slack",
  provider: "Slack",
  authMethod: "oauth2",
  uses: { endpoints: ["chat.postMessage"], scopes: [], webhooksOrEvents: [] },
  sources: [
    { id: "a", type: "rss", url: "https://example.com/a" },
    { id: "b", type: "rss", url: "https://example.com/b" },
    { id: "c", type: "rss", url: "https://example.com/c" },
  ],
  docLinks: [],
};
const healthy = { ok: 3, failed: 0 };
const status = (fs: Finding[], health = healthy) => computeStatus(manifest, fs, health, TODAY, `${TODAY}T06:00:00Z`);

describe("severityOf", () => {
  it("endpoint_removed touching a used item is red, with or without a date", () => {
    assert.equal(severityOf(finding({ category: "endpoint_removed" }), TODAY), "red");
    assert.equal(severityOf(finding({ category: "endpoint_removed", effectiveDate: "2027-06-01" }), TODAY), "red");
  });

  for (const category of ["version_sunset", "endpoint_deprecated", "scope_changed", "auth_change"] as const) {
    it(`${category}: red within 30 days, yellow beyond, yellow without a date`, () => {
      assert.equal(severityOf(finding({ category, effectiveDate: "2026-12-05" }), TODAY), "red"); // 30 days
      assert.equal(severityOf(finding({ category, effectiveDate: "2026-12-06" }), TODAY), "yellow"); // 31 days
      assert.equal(severityOf(finding({ category }), TODAY), "yellow");
    });
  }

  it("a deadline already past is red", () => {
    assert.equal(severityOf(finding({ effectiveDate: "2026-10-01" }), TODAY), "red");
  });

  it("rate-limit and webhook changes on a used item are yellow even when imminent", () => {
    assert.equal(severityOf(finding({ category: "rate_limit_change", effectiveDate: "2026-11-10" }), TODAY), "yellow");
    assert.equal(severityOf(finding({ category: "webhook_change", effectiveDate: "2026-11-10" }), TODAY), "yellow");
  });

  it("low confidence on something that would otherwise be red is yellow", () => {
    assert.equal(severityOf(finding({ category: "endpoint_removed", confidence: "low" }), TODAY), "yellow");
    assert.equal(severityOf(finding({ effectiveDate: "2026-11-20", confidence: "low" }), TODAY), "yellow");
  });

  it("empty affects is info, whatever the category or date", () => {
    assert.equal(severityOf(finding({ affects: [], category: "endpoint_removed" }), TODAY), "info");
    assert.equal(severityOf(finding({ affects: [], effectiveDate: "2026-11-06" }), TODAY), "info");
  });

  it("a change scoped to a newer API version than the pinned one is info", () => {
    assert.equal(severityOf(finding({ category: "endpoint_removed", appliesToVersion: "2026-03-10" }), TODAY), "info");
  });

  it("broken doc links and incidents on used components are yellow", () => {
    assert.equal(severityOf(finding({ category: "broken_doc_link", affects: ["https://x"] }), TODAY), "yellow");
    assert.equal(severityOf(finding({ category: "provider_incident", affects: ["API"] }), TODAY), "yellow");
    assert.equal(severityOf(finding({ category: "provider_incident", affects: [] }), TODAY), "info");
  });
});

describe("commitSubject", () => {
  const of = (...s: ("red" | "yellow" | "green" | "unknown")[]) => s.map((status) => ({ status }));
  it("matches the brief's format", () => {
    assert.equal(commitSubject(TODAY, of("red", "yellow", "yellow", "green")), "monitor: 2026-11-05: 1 red, 2 yellow, 1 green");
  });
  it("mentions unknown only when there is one", () => {
    assert.equal(commitSubject(TODAY, of("green", "unknown")), "monitor: 2026-11-05: 0 red, 0 yellow, 1 green, 1 unknown");
  });
});

describe("computeStatus", () => {
  it("green with no findings", () => {
    const s = status([]);
    assert.equal(s.status, "green");
    assert.equal(s.openFindings, 0);
    assert.equal(s.nextDeadline, undefined);
  });

  it("info findings never change status", () => {
    assert.equal(status([finding({ affects: [] }), finding({ id: "0000000000000002", affects: [], category: "endpoint_removed" })]).status, "green");
  });

  it("red beats yellow; reason names the most urgent finding", () => {
    const s = status([
      finding({ id: "0000000000000002", effectiveDate: "2027-03-01" }),
      finding({ id: "0000000000000003", effectiveDate: "2026-11-20", affects: ["chat.postMessage"] }),
    ]);
    assert.equal(s.status, "red");
    assert.match(s.reason, /chat\.postMessage, effective 2026-11-20 \(in 15 days\)/);
    assert.equal(s.nextDeadline, "2026-11-20");
    assert.equal(s.daysToDeadline, 15);
    assert.equal(s.openFindings, 2);
  });

  it("yellow when the only deadline is more than 30 days away", () => {
    const s = status([finding({ effectiveDate: "2027-03-01" })]);
    assert.equal(s.status, "yellow");
    assert.equal(s.daysToDeadline, 116);
  });

  it("dismissed and resolved findings are ignored", () => {
    assert.equal(status([finding({ category: "endpoint_removed", status: "dismissed", dismissReason: "not used" })]).status, "green");
    assert.equal(status([finding({ category: "endpoint_removed", status: "resolved" })]).status, "green");
  });

  it("acknowledged findings don't drive status but still count toward the next deadline", () => {
    const s = status([finding({ effectiveDate: "2026-11-20", status: "acknowledged" })]);
    assert.equal(s.status, "green");
    assert.equal(s.nextDeadline, "2026-11-20");
  });

  it("unknown when more than half the sources failed and nothing is flagged", () => {
    const s = status([], { ok: 1, failed: 2 });
    assert.equal(s.status, "unknown");
    assert.equal(s.sourcesFailed, 2);
  });

  it("exactly half failing is not unknown", () => {
    assert.equal(computeStatus({ ...manifest, sources: manifest.sources.slice(0, 2) }, [], { ok: 1, failed: 1 }, TODAY, TODAY + "T00:00:00Z").status, "green");
  });

  it("a known red stays red when sources are failing, and says so", () => {
    const s = status([finding({ category: "endpoint_removed" })], { ok: 1, failed: 2 });
    assert.equal(s.status, "red");
    assert.match(s.reason, /2 of 3 sources failing/);
  });
});
