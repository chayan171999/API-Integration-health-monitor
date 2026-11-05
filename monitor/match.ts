/**
 * Relevance (BRIEF 6.2): does a piece of text mention something this integration uses?
 *
 * Identifiers (endpoints, scopes, events, the pinned version) are code: an exact
 * match is the identical string at token boundaries. Case differences, dots vs
 * slashes, plurals and `/v1/` prefixes are "fuzzy" and only ever give low confidence.
 *
 * Keywords are prose: case-insensitive and plural-tolerant counts as exact.
 * Status components are matched case-sensitively, exactly as written in the manifest.
 */
import type { IntegrationManifest } from "../lib/schema.ts";

export type TermKind = "endpoint" | "scope" | "event" | "keyword" | "version" | "statusComponent";

export interface Term {
  kind: TermKind;
  value: string;
}

export interface TermMatch {
  term: string;
  kind: TermKind;
  exact: boolean;
  index: number;
  matchedText: string;
}

const HTTP_METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)$/;
const ANY_METHOD = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+$/;
/** Words that must be near a bare-word scope/event ("repo", "issues") for it to count. */
const SCOPE_CONTEXT = /\b(?:scopes?|permissions?)\b/i;
const EVENT_CONTEXT = /\b(?:webhooks?|events?|payloads?)\b/i;
const CONTEXT_WINDOW = 40;

