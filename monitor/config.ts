import { fileURLToPath } from "node:url";
import path from "node:path";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.join(REPO_ROOT, "data");
export const INTEGRATIONS_DIR = path.join(DATA_DIR, "integrations");
export const SNAPSHOTS_DIR = path.join(DATA_DIR, "snapshots");

/**
 * Generic, honest User-Agent. The product token is what robots.txt groups are matched
 * against. No contact details or secrets go in here.
 */
export const USER_AGENT_TOKEN = "api-health-monitor";
export const USER_AGENT = `${USER_AGENT_TOKEN}/0.1 (automated public changelog checker)`;

export const FETCH_TIMEOUT_MS = 20_000;
export const RETRY_DELAY_MS = 3_000;
/** Minimum gap between two requests to the same host. */
export const PER_HOST_DELAY_MS = 1_000;
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Page sections longer than this are split into several blocks at line boundaries. */
export const MAX_BLOCK_CHARS = 1_500;
