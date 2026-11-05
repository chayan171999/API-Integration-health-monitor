/**
 * The monitor pipeline (BRIEF section 9), steps 1–5:
 *   collect -> diff -> link check -> classify -> dedupe -> score
 *
 *   npm run monitor                         # everything
 *   npm run monitor -- --only slack,stripe  # fetch/classify a subset (status is rescored for all)
 *   npm run monitor -- --reclassify         # classify all current content, not just changes
 *   npm run monitor -- --skip-links         # skip the doc-link check
 *   npm run monitor -- --today 2026-11-05   # pin "today" (tests, backtests)
 *
 * Snapshots are written only after findings, so a crash never loses a change.
 * A failing source never fails the run; it shows up as source health instead.
 */
import path from "node:path";
import { parseArgs } from "node:util";
import {
  FindingsFile,
  LinksFile,
  StatusFile,
  type Finding,
  type IntegrationManifest,
  type IntegrationStatus,
  type Snapshot,
} from "../lib/schema.ts";
import { classifyEntry, classifyIncident } from "./classify.ts";
import { collectSource, readSnapshot, writeSnapshot } from "./collect.ts";
import { DATA_DIR } from "./config.ts";
import { mergeFindings } from "./dedupe.ts";
import { diffSnapshot, enrichTeasers } from "./diff.ts";
import { checkLink, linkFindings } from "./links.ts";
import { loadManifests } from "./manifests.ts";
import { computeStatus, severityOf, sourceHealth } from "./score.ts";
import { readJsonIfExists, writeJson } from "./util.ts";

export const findingsPath = (slug: string) => path.join(DATA_DIR, "findings", `${slug}.json`);
export const linksPath = (slug: string) => path.join(DATA_DIR, "links", `${slug}.json`);
export const STATUS_PATH = path.join(DATA_DIR, "status.json");

const { values } = parseArgs({
  options: {
    only: { type: "string" },
    reclassify: { type: "boolean", default: false },
    "skip-links": { type: "boolean", default: false },
    today: { type: "string" },
  },
});
const today = values.today ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`--today must be YYYY-MM-DD, got "${today}"`);
const only = values.only?.split(",").map((s) => s.trim()).filter(Boolean);
const startedAt = new Date().toISOString();
const t0 = Date.now();

async function processIntegration(manifest: IntegrationManifest): Promise<Finding[]> {
  console.log(`\n${manifest.name}`);
  const existing = (await readJsonIfExists(findingsPath(manifest.slug), FindingsFile)) ?? [];
  const incoming: Finding[] = [];
  const snapshots: Snapshot[] = [];

  for (const source of manifest.sources) {
    const result = await collectSource(manifest, source);
    snapshots.push(result.snapshot);
    const s = result.snapshot;
    if (!s.ok) {
      console.log(`  FAIL  ${source.id.padEnd(30)} ${String(s.httpStatus ?? "-").padEnd(4)} ${s.error}`);
      continue;
    }
    const baseline = values.reclassify || !result.previous?.fetchedAt;
    const diff = diffSnapshot(manifest, source, result, { all: baseline });
    await enrichTeasers(diff, source);
    let classified = 0;
    for (const c of diff.candidates) {
      const f =
        source.type === "status_page"
          ? classifyIncident(c, manifest, { today, baseline })
          : classifyEntry(c, manifest, { today, baseline });
      if (f) {
        incoming.push(f);
        classified++;
      }
    }
    const changed = s.format === "feed" ? `${diff.newItems} new/changed items` : `${diff.changedBlocks} changed blocks`;
    console.log(
      `  ok    ${source.id.padEnd(30)} ${String(s.httpStatus).padEnd(4)} ${changed}, ${diff.candidates.length} candidates, ${classified} classified` +
        (baseline ? " [baseline]" : ""),
    );
    for (const e of diff.enrichFailures) console.log(`        (kept teaser) ${e}`);
  }

  if (!values["skip-links"]) {
    const checks = [];
    for (const url of manifest.docLinks) checks.push(await checkLink(url));
    await writeJson(linksPath(manifest.slug), LinksFile, { integration: manifest.slug, checkedAt: new Date().toISOString(), links: checks });
    incoming.push(...linkFindings(manifest, checks, today));
    const bad = checks.filter((c) => c.verdict !== "ok");
    console.log(`  links ${checks.length - bad.length}/${checks.length} ok` + bad.map((c) => `\n        ${c.verdict}: ${c.url} (${c.note})`).join(""));
  }

  const merged = mergeFindings(existing, incoming);
  await writeJson(findingsPath(manifest.slug), FindingsFile, merged.findings);
  for (const snap of snapshots) await writeSnapshot(snap); // only after findings are safe

  const bySev = (sev: string) => merged.created.filter((f) => f.severity === sev).length;
  console.log(`  findings: ${merged.created.length} new (${bySev("red")} red, ${bySev("yellow")} yellow, ${bySev("info")} info), ${merged.updated} seen again`);
  return merged.created;
}

/** Recompute severity (deadlines move closer every day) and status for every integration. */
async function scoreAll(): Promise<IntegrationStatus[]> {
  const statuses: IntegrationStatus[] = [];
  for (const manifest of await loadManifests()) {
    const findings = (await readJsonIfExists(findingsPath(manifest.slug), FindingsFile)) ?? [];
    let changed = false;
    for (const f of findings) {
      const sev = severityOf(f, today);
      if (sev !== f.severity) {
        f.severity = sev;
        changed = true;
      }
    }
    if (changed) await writeJson(findingsPath(manifest.slug), FindingsFile, findings);
    const snapshots: Snapshot[] = [];
    for (const s of manifest.sources) {
      const snap = await readSnapshot(manifest.slug, s.id);
      if (snap) snapshots.push(snap);
    }
    const lastChecked = snapshots.map((s) => s.lastAttemptAt).sort().at(-1) ?? startedAt;
    statuses.push(computeStatus(manifest, findings, sourceHealth(manifest, snapshots), today, lastChecked));
  }
  await writeJson(STATUS_PATH, StatusFile, { generatedAt: new Date().toISOString(), integrations: statuses });
  return statuses;
}

let created = 0;
for (const manifest of await loadManifests(only)) created += (await processIntegration(manifest)).length;
const statuses = await scoreAll();

console.log(`\nStatus (${today}):`);
for (const s of statuses) {
  const deadline = s.nextDeadline ? `  next deadline ${s.nextDeadline} (${s.daysToDeadline} d)` : "";
  console.log(`  ${s.status.toUpperCase().padEnd(8)} ${s.integration.padEnd(10)} ${s.reason}${deadline}`);
}
const count = (st: string) => statuses.filter((s) => s.status === st).length;
console.log(
  `\n${created} new findings. ${count("red")} red, ${count("yellow")} yellow, ${count("green")} green, ${count("unknown")} unknown. ${((Date.now() - t0) / 1000).toFixed(1)} s`,
);
// Everything is written. Don't let a stalled socket from a timed-out request keep the process alive.
process.exit(0);
