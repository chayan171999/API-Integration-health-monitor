/**
 * Dedupe (BRIEF 6.6): the same announcement seen again, or on a second source,
 * updates the existing finding instead of creating a new one.
 *
 *   same id                  -> same entry seen again: refresh evidence, keep human decisions
 *   same announcement        -> another source carries it: record it in alsoSeenIn
 *   otherwise                -> new finding (unless it arrives already resolved)
 */
import type { Finding } from "../lib/schema.ts";
import { normalizeText } from "./util.ts";

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}

function wordTrigrams(s: string): Set<string> {
  const words = normalizeText(s.toLowerCase().replace(/[^a-z0-9_./:-]+/g, " ")).split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) out.add(words.slice(i, i + 3).join(" "));
  return out;
}

/** Overlap coefficient of word trigrams: high when one excerpt quotes the other. */
export function excerptOverlap(a: string, b: string): number {
  const ta = wordTrigrams(a);
  const tb = wordTrigrams(b);
  if (ta.size < 3 || tb.size < 3) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

export function isSameAnnouncement(a: Finding, b: Finding): boolean {
  if (a.integration !== b.integration || a.category !== b.category) return false;
  if (a.sourceId === b.sourceId) return false; // same source: ids already distinguish entries
  if (a.category === "broken_doc_link" || a.category === "provider_incident") return false;
  if (a.affects.length > 0 && sameSet(a.affects, b.affects) && a.effectiveDate === b.effectiveDate) return true;
  return excerptOverlap(a.excerpt, b.excerpt) >= 0.6;
}

export interface MergeResult {
  findings: Finding[];
  created: Finding[];
  updated: number;
}

export function mergeFindings(existing: Finding[], incoming: Finding[]): MergeResult {
  const findings = existing.map((f) => ({ ...f }));
  const byId = new Map(findings.map((f) => [f.id, f]));
  const created: Finding[] = [];
  let updated = 0;

  for (const f of incoming) {
    const same = byId.get(f.id);
    if (same) {
      updated++;
      same.lastSeenAt = f.lastSeenAt;
      // Rule output is refreshed; human decisions (status, dismissReason) and detectedAt are kept.
      if (same.classifiedBy === "rules") {
        Object.assign(same, {
          sourceUrl: f.sourceUrl,
          publishedAt: f.publishedAt ?? same.publishedAt,
          effectiveDate: f.effectiveDate,
          category: f.category,
          severity: f.severity,
          affects: f.affects,
          matchedTerms: f.matchedTerms,
          excerpt: f.excerpt,
          summary: f.summary,
          suggestedAction: f.suggestedAction,
          confidence: f.confidence,
          appliesToVersion: f.appliesToVersion,
        });
      }
      // Automatic lifecycle only for machine-observable things (incidents, links), and only open <-> resolved.
      if ((f.category === "provider_incident" || f.category === "broken_doc_link") && f.status !== same.status) {
        if (same.status === "open" && f.status === "resolved") same.status = "resolved";
        else if (same.status === "resolved" && f.status === "open") same.status = "open";
      }
      continue;
    }

    if (f.status === "resolved") continue; // never seen while it mattered: nothing to record

    const twin = findings.find((e) => isSameAnnouncement(e, f));
    if (twin) {
      updated++;
      twin.lastSeenAt = f.lastSeenAt;
      const seen = twin.alsoSeenIn ?? [];
      if (!seen.some((s) => s.sourceId === f.sourceId)) twin.alsoSeenIn = [...seen, { sourceId: f.sourceId, sourceUrl: f.sourceUrl }];
      if (!twin.effectiveDate && f.effectiveDate) twin.effectiveDate = f.effectiveDate;
      continue;
    }

    findings.push(f);
    byId.set(f.id, f);
    created.push(f);
  }

  findings.sort((a, b) => a.detectedAt.localeCompare(b.detectedAt) || a.id.localeCompare(b.id));
  return { findings, created, updated };
}
