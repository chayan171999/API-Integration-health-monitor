/**
 * Build-time data access for the dashboard. Reads the JSON the monitor commits to
 * /data and validates every file with the same Zod schemas the monitor writes with.
 * An invalid file fails the build loudly rather than rendering something wrong.
 */
import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import {
  FindingsFile,
  IntegrationManifest,
  LinksFile,
  Snapshot,
  StatusFile,
  type Finding,
  type IntegrationStatus,
  type LinkCheck,
} from "../../lib/schema.ts";

/** DASHBOARD_DATA_DIR lets you render a fixture dataset (e.g. to check red/yellow views). */
const DATA = process.env.DASHBOARD_DATA_DIR ? path.resolve(process.env.DASHBOARD_DATA_DIR) : path.join(process.cwd(), "data");

function read<T extends z.ZodType>(file: string, schema: T): z.infer<T> | undefined {
  if (!fs.existsSync(file)) return undefined;
  const parsed = schema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`${path.relative(process.cwd(), file)} failed validation:\n${issues}`);
  }
  return parsed.data;
}

export interface SourceView {
  id: string;
  type: IntegrationManifest["sources"][number]["type"];
  url: string;
  note?: string;
  snapshot?: Snapshot;
}

export interface IntegrationView {
  manifest: IntegrationManifest;
  status: IntegrationStatus;
  findings: Finding[];
  sources: SourceView[];
  links?: { checkedAt: string; links: LinkCheck[] };
}

export interface Dashboard {
  generatedAt: string;
  today: string;
  integrations: IntegrationView[];
}

const STATUS_ORDER = { red: 0, yellow: 1, unknown: 2, green: 3 } as const;

function placeholderStatus(slug: string): IntegrationStatus {
  return {
    integration: slug,
    status: "unknown",
    reason: "Not checked yet: run the monitor to compute a status",
    openFindings: 0,
    lastChecked: new Date(0).toISOString(),
    sourcesOk: 0,
    sourcesFailed: 0,
  };
}

let cache: Dashboard | undefined;

export function loadDashboard(): Dashboard {
  if (cache) return cache;
  const manifestDir = path.join(DATA, "integrations");
  const manifests = fs
    .readdirSync(manifestDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => read(path.join(manifestDir, f), IntegrationManifest)!);

  const statusFile = read(path.join(DATA, "status.json"), StatusFile);
  const generatedAt = statusFile?.generatedAt ?? new Date().toISOString();

  const integrations: IntegrationView[] = manifests.map((manifest) => ({
    manifest,
    status: statusFile?.integrations.find((s) => s.integration === manifest.slug) ?? placeholderStatus(manifest.slug),
    findings: read(path.join(DATA, "findings", `${manifest.slug}.json`), FindingsFile) ?? [],
    sources: manifest.sources.map((s) => ({
      id: s.id,
      type: s.type,
      url: s.url,
      note: s.note,
      snapshot: read(path.join(DATA, "snapshots", manifest.slug, `${s.id}.json`), Snapshot),
    })),
    links: read(path.join(DATA, "links", `${manifest.slug}.json`), LinksFile),
  }));

  // Red -> yellow -> unknown -> green, then soonest deadline, then name.
  integrations.sort(
    (a, b) =>
      STATUS_ORDER[a.status.status] - STATUS_ORDER[b.status.status] ||
      (a.status.daysToDeadline ?? Infinity) - (b.status.daysToDeadline ?? Infinity) ||
      a.manifest.name.localeCompare(b.manifest.name),
  );

  cache = { generatedAt, today: generatedAt.slice(0, 10), integrations };
  return cache;
}

export function getIntegration(slug: string): IntegrationView | undefined {
  return loadDashboard().integrations.find((i) => i.manifest.slug === slug);
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso.slice(0, 10) + "T00:00:00Z");
  const b = Date.parse(toIso.slice(0, 10) + "T00:00:00Z");
  return Math.round((b - a) / 86_400_000);
}

/** Findings that still need a human: open or acknowledged, and not info. */
export const isActionable = (f: Finding) => (f.status === "open" || f.status === "acknowledged") && f.severity !== "info";

export interface Deadline {
  integration: IntegrationView;
  finding: Finding;
  days: number;
}

/** Deadlines of actionable findings from `today` (or overdue) through `windowDays` ahead, soonest first. */
export function upcomingDeadlines(d: Dashboard, windowDays: number): Deadline[] {
  const out: Deadline[] = [];
  for (const integration of d.integrations) {
    for (const finding of integration.findings) {
      if (!isActionable(finding) || !finding.effectiveDate) continue;
      const days = daysBetween(d.today, finding.effectiveDate);
      if (days <= windowDays) out.push({ integration, finding, days });
    }
  }
  return out.sort((a, b) => a.days - b.days);
}
