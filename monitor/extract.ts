/**
 * Turns raw responses into comparable units:
 *   feeds -> items (stable ID + content hash)
 *   pages -> blocks (one heading + the text under it, chunked; hash per block)
 *            -> entries (one changelog entry: a top-level list item or a paragraph)
 */
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import Parser from "rss-parser";
import { MAX_BLOCK_CHARS } from "./config.ts";
import { normalizeText, shortHash, slugify } from "./util.ts";

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

export interface FeedItem {
  id: string;
  title: string;
  link?: string;
  publishedAt?: string;
  /** Feed-provided labels, e.g. GitHub's changelog type ("Retired", "Deprecation"). */
  categories: string[];
  /** Plain text of the entry (title excluded). Kept in memory for classification, not stored. */
  text: string;
  hash: string;
}

export function looksLikeFeed(contentType: string, body: string): boolean {
  if (/(rss|atom)\+xml|\/xml/i.test(contentType)) return true;
  const head = body.trimStart().slice(0, 500);
  return /^<\?xml/i.test(head) || /<(rss|feed|rdf:RDF)[\s>]/i.test(head);
}

const parser = new Parser();

/** WordPress-style feed footer ("The post X appeared first on Y.") adds nothing. */
const FEED_BOILERPLATE = /^The post .{1,300} appeared first on .{1,100}\.?$/;

export function htmlFragmentToText(fragment: string): string {
  if (!/[<&]/.test(fragment)) return normalizeText(fragment);
  const $ = cheerio.load(`<div id="__root">${fragment}</div>`);
  const root = $("#__root").get(0);
  if (!root) return normalizeText(fragment);
  return toLines($, root)
    .map((l) => l.text)
    .filter((t) => !FEED_BOILERPLATE.test(t))
    .join("\n");
}

function categoryNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => (typeof c === "string" ? c : typeof c === "object" && c && "_" in c ? String(c._) : ""))
    .map((c) => normalizeText(c))
    .filter(Boolean);
}

