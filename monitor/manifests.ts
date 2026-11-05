import { readdir } from "node:fs/promises";
import path from "node:path";
import { IntegrationManifest } from "../lib/schema.ts";
import { INTEGRATIONS_DIR } from "./config.ts";
import { readJson } from "./util.ts";

/** Loads and validates every manifest; the filename must equal the slug. */
export async function loadManifests(only?: string[]): Promise<IntegrationManifest[]> {
  const files = (await readdir(INTEGRATIONS_DIR)).filter((f) => f.endsWith(".json")).sort();
  const manifests: IntegrationManifest[] = [];
  for (const file of files) {
    const m = await readJson(path.join(INTEGRATIONS_DIR, file), IntegrationManifest);
    if (`${m.slug}.json` !== file) throw new Error(`${file}: slug "${m.slug}" does not match filename`);
    if (only && !only.includes(m.slug)) continue;
    manifests.push(m);
  }
  if (only) {
    const missing = only.filter((s) => !manifests.some((m) => m.slug === s));
    if (missing.length) throw new Error(`unknown integration(s): ${missing.join(", ")}`);
  }
  return manifests;
}
