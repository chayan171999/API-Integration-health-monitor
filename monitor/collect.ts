/**
 * Pipeline step 1 (Collect): fetch one source and build its new snapshot.
 *
 * On failure the previous snapshot's content is kept and only the fetch-health
 * fields change, so a temporary outage never makes every block look "new" on the
 * next successful run.
 */
import path from "node:path";
import { Snapshot, type IntegrationManifest, type Source } from "../lib/schema.ts";
import { SNAPSHOTS_DIR } from "./config.ts";
import { extractBlocks, looksLikeFeed, parseFeed, type FeedItem, type PageBlock } from "./extract.ts";
import { FetchError, politeGet } from "./http.ts";
import { errorMessage, readJsonIfExists, shortHash, writeJson } from "./util.ts";

export interface CollectResult {
  snapshot: Snapshot;
  previous?: Snapshot;
  /** Live feed items with full text (feeds only, success only). Used by the classifier in step 2. */
  liveItems: FeedItem[];
  liveBlocks: PageBlock[];
}

export function snapshotPath(integration: string, sourceId: string): string {
  return path.join(SNAPSHOTS_DIR, integration, `${sourceId}.json`);
}

export async function readSnapshot(integration: string, sourceId: string): Promise<Snapshot | undefined> {
  return readJsonIfExists(snapshotPath(integration, sourceId), Snapshot);
}

export async function writeSnapshot(snapshot: Snapshot): Promise<void> {
  await writeJson(snapshotPath(snapshot.integration, snapshot.sourceId), Snapshot, snapshot);
}

export async function collectSource(manifest: IntegrationManifest, source: Source): Promise<CollectResult> {
  const previous = await readSnapshot(manifest.slug, source.id);
  const attemptAt = new Date().toISOString();
  const base = {
    integration: manifest.slug,
    sourceId: source.id,
    url: source.url,
    sourceType: source.type,
  };

  let httpStatus: number | null = null;
  try {
    const res = await politeGet(source.url);
    httpStatus = res.status;
    if (res.status < 200 || res.status >= 300) throw new FetchError(`HTTP ${res.status}`, res.status);

    const isFeed = source.type === "rss" || looksLikeFeed(res.contentType, res.body);
    if (source.type === "rss" && !looksLikeFeed(res.contentType, res.body)) {
      throw new Error(`expected a feed but got ${res.contentType || "unknown content type"}`);
    }

    let liveItems: FeedItem[] = [];
    let liveBlocks: PageBlock[] = [];
    if (isFeed) {
      liveItems = await parseFeed(res.body);
      if (liveItems.length === 0) throw new Error("feed parsed but contained no items");
    } else {
      liveBlocks = extractBlocks(res.body, source.selector);
      if (liveBlocks.length === 0) throw new Error("page parsed but produced no text blocks");
    }

    const hashes = isFeed ? liveItems.map((i) => i.hash) : liveBlocks.map((b) => b.hash);
    const snapshot: Snapshot = {
      ...base,
      format: isFeed ? "feed" : "page",
      lastAttemptAt: attemptAt,
      fetchedAt: attemptAt,
      httpStatus,
      ok: true,
      finalUrl: res.finalUrl !== source.url ? res.finalUrl : undefined,
      consecutiveFailures: 0,
      contentHash: shortHash(hashes.join(",")),
      items: liveItems.map(({ id, title, link, publishedAt, hash }) => ({ id, title, link, publishedAt, hash })),
      blocks: liveBlocks.map(({ id, heading, anchor, text, hash, entries }) => ({
        id,
        heading,
        anchor,
        text,
        hash,
        entryHashes: entries.map((e) => e.hash),
      })),
    };
    return { snapshot, previous, liveItems, liveBlocks };
  } catch (err) {
    if (err instanceof FetchError && err.status !== null) httpStatus = err.status;
    const snapshot: Snapshot = {
      ...base,
      format: previous?.format,
      lastAttemptAt: attemptAt,
      fetchedAt: previous?.fetchedAt,
      httpStatus,
      ok: false,
      error: errorMessage(err),
      finalUrl: previous?.finalUrl,
      consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
      contentHash: previous?.contentHash,
      items: previous?.items ?? [],
      blocks: previous?.blocks ?? [],
    };
    return { snapshot, previous, liveItems: [], liveBlocks: [] };
  }
}