export async function parseFeed(xml: string): Promise<FeedItem[]> {
  const feed = await parser.parseString(xml);
  const seen = new Set<string>();
  const items: FeedItem[] = [];
  for (const it of feed.items) {
    const title = normalizeText(it.title ?? "");
    const rawBody = it.content ?? it.contentSnippet ?? it.summary ?? "";
    const text = htmlFragmentToText(rawBody);
    const link = it.link?.trim() || undefined;
    let id = (it.guid ?? it.id ?? link ?? "").trim();
    if (!id) id = `hash:${shortHash(title + "\n" + (it.pubDate ?? ""))}`;
    if (seen.has(id)) continue; // some feeds repeat entries
    seen.add(id);
    const published = it.isoDate ?? (it.pubDate ? new Date(it.pubDate).toISOString() : undefined);
    items.push({
      id,
      title,
      link,
      publishedAt: published && !Number.isNaN(Date.parse(published)) ? new Date(published).toISOString() : undefined,
      categories: categoryNames(it.categories),
      text,
      hash: shortHash(title + "\n" + text),
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// HTML pages
// ---------------------------------------------------------------------------

export interface PageEntry {
  text: string;
  hash: string;
}

export interface PageBlock {
  id: string;
  heading?: string;
  anchor?: string;
  text: string;
  hash: string;
  /** In memory only; the snapshot stores just their hashes. */
  entries: PageEntry[];
}

/** Site chrome and non-content elements that only add diff noise. */
const SKIP_SELECTOR = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "canvas",
  "nav",
  "footer",
  "aside",
  "form",
  "button",
  "select",
  "[role=navigation]",
  "[role=search]",
  "[hidden]",
].join(",");

const BLOCK_TAGS = new Set([
  "address", "article", "blockquote", "dd", "details", "dialog", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "header", "hr", "li", "main", "ol", "p", "pre",
  "section", "summary", "table", "tbody", "thead", "tfoot", "tr", "td", "th", "ul",
]);

interface Line {
  heading?: number; // 1-6 for headings
  anchor?: string; // heading id, for deep links
  text: string;
  /**
   * False for lines in the middle of a top-level list item. Long sections are only
   * split at cuttable lines, so one changelog entry ("Remove X" + its "Affected
   * endpoints" list) always stays in a single block. A cuttable line also starts a
   * new entry.
   */
  cuttable: boolean;
}

/** Walks the DOM and emits one line per block-level element, headings tagged with their level. */
function toLines($: cheerio.CheerioAPI, root: AnyNode): Line[] {
  const lines: Line[] = [];
  let buf = "";
  let liDepth = 0;
  let itemStart = false;
  const flush = () => {
    const t = normalizeText(buf);
    buf = "";
    if (t && lines.at(-1)?.text !== t) {
      lines.push({ text: t, cuttable: liDepth === 0 || itemStart });
      itemStart = false;
    }
  };
  const walk = (node: AnyNode) => {
    if (!("children" in node)) return;
    for (const child of node.children) {
      if (child.type === "text") {
        buf += child.data;
        continue;
      }
      if (child.type !== "tag") continue;
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      const level = /^h([1-6])$/.exec(tag);
      if (level) {
        flush();
        const t = normalizeText($(el).text());
        const anchor = el.attribs.id || $(el).find("[id]").first().attr("id") || undefined;
        if (t) lines.push({ heading: Number(level[1]), anchor, text: t, cuttable: true });
      } else if (tag === "br") {
        flush();
      } else if (BLOCK_TAGS.has(tag)) {
        flush();
        const isItem = tag === "li";
        if (isItem && ++liDepth === 1) itemStart = true;
        walk(el);
        flush();
        if (isItem) {
          liDepth--;
          itemStart = false;
        }
      } else {
        walk(el);
      }
    }
  };
  walk(root);
  flush();
  return lines;
}

function toEntries(lines: Line[]): PageEntry[] {
  const groups: string[][] = [];
  for (const l of lines) {
    if (l.cuttable || groups.length === 0) groups.push([l.text]);
    else groups.at(-1)!.push(l.text);
  }
  return groups.map((g) => {
    const text = g.join("\n");
    return { text, hash: shortHash(text) };
  });
}

export function extractBlocks(html: string, selector?: string): PageBlock[] {
  const $ = cheerio.load(html);
  $(SKIP_SELECTOR).remove();

  const candidates = selector ? [selector] : ["main", "article", "[role=main]", "body"];
  let root: AnyNode | undefined;
  for (const sel of candidates) {
    root = $(sel).get(0);
    if (root) break;
  }
  if (!root) {
    // Fail loudly: a selector that stops matching means the page layout changed.
    throw new Error(`content selector ${JSON.stringify(selector ?? candidates.join(" | "))} matched nothing`);
  }

  // Group lines into sections under a heading path, e.g. "Breaking changes › Version 2026-03-10".
  const blocks: PageBlock[] = [];
  const idCounts = new Map<string, number>();
  const stack: { level: number; text: string; anchor?: string }[] = [];
  let body: Line[] = [];
  let bodyLen = 0;
  let chunk = 0;

  const emit = () => {
    const heading = stack.length ? stack.map((h) => h.text).join(" › ") : undefined;
    if (!heading && body.length === 0) return;
    const text = body.map((l) => l.text).join("\n");
    let id = heading ? slugify(stack.at(-1)!.text) : "intro";
    if (chunk > 0) id += `--part${chunk + 1}`;
    const n = idCounts.get(id) ?? 0;
    idCounts.set(id, n + 1);
    if (n > 0) id += `--${n + 1}`;
    const anchor = [...stack].reverse().find((h) => h.anchor)?.anchor;
    blocks.push({
      id,
      heading,
      anchor,
      text,
      hash: shortHash((heading ?? "") + "\n" + text),
      entries: toEntries(body),
    });
    body = [];
    bodyLen = 0;
  };

  for (const line of toLines($, root)) {
    if (line.heading) {
      emit();
      chunk = 0;
      while (stack.length && stack.at(-1)!.level >= line.heading) stack.pop();
      stack.push({ level: line.heading, text: line.text, anchor: line.anchor });
      continue;
    }
    if (line.cuttable && bodyLen > 0 && bodyLen + line.text.length > MAX_BLOCK_CHARS) {
      emit();
      chunk++;
    }
    body.push(line);
    bodyLen += line.text.length + 1;
  }
  emit();
  return blocks;
}
