import Link from "next/link";
import { CATEGORY_LABEL, Code, EmptyState, StatusBadge, formatDateTime, relativeDays } from "./components.tsx";
import { loadDashboard, upcomingDeadlines } from "./lib/data.ts";

const DEADLINE_WINDOW_DAYS = 60;

const COUNT_CARDS = [
  { status: "red", label: "Red", hint: "breaks within 30 days, or already broken", tone: "border-red-600" },
  { status: "yellow", label: "Yellow", hint: "affects you, deadline later or unstated", tone: "border-amber-500" },
  { status: "unknown", label: "Unknown", hint: "too many sources failing to tell", tone: "border-slate-400" },
  { status: "green", label: "Green", hint: "nothing open touches what you use", tone: "border-emerald-600" },
] as const;

export default function Overview() {
  const d = loadDashboard();
  const deadlines = upcomingDeadlines(d, DEADLINE_WINDOW_DAYS);
  const count = (s: string) => d.integrations.filter((i) => i.status.status === s).length;

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Integration health</h1>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        {d.integrations.length} integrations, checked daily against their providers&apos; changelogs, deprecation pages and status feeds.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        {COUNT_CARDS.map((c) => (
          <div key={c.status} className={`rounded-lg border-l-4 bg-white p-4 shadow-sm dark:bg-slate-900 ${c.tone}`}>
            <div className="text-3xl font-semibold tabular-nums">{count(c.status)}</div>
            <div className="text-sm font-medium">{c.label}</div>
            <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{c.hint}</div>
          </div>
        ))}
      </div>

      <section className="mt-8" aria-labelledby="deadlines">
        <h2 id="deadlines" className="mb-3 text-base font-semibold">
          Upcoming deadlines <span className="text-sm font-normal text-slate-500 dark:text-slate-400">next {DEADLINE_WINDOW_DAYS} days</span>
        </h2>
        {deadlines.length === 0 ? (
          <EmptyState>No deadlines in the next {DEADLINE_WINDOW_DAYS} days.</EmptyState>
        ) : (
          <ol className="flex gap-3 overflow-x-auto pb-2">
            {deadlines.map(({ integration, finding, days }) => (
              <li key={`${integration.manifest.slug}-${finding.id}`} className="min-w-56 shrink-0">
                <Link
                  href={`/integrations/${integration.manifest.slug}/#finding-${finding.id}`}
                  className={`block rounded-lg border bg-white p-3 shadow-sm hover:shadow dark:bg-slate-900 ${days <= 30 ? "border-red-300 dark:border-red-800" : "border-slate-200 dark:border-slate-800"}`}
                >
                  <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                    <time dateTime={finding.effectiveDate}>{finding.effectiveDate}</time> · {relativeDays(days)}
                  </div>
                  <div className="mt-1 font-semibold">{integration.manifest.name}</div>
                  <div className="mt-0.5 text-sm text-slate-700 dark:text-slate-300">
                    {CATEGORY_LABEL[finding.category]}: <Code>{finding.affects[0]}</Code>
                    {finding.affects.length > 1 && ` +${finding.affects.length - 1}`}
                  </div>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="mt-8" aria-labelledby="all">
        <h2 id="all" className="mb-3 text-base font-semibold">
          All integrations
        </h2>
        {/* Phones: one card per integration, same order as the table. */}
        <ul className="space-y-3 md:hidden">
          {d.integrations.map(({ manifest, status }) => (
            <li key={manifest.slug}>
              <Link
                href={`/integrations/${manifest.slug}/`}
                className="block rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-blue-700 dark:text-blue-400">{manifest.name}</span>
                  <StatusBadge status={status.status} />
                </div>
                <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">{status.reason}</p>
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  {status.nextDeadline ? `Next deadline ${status.nextDeadline} (${relativeDays(status.daysToDeadline ?? 0)}) · ` : ""}
                  checked {formatDateTime(status.lastChecked)}
                </p>
              </Link>
            </li>
          ))}
        </ul>
        <div className="hidden overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm md:block dark:border-slate-800 dark:bg-slate-900">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Integration</th>
                <th scope="col" className="px-4 py-2 font-medium">Status</th>
                <th scope="col" className="px-4 py-2 font-medium">Reason</th>
                <th scope="col" className="px-4 py-2 font-medium">Next deadline</th>
                <th scope="col" className="px-4 py-2 font-medium">Last checked</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {d.integrations.map(({ manifest, status }) => (
                <tr key={manifest.slug} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="px-4 py-3 font-medium">
                    <Link href={`/integrations/${manifest.slug}/`} className="text-blue-700 hover:underline dark:text-blue-400">
                      {manifest.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={status.status} />
                  </td>
                  <td className="px-4 py-3 text-slate-700 dark:text-slate-300">{status.reason}</td>
                  <td className="whitespace-nowrap px-4 py-3 tabular-nums">
                    {status.nextDeadline ? (
                      <>
                        {status.nextDeadline}{" "}
                        <span className={(status.daysToDeadline ?? 99) <= 30 ? "text-red-700 dark:text-red-300" : "text-slate-500 dark:text-slate-400"}>
                          ({relativeDays(status.daysToDeadline ?? 0)})
                        </span>
                      </>
                    ) : (
                      <span className="text-slate-400 dark:text-slate-500">none</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-500 tabular-nums dark:text-slate-400">
                    {formatDateTime(status.lastChecked)}
                    {status.sourcesFailed > 0 && (
                      <div className="text-xs text-amber-700 dark:text-amber-300">
                        {status.sourcesFailed} of {status.sourcesOk + status.sourcesFailed} sources failing
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
