import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Finding } from "../../../lib/schema.ts";
import { Code, DeadlineText, EmptyState, FindingCard, Section, StatusBadge, formatDateTime } from "../../components.tsx";
import { getIntegration, isActionable, loadDashboard } from "../../lib/data.ts";

export function generateStaticParams() {
  return loadDashboard().integrations.map((i) => ({ slug: i.manifest.slug }));
}

export const dynamicParams = false;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const i = getIntegration(slug);
  return { title: i ? `${i.manifest.name} · Integration Health` : "Not found" };
}

const SEV_RANK = { red: 0, yellow: 1, info: 2 } as const;
const byUrgency = (a: Finding, b: Finding) =>
  SEV_RANK[a.severity] - SEV_RANK[b.severity] || (a.effectiveDate ?? "9999").localeCompare(b.effectiveDate ?? "9999");

const SOURCE_TYPE_LABEL = {
  rss: "Feed",
  changelog_page: "Changelog page",
  deprecations_page: "Deprecations page",
  status_page: "Status feed",
  docs_page: "Docs page",
} as const;

function UsesRow({ label, items }: { label: string; items?: string[] }) {
  if (!items?.length) return null;
  return (
    <>
      <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="flex flex-wrap gap-1">
        {items.map((x) => (
          <Code key={x}>{x}</Code>
        ))}
      </dd>
    </>
  );
}

