/**
 * Polite HTTP client: robots.txt check, generic User-Agent, timeout, one retry,
 * and a minimum gap between requests to the same host. Unauthenticated GETs only.
 */
import {
  FETCH_TIMEOUT_MS,
  MAX_BODY_BYTES,
  PER_HOST_DELAY_MS,
  RETRY_DELAY_MS,
  USER_AGENT,
  USER_AGENT_TOKEN,
} from "./config.ts";
import { ALLOW_ALL, DISALLOW_ALL, parseRobots, type RobotsPolicy } from "./robots.ts";
import { errorMessage, sleep } from "./util.ts";

export interface HttpResult {
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
}

/** Thrown for failures that never produced a usable response (blocked, network, timeout). */
export class FetchError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "FetchError";
    this.status = status;
  }
}

const DEBUG = process.env.MONITOR_DEBUG === "1";
const lastRequestAt = new Map<string, number>();
const robotsCache = new Map<string, Promise<RobotsPolicy>>();

async function waitForHost(host: string): Promise<void> {
  const last = lastRequestAt.get(host);
  if (last !== undefined) {
    const wait = last + PER_HOST_DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);
  }
  lastRequestAt.set(host, Date.now());
}

async function rawGet(url: string, method: "GET" | "HEAD" = "GET"): Promise<HttpResult> {
  await waitForHost(new URL(url).host);
  const started = Date.now();
  if (DEBUG) console.error(`[http] +${(performance.now() / 1000).toFixed(1)}s ${method} ${url}`);
  // Hard timeout for the whole request, body included. We abort the fetch AND race it
  // against our own timer: in practice an abort doesn't always interrupt a stalled
  // request (seen: a HEAD to docs.github.com hanging until undici's 300 s header timeout).
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timed out after ${FETCH_TIMEOUT_MS} ms`)); // plain Error: retryable
    }, FETCH_TIMEOUT_MS);
  });
  const work = (async (): Promise<HttpResult> => {
    const res = await fetch(url, {
      method,
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/html;q=0.8, */*;q=0.5",
        // Pinned so text doesn't vary by the runner's location: Stripe's docs serve
        // en-GB or en-US by IP otherwise, which would look like changed content.
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) {
      await res.body?.cancel();
      throw new FetchError(`response too large (${declared} bytes)`, res.status);
    }
    const body = method === "HEAD" ? "" : await res.text();
    if (body.length > MAX_BODY_BYTES) throw new FetchError(`response too large (${body.length} chars)`, res.status);
    return { status: res.status, finalUrl: res.url, contentType: res.headers.get("content-type") ?? "", body };
  })();
  work.catch(() => {}); // if the timer wins, the late rejection is expected
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    if (DEBUG) console.error(`[http] +${(performance.now() / 1000).toFixed(1)}s done ${url} ${Date.now() - started} ms`);
  }
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** GET with one retry on network errors, timeouts, 429 and 5xx. Does not check robots.txt. */
export async function getWithRetry(url: string, method: "GET" | "HEAD" = "GET"): Promise<HttpResult> {
  let firstError: unknown;
  try {
    const res = await rawGet(url, method);
    if (!isRetryable(res.status)) return res;
    firstError = new FetchError(`HTTP ${res.status}`, res.status);
  } catch (err) {
    if (err instanceof FetchError) throw err; // too large: retrying won't help
    firstError = err;
  }
  await sleep(RETRY_DELAY_MS);
  try {
    return await rawGet(url, method);
  } catch (err) {
    throw new FetchError(`${errorMessage(err)} (first attempt: ${errorMessage(firstError)})`);
  }
}

async function loadRobots(origin: string): Promise<RobotsPolicy> {
  try {
    const res = await getWithRetry(`${origin}/robots.txt`);
    if (res.status >= 200 && res.status < 300) return parseRobots(res.body, USER_AGENT_TOKEN);
    // RFC 9309: 4xx means no restrictions; 5xx means assume complete disallow.
    if (res.status >= 400 && res.status < 500) return ALLOW_ALL;
    return DISALLOW_ALL;
  } catch {
    return DISALLOW_ALL; // unreachable robots.txt: be conservative
  }
}

export async function isAllowedByRobots(url: string): Promise<boolean> {
  const u = new URL(url);
  let policy = robotsCache.get(u.origin);
  if (!policy) {
    policy = loadRobots(u.origin);
    robotsCache.set(u.origin, policy);
  }
  return (await policy).isAllowed(u.pathname + u.search);
}

/** Robots-checked GET. Non-2xx responses are returned, not thrown; the caller decides. */
export async function politeGet(url: string): Promise<HttpResult> {
  if (!(await isAllowedByRobots(url))) {
    throw new FetchError("blocked by robots.txt (or robots.txt unreachable)");
  }
  try {
    return await getWithRetry(url);
  } catch (err) {
    if (err instanceof FetchError) throw err;
    throw new FetchError(errorMessage(err));
  }
}
