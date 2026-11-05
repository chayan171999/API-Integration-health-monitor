/**
 * Validates every JSON file under /data against lib/schema.ts.
 * Run in CI before committing and before building the dashboard.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import { FindingsFile, IntegrationManifest, RunLog, Snapshot, StatusFile } from "../lib/schema.ts";
import { DATA_DIR } from "./config.ts";
import { errorMessage, readJson, readJsonIfExists } from "./util.ts";

const errors: string[] = [];
let checked = 0;

async function listJson(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(dir, f));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function check<T extends z.ZodType>(file: string, schema: T, extra?: (data: z.infer<T>) => string | undefined) {
  checked++;
  try {
    const data = await readJson(file, schema);
    const problem = extra?.(data);
    if (problem) errors.push(`${path.relative(DATA_DIR, file)}: ${problem}`);
  } catch (err) {
    errors.push(errorMessage(err));
  }
}

const manifestDir = path.join(DATA_DIR, "integrations");
const manifests = new Map<string, IntegrationManifest>();
for (const file of await listJson(manifestDir)) {
  await check(file, IntegrationManifest, (m) => {
    manifests.set(m.slug, m);
    return `${m.slug}.json` === path.basename(file) ? undefined : `slug "${m.slug}" does not match filename`;
  });
}

const snapshotRoot = path.join(DATA_DIR, "snapshots");
for (const slug of await readdir(snapshotRoot).catch(() => [] as string[])) {
  for (const file of await listJson(path.join(snapshotRoot, slug))) {
    await check(file, Snapshot, (s) => {
      if (s.integration !== slug) return `integration "${s.integration}" does not match folder "${slug}"`;
      if (`${s.sourceId}.json` !== path.basename(file)) return `sourceId "${s.sourceId}" does not match filename`;
      if (!manifests.get(slug)?.sources.some((src) => src.id === s.sourceId)) {
        return `orphan snapshot: no source "${s.sourceId}" in manifest "${slug}"`;
      }
      return undefined;
    });
  }
}

for (const file of await listJson(path.join(DATA_DIR, "findings"))) await check(file, FindingsFile);
for (const file of await listJson(path.join(DATA_DIR, "runs"))) await check(file, RunLog);
const statusFile = path.join(DATA_DIR, "status.json");
if (await readJsonIfExists(statusFile, StatusFile).catch((e) => (errors.push(errorMessage(e)), undefined))) checked++;

if (errors.length) {
  console.error(`${errors.length} problem(s) in ${checked} files:\n${errors.join("\n")}`);
  process.exit(1);
}
console.log(`ok: ${checked} data files valid`);