export default async function IntegrationPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const integration = getIntegration(slug);
  if (!integration) notFound();
  const { manifest, status, findings, sources, links } = integration;
  const { today } = loadDashboard();

  const actionable = findings.filter(isActionable).sort(byUrgency);
  const active = findings.filter((f) => (f.status === "open" || f.status === "acknowledged") && f.severity === "info");
  // Upgrade notes: changes under a newer API version that touch something we use.
  const upgradeNotes = active.filter((f) => f.appliesToVersion && f.affects.length > 0);
  const info = active.filter((f) => !(f.appliesToVersion && f.affects.length > 0));
  const closed = findings.filter((f) => f.status === "resolved" || f.status === "dismissed");

  return (
    <>
      <Link href="/" className="text-sm text-blue-700 hover:underline dark:text-blue-400">
        ← All integrations
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{manifest.name}</h1>
        <StatusBadge status={status.status} />
      </div>
      <p className="mt-2 max-w-3xl text-slate-700 dark:text-slate-300">{status.reason}</p>

      <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <div>
          <dt className="text-slate-500 dark:text-slate-400">Next deadline</dt>
          <dd>
            <DeadlineText date={status.nextDeadline} today={today} />
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">Needs attention</dt>
          <dd className="tabular-nums">{status.openFindings} open</dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">Sources</dt>
          <dd className="tabular-nums">
            {status.sourcesOk} ok
            {status.sourcesFailed > 0 && <span className="text-amber-700 dark:text-amber-300"> · {status.sourcesFailed} failing</span>}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">Last checked</dt>
          <dd className="tabular-nums">{formatDateTime(status.lastChecked)}</dd>
        </div>
      </dl>

      <Section title="Open findings" count={actionable.length} id="open">
        {actionable.length === 0 ? (
          <EmptyState>Nothing open touches what {manifest.name} uses.</EmptyState>
        ) : (
          <div className="space-y-4">
            {actionable.map((f) => (
              <div key={f.id} id={`finding-${f.id}`} className="scroll-mt-4">
                <FindingCard f={f} today={today} />
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          To acknowledge or dismiss a finding, set its <Code>status</Code> (and <Code>dismissReason</Code>) in{" "}
          <Code>data/findings/{manifest.slug}.json</Code> in a commit or PR.
        </p>
      </Section>

      <Section title="What this integration uses">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm sm:grid-cols-[10rem_1fr] dark:border-slate-800 dark:bg-slate-900">
          <dt className="text-slate-500 dark:text-slate-400">Auth</dt>
          <dd>
            {manifest.authMethod}
            {manifest.apiVersion && (
              <>
                {" "}
                · pinned to API version <Code>{manifest.apiVersion}</Code>
              </>
            )}
          </dd>
          <UsesRow label="Endpoints" items={manifest.uses.endpoints} />
          <UsesRow label="Scopes" items={manifest.uses.scopes} />
          <UsesRow label="Webhooks / events" items={manifest.uses.webhooksOrEvents} />
          <UsesRow label="Keywords" items={manifest.uses.keywords} />
          <UsesRow label="Status components" items={manifest.uses.statusComponents} />
        </dl>
      </Section>

      <Section title="Sources" count={sources.length}>
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Source</th>
                <th scope="col" className="px-4 py-2 font-medium">Health</th>
                <th scope="col" className="px-4 py-2 font-medium">Last good fetch</th>
                <th scope="col" className="px-4 py-2 font-medium">Content</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {sources.map((s) => {
                const snap = s.snapshot;
                return (
                  <tr key={s.id} className="align-top">
                    <td className="px-4 py-3">
                      <a href={s.url} target="_blank" rel="noreferrer" className="font-medium text-blue-700 hover:underline dark:text-blue-400">
                        {s.id}
                      </a>
                      <div className="text-xs text-slate-500 dark:text-slate-400">{SOURCE_TYPE_LABEL[s.type]}</div>
                      {s.note && <div className="mt-1 max-w-sm text-xs text-slate-500 dark:text-slate-400">{s.note}</div>}
                    </td>
                    <td className="px-4 py-3">
                      {!snap ? (
                        <span className="text-slate-500">never fetched</span>
                      ) : snap.ok ? (
                        <span className="text-emerald-700 dark:text-emerald-300">OK · HTTP {snap.httpStatus}</span>
                      ) : (
                        <span className="text-red-700 dark:text-red-300">
                          Failing{snap.consecutiveFailures > 1 ? ` ×${snap.consecutiveFailures}` : ""}
                          <div className="mt-0.5 max-w-xs text-xs">{snap.error}</div>
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums text-slate-600 dark:text-slate-400">
                      {snap?.fetchedAt ? formatDateTime(snap.fetchedAt) : "—"}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-slate-600 dark:text-slate-400">
                      {snap?.format === "feed" ? `${snap.items.length} items` : snap?.format === "page" ? `${snap.blocks.length} blocks` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Doc links" count={manifest.docLinks.length}>
        {!links ? (
          <EmptyState>Not checked yet.</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white text-sm shadow-sm dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
            {links.links.map((l) => (
              <li key={l.url} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2">
                <a href={l.url} target="_blank" rel="noreferrer" className="break-all text-blue-700 hover:underline dark:text-blue-400">
                  {l.url}
                </a>
                <span
                  className={
                    l.verdict === "ok"
                      ? "text-emerald-700 dark:text-emerald-300"
                      : l.verdict === "broken"
                        ? "font-medium text-red-700 dark:text-red-300"
                        : "text-amber-700 dark:text-amber-300"
                  }
                >
                  {l.verdict}
                  {l.note && <span className="text-slate-500 dark:text-slate-400"> · {l.note}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
        {links && <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">Checked {formatDateTime(links.checkedAt)}.</p>}
      </Section>

      <Section title="Upgrade notes" count={upgradeNotes.length}>
        {upgradeNotes.length === 0 ? (
          <EmptyState>No changes listed under newer API versions.</EmptyState>
        ) : (
          <details className="group rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <summary className="cursor-pointer text-sm text-slate-700 dark:text-slate-300">
              {upgradeNotes.length} changes under API versions newer than the pinned <Code>{manifest.apiVersion}</Code>. They don&apos;t affect status
              until you upgrade.
            </summary>
            <div className="mt-4 space-y-4">
              {upgradeNotes.sort(byUrgency).map((f) => (
                <FindingCard key={f.id} f={f} today={today} />
              ))}
            </div>
          </details>
        )}
      </Section>

      <Section title="Informational" count={info.length}>
        {info.length === 0 ? (
          <EmptyState>No informational findings.</EmptyState>
        ) : (
          <details className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <summary className="cursor-pointer text-sm text-slate-700 dark:text-slate-300">
              {info.length} provider changes that don&apos;t mention anything {manifest.name} uses. Shown for transparency; they never change status.
            </summary>
            <div className="mt-4 space-y-4">
              {info.map((f) => (
                <FindingCard key={f.id} f={f} today={today} />
              ))}
            </div>
          </details>
        )}
      </Section>

      {closed.length > 0 && (
        <Section title="Resolved and dismissed" count={closed.length}>
          <details className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <summary className="cursor-pointer text-sm text-slate-700 dark:text-slate-300">Show closed findings</summary>
            <div className="mt-4 space-y-4">
              {closed.map((f) => (
                <FindingCard key={f.id} f={f} today={today} />
              ))}
            </div>
          </details>
        </Section>
      )}

      <Section title="Status history">
        <EmptyState>Status history comes from daily run logs, which start in build step 5.</EmptyState>
      </Section>
    </>
  );
}
