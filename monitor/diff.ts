/**
 * Pipeline step 2 (Diff): compare a fresh fetch with the previous snapshot and
 * return only new or changed units as classification candidates.
 *
 *   feeds -> items whose ID is new, or whose content hash changed
 *   pages -> entries whose hash appears nowhere in the previous snapshot
 */
import type { IntegrationManifest, Snapshot, Source } from "../lib/schema.ts";
import { sourceLabel, type Candidate } from "./classify.ts";
import type { CollectResult } from "./collect.ts";
import { headingYear, leadingDate } from "./dates.ts";
import { extractBlocks, type FeedItem } from "./extract.ts";
import { politeGet } from "./http.ts";
import { errorMessage } from "./util.ts";

/** Teaser feeds (e.g. GitHub's changelog) hold one sentence; the details are on the linked post. */
export const MAX_ENRICH_PER_SOURCE = 15;
const ENRICHED_TEXT_MAX = 8_000;
const TEASER = /(?:…|\[…\]|\[\.\.\.\]|&#8230;|\.\.\.)\s*$/;

export interface DiffResult {
  candidates: Candidate[];
  newItems: number;
  changedBlocks: number;
  enrichFailures: string[];
}

function itemCandidate(manifest: IntegrationManifest, source: Source, item: FeedItem): Candidate {
  return {
    integration: manifest.slug,
    sourceId: source.id,
    sourceType: source.type,
    sourceLabel: sourceLabel(manifest, source.type),
    sourceUrl: source.url,
    evidenceUrl: item.link && /^https?:\/\//.test(item.link) ? item.link : source.url,
    key: item.id,
    title: item.title,
    categories: item.categories,
    text: item.text,
    publishedAt: item.publishedAt,
  };
}

export function diffSnapshot(
  manifest: IntegrationManifest,
  source: Source,
  result: CollectResult,
  opts: { all: boolean },
): DiffResult {
  const prev: Snapshot | undefined = opts.all ? undefined : result.previous;
  const candidates: Candidate[] = [];
  let newItems = 0;
  let changedBlocks = 0;

  if (result.liveItems.length) {
    const prevHash = new Map((prev?.items ?? []).map((i) => [i.id, i.hash]));
    for (const item of result.liveItems) {
      if (prevHash.get(item.id) === item.hash) continue;
      newItems++;
      candidates.push(itemCandidate(manifest, source, item));
    }
  }

  if (result.liveBlocks.length) {
    const prevBlocks = new Set((prev?.blocks ?? []).map((b) => b.hash));
    const prevEntries = new Set((prev?.blocks ?? []).flatMap((b) => b.entryHashes ?? []));
    const reference = new Date();
    let pageDate: string | undefined;
    for (const block of result.liveBlocks) {
      // Walk every block (changed or not) so undated sections inherit the date above them.
      pageDate = leadingDate(block.text, reference) ?? headingYear(block.heading) ?? pageDate;
      if (prevBlocks.has(block.hash)) continue;
      changedBlocks++;
      for (const entry of block.entries) {
        if (prevEntries.has(entry.hash)) continue; // moved, not changed
        candidates.push({
          integration: manifest.slug,
          sourceId: source.id,
          sourceType: source.type,
          sourceLabel: sourceLabel(manifest, source.type),
          sourceUrl: source.url,
          evidenceUrl: block.anchor ? `${source.url}#${encodeURIComponent(block.anchor)}` : source.url,
          key: `${block.heading ?? ""}\n${entry.text.split("\n", 1)[0]}`,
          context: block.heading,
          text: entry.text,
          blockText: block.text,
          pageDate,
        });
      }
    }
  }

  return { candidates, newItems, changedBlocks, enrichFailures: [] };
}

/**
 * Replace teaser text with the linked post's text, for changelog feeds only (not
 * status feeds), capped per run. Failures keep the teaser and are reported.
 */
export async function enrichTeasers(diff: DiffResult, source: Source): Promise<void> {
  if (source.type !== "rss") return;
  let fetched = 0;
  for (const c of diff.candidates) {
    if (fetched >= MAX_ENRICH_PER_SOURCE) break;
    if (!TEASER.test(c.text) || c.evidenceUrl === source.url) continue;
    fetched++;
    try {
      const res = await politeGet(c.evidenceUrl);
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      const blocks = extractBlocks(res.body);
      const text = blocks
        .map((b) => b.text)
        .filter(Boolean)
        .join("\n")
        .slice(0, ENRICHED_TEXT_MAX);
      if (text.length > c.text.length) c.text = text;
    } catch (err) {
      diff.enrichFailures.push(`${c.evidenceUrl}: ${errorMessage(err)}`);
    }
  }
}