export function termsFor(manifest: IntegrationManifest, opts: { statusPage?: boolean } = {}): Term[] {
  if (opts.statusPage) {
    return (manifest.uses.statusComponents ?? []).map((value) => ({ kind: "statusComponent", value }));
  }
  const terms: Term[] = [
    ...manifest.uses.endpoints.map((value) => ({ kind: "endpoint" as const, value })),
    ...manifest.uses.scopes.map((value) => ({ kind: "scope" as const, value })),
    ...manifest.uses.webhooksOrEvents.map((value) => ({ kind: "event" as const, value })),
    ...(manifest.uses.keywords ?? []).map((value) => ({ kind: "keyword" as const, value })),
  ];
  if (manifest.apiVersion) terms.push({ kind: "version", value: manifest.apiVersion });
  return terms;
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Characters that continue an identifier (so "files.upload" doesn't match inside "files.uploadV2"). */
const IDENT_CHAR = "[A-Za-z0-9_{}]";
/** Lookarounds for identifier boundaries: no ident char, and no "." / ":" / "/" followed by one. */
const BEFORE = `(?<!${IDENT_CHAR}|[.:/]${IDENT_CHAR}*)`;
const AFTER = `(?!${IDENT_CHAR}|[.:/]${IDENT_CHAR})`;

function findAll(text: string, re: RegExp): { index: number; text: string }[] {
  const out: { index: number; text: string }[] = [];
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (const m of text.matchAll(g)) out.push({ index: m.index, text: m[0] });
  return out;
}

function hasNearby(text: string, index: number, length: number, ctx: RegExp): boolean {
  const from = Math.max(0, index - CONTEXT_WINDOW);
  return ctx.test(text.slice(from, index + length + CONTEXT_WINDOW));
}

/** Fuzzy spellings of an identifier: dots<->slashes, plural/singular, without /v1/. */
function fuzzyVariants(value: string): string[] {
  const v = new Set<string>();
  const base = value.replace(/^\/v\d+\//, "");
  for (const s of [value, base]) {
    v.add(s);
    if (s.includes(".")) v.add(s.replaceAll(".", "/"));
    if (s.includes("/") && !s.startsWith("/")) v.add(s.replaceAll("/", "."));
    if (s.endsWith("s")) v.add(s.slice(0, -1));
    else v.add(s + "s");
  }
  return [...v].filter((s) => s.length >= 4);
}

function matchEndpoint(text: string, value: string): TermMatch[] {
  const http = HTTP_METHOD.exec(value);
  if (http) {
    const [, method, path] = http as unknown as [string, string, string];
    const out: TermMatch[] = [];
    // Exact: the path with identical placeholders, and no *different* method right before it.
    for (const m of findAll(text, new RegExp(`(?<![A-Za-z0-9_{}/])${esc(path)}(?![A-Za-z0-9_{}/-])`))) {
      const before = ANY_METHOD.exec(text.slice(Math.max(0, m.index - 8), m.index));
      if (before && before[1] !== method) continue;
      out.push({ term: value, kind: "endpoint", exact: true, index: m.index, matchedText: m.text });
    }
    if (out.length) return out;
    // Fuzzy: same path shape, any placeholder names, any case.
    const shape = path
      .split(/(\{[^}]+\})/)
      .map((part) => (part.startsWith("{") ? "(?:\\{[^}/]+\\}|:[A-Za-z_]+)" : esc(part)))
      .join("");
    for (const m of findAll(text, new RegExp(`(?<![A-Za-z0-9_{}/])${shape}(?![A-Za-z0-9_{}/-])`, "i"))) {
      const before = ANY_METHOD.exec(text.slice(Math.max(0, m.index - 8), m.index));
      if (before && before[1]!.toUpperCase() !== method) continue;
      out.push({ term: value, kind: "endpoint", exact: false, index: m.index, matchedText: m.text });
    }
    return out;
  }
  return matchIdentifier(text, value, "endpoint");
}

function matchIdentifier(text: string, value: string, kind: TermKind, context?: RegExp): TermMatch[] {
  const needsContext = context && /^[A-Za-z]+$/.test(value); // bare words like "repo", "issues"
  const keep = (m: { index: number; text: string }) => !needsContext || hasNearby(text, m.index, m.text.length, context!);

  const exact = findAll(text, new RegExp(`${BEFORE}${esc(value)}${AFTER}`)).filter(keep);
  if (exact.length) return exact.map((m) => ({ term: value, kind, exact: true, index: m.index, matchedText: m.text }));

  const out: TermMatch[] = [];
  for (const variant of fuzzyVariants(value)) {
    for (const m of findAll(text, new RegExp(`${BEFORE}${esc(variant)}${AFTER}`, "i")).filter(keep)) {
      out.push({ term: value, kind, exact: false, index: m.index, matchedText: m.text });
    }
  }
  return out;
}

function matchKeyword(text: string, value: string): TermMatch[] {
  const stem = value.replace(/s$/i, "");
  const re = new RegExp(`(?<![A-Za-z0-9_])${esc(stem)}(?:s|es)?(?![A-Za-z0-9_])`, "i");
  return findAll(text, re).map((m) => ({ term: value, kind: "keyword", exact: true, index: m.index, matchedText: m.text }));
}

function matchStatusComponent(text: string, value: string): TermMatch[] {
  const re = new RegExp(`(?<![A-Za-z0-9_])${esc(value)}(?![A-Za-z0-9_])`);
  return findAll(text, re).map((m) => ({ term: value, kind: "statusComponent", exact: true, index: m.index, matchedText: m.text }));
}

export function findMatches(text: string, terms: Term[]): TermMatch[] {
  const out: TermMatch[] = [];
  for (const t of terms) {
    switch (t.kind) {
      case "endpoint":
        out.push(...matchEndpoint(text, t.value));
        break;
      case "scope":
        out.push(...matchIdentifier(text, t.value, "scope", SCOPE_CONTEXT));
        break;
      case "event":
        out.push(...matchIdentifier(text, t.value, "event", EVENT_CONTEXT));
        break;
      case "version":
        out.push(
          ...findAll(text, new RegExp(`(?<![0-9])${esc(t.value)}(?![0-9])`)).map((m) => ({
            term: t.value,
            kind: "version" as const,
            exact: true,
            index: m.index,
            matchedText: m.text,
          })),
        );
        break;
      case "keyword":
        out.push(...matchKeyword(text, t.value));
        break;
      case "statusComponent":
        out.push(...matchStatusComponent(text, t.value));
        break;
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Unique manifest items touched, exact matches first. */
export function affectedItems(matches: TermMatch[]): string[] {
  const exact = matches.filter((m) => m.exact).map((m) => m.term);
  const fuzzy = matches.filter((m) => !m.exact).map((m) => m.term);
  return [...new Set([...exact, ...fuzzy])];
}
