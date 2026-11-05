/**
 * Pipeline step 3 (Link check): every docLinks URL gets a GET. 404/410, or a redirect to a generic page, is a broken_doc_link finding.
 * A redirect to another specific page is "moved": recorded, not flagged.
 * Network errors and 403/429 are "error": we can't tell, so nothing is flagged.
 */
import type { Finding, IntegrationManifest, LinkCheck } from "../lib/schema.ts";
import { FetchError, getWithRetry, isAllowedByRobots } from "./http.ts";
import { severityOf } from "./score.ts";
import { errorMessage, shortHash } from "./util.ts";

/** Path with locale prefix and trailing slash stripped, lowercased. */
function canonicalPath(u: URL): string {
  return u.pathname
    .replace(/^\/(?:[a-z]{2}(?:-[a-z]{2})?)(?=\/|$)/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

const GENERIC_PATH = /^(?:|\/docs|\/documentation|\/reference|\/api|\/developers|\/home|\/index(?:\.html)?)$/;
const ERROR_PATH = /(?:^|\/)(?:404|not[-_]?found|error|page-not-found)(?:\/|\.html|$)/;

export function judgeRedirect(original: string, final: string): "ok" | "moved" | "broken" {
  const a = new URL(original);
  const b = new URL(final);
  const pa = canonicalPath(a);
  const pb = canonicalPath(b);
  if (a.host === b.host && pa === pb) return "ok"; // trailing slash, locale, http->https
  if (GENERIC_PATH.test(pb) || ERROR_PATH.test(pb)) return "broken";
  // Redirected up to an ancestor section (e.g. /rest/issues/issues -> /rest): the specific page is gone.
  if (a.host === b.host && pa.startsWith(pb + "/") && pb.split("/").length <= 2) return "broken";
  return "moved";
}

export async function checkLink(url: string): Promise<LinkCheck> {
  try {
    if (!(await isAllowedByRobots(url))) {
      return { url, verdict: "error", httpStatus: null, note: "blocked by robots.txt" };
    }
    // GET, not HEAD: several CDNs mishandle HEAD (one stalled for minutes in testing).
    const res = await getWithRetry(url, "GET");
    const finalUrl = res.finalUrl && res.finalUrl !== url ? res.finalUrl : undefined;
    if (res.status === 404 || res.status === 410) {
      return { url, verdict: "broken", httpStatus: res.status, finalUrl, note: `HTTP ${res.status}` };
    }
    if (res.status < 200 || res.status >= 400) {
      return { url, verdict: "error", httpStatus: res.status, finalUrl, note: `HTTP ${res.status}: can't tell if the page exists` };
    }
    if (finalUrl) {
      const verdict = judgeRedirect(url, finalUrl);
      const note = verdict === "broken" ? "redirects to a generic page" : verdict === "moved" ? "page moved; link still resolves" : undefined;
      return { url, verdict, httpStatus: res.status, finalUrl, note };
    }
    return { url, verdict: "ok", httpStatus: res.status };
  } catch (err) {
    const status = err instanceof FetchError ? err.status : null;
    return { url, verdict: "error", httpStatus: status, note: errorMessage(err) };
  }
}

export function linkFindingId(integration: string, url: string): string {
  return shortHash(`doc-link\n${integration}\n${url}`);
}

/** One finding per broken link; a link that is fine again yields a "resolved" finding to close it. */
export function linkFindings(manifest: IntegrationManifest, checks: LinkCheck[], today: string): Finding[] {
  const out: Finding[] = [];
  for (const c of checks) {
    if (c.verdict === "error" || c.verdict === "moved") continue;
    const broken = c.verdict === "broken";
    const base = { category: "broken_doc_link" as const, affects: [c.url], effectiveDate: undefined, confidence: "high" as const, appliesToVersion: undefined };
    out.push({
      id: linkFindingId(manifest.slug, c.url),
      integration: manifest.slug,
      sourceId: "doc-links",
      sourceUrl: c.url,
      detectedAt: today,
      category: "broken_doc_link",
      severity: severityOf(base, today),
      affects: [c.url],
      matchedTerms: [`link:${c.note ?? `HTTP ${c.httpStatus}`}`, ...(c.finalUrl ? [`redirect:${c.finalUrl}`] : [])],
      excerpt: (broken ? `${c.url} → ${c.note}` : `${c.url} resolves again`).slice(0, 300),
      summary: broken
        ? `A ${manifest.name} docs link your docs or code point to is broken (${c.note}).`
        : `This ${manifest.name} docs link works again.`,
      suggestedAction: broken ? `Find the new location of this page and update the link.` : "No action needed.",
      confidence: "high",
      classifiedBy: "rules",
      status: broken ? "open" : "resolved",
      lastSeenAt: today,
    });
  }
  return out;
}
