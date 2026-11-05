import type { Category, Finding, IntegrationStatus, Severity } from "../lib/schema.ts";
import { daysBetween } from "./lib/data.ts";

type Status = IntegrationStatus["status"];

const STATUS_STYLE: Record<Status, { dot: string; chip: string; label: string }> = {
  red: { dot: "bg-red-600", chip: "bg-red-50 text-red-800 ring-red-600/20 dark:bg-red-950/60 dark:text-red-200 dark:ring-red-400/30", label: "Red" },
  yellow: { dot: "bg-amber-500", chip: "bg-amber-50 text-amber-900 ring-amber-600/25 dark:bg-amber-950/60 dark:text-amber-200 dark:ring-amber-400/30", label: "Yellow" },
  unknown: { dot: "bg-slate-400", chip: "bg-slate-100 text-slate-700 ring-slate-500/20 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-400/30", label: "Unknown" },
  green: { dot: "bg-emerald-600", chip: "bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-950/60 dark:text-emerald-200 dark:ring-emerald-400/30", label: "Green" },
};

export function StatusBadge({ status }: { status: Status }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${s.chip}`}>
      <span aria-hidden className={`size-2 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

const SEVERITY_AS_STATUS: Record<Severity, Status> = { red: "red", yellow: "yellow", info: "unknown" };

export function SeverityBadge({ severity }: { severity: Severity }) {
  if (severity === "info") {
    return (
      <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600 ring-1 ring-inset ring-slate-500/20 dark:bg-slate-800 dark:text-slate-300">
        Info
      </span>
    );
  }
  return <StatusBadge status={SEVERITY_AS_STATUS[severity]} />;
}

export const CATEGORY_LABEL: Record<Category, string> = {
  endpoint_deprecated: "Deprecation",
  endpoint_removed: "Removal",
  scope_changed: "Scope change",
  auth_change: "Auth change",
  version_sunset: "Version sunset",
  rate_limit_change: "Rate-limit change",
  webhook_change: "Webhook change",
  broken_doc_link: "Broken doc link",
  provider_incident: "Provider incident",
  other: "Other",
};

export function relativeDays(days: number): string {
  if (days === 0) return "today";
  if (days < 0) return `${-days} day${days === -1 ? "" : "s"} ago`;
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

export function DeadlineText({ date, today }: { date?: string; today: string }) {
  if (!date) return <span className="text-slate-400 dark:text-slate-500">none stated</span>;
  const days = daysBetween(today, date);
  const urgent = days <= 30;
  return (
    <span className="whitespace-nowrap">
      <time dateTime={date} className="font-medium tabular-nums">
        {date}
      </time>{" "}
      <span className={urgent ? "text-red-700 dark:text-red-300" : "text-slate-500 dark:text-slate-400"}>({relativeDays(days)})</span>
    </span>
  );
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (d.getTime() === 0) return "never";
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[0.8em] text-slate-800 dark:bg-slate-800 dark:text-slate-200">
      {children}
    </code>
  );
}

/** Template text marks identifiers with `backticks`; render those as code. */
export function RichText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, i) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 2 ? <Code key={i}>{part.slice(1, -1)}</Code> : part,
      )}
    </>
  );
}

export function Section({ title, count, children, id }: { title: string; count?: number; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} className="mt-10">
      <h2 className="mb-3 flex items-baseline gap-2 text-base font-semibold text-slate-900 dark:text-slate-100">
        {title}
        {count !== undefined && <span className="text-sm font-normal text-slate-500 dark:text-slate-400">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function FindingCard({ f, today }: { f: Finding; today: string }) {
  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <header className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={f.severity} />
        <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{CATEGORY_LABEL[f.category]}</span>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {f.confidence} confidence · {f.classifiedBy === "ai" ? "AI-classified" : "rules"}
        </span>
        {f.status !== "open" && (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">{f.status}</span>
        )}
      </header>

      <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
        <RichText text={f.summary} />
      </p>

      <blockquote className="mt-3 border-l-4 border-slate-300 pl-3 text-sm italic text-slate-600 dark:border-slate-600 dark:text-slate-400">
        “{f.excerpt}”
        <a href={f.sourceUrl} className="ml-2 whitespace-nowrap not-italic text-blue-700 underline-offset-2 hover:underline dark:text-blue-400" target="_blank" rel="noreferrer">
          {hostOf(f.sourceUrl)} ↗
        </a>
      </blockquote>

      {f.severity !== "info" && (
        <p className="mt-3 rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:bg-blue-950/50 dark:text-blue-200">
          <span className="font-semibold">Next action: </span>
          <RichText text={f.suggestedAction} />
        </p>
      )}

      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        {f.affects.length > 0 && (
          <>
            <dt className="text-slate-500 dark:text-slate-400">Affects</dt>
            <dd className="flex flex-wrap gap-1">
              {f.affects.map((a) => (
                <Code key={a}>{a}</Code>
              ))}
            </dd>
          </>
        )}
        <dt className="text-slate-500 dark:text-slate-400">Effective</dt>
        <dd>
          <DeadlineText date={f.effectiveDate} today={today} />
        </dd>
        {f.appliesToVersion && (
          <>
            <dt className="text-slate-500 dark:text-slate-400">API version</dt>
            <dd>
              <Code>{f.appliesToVersion}</Code> <span className="text-slate-500">(upgrade only)</span>
            </dd>
          </>
        )}
        <dt className="text-slate-500 dark:text-slate-400">Dates</dt>
        <dd className="text-slate-700 dark:text-slate-300">
          detected {f.detectedAt}
          {f.publishedAt && ` · published ${f.publishedAt}`}
          {f.lastSeenAt && f.lastSeenAt !== f.detectedAt && ` · last seen ${f.lastSeenAt}`}
        </dd>
        <dt className="text-slate-500 dark:text-slate-400">Source</dt>
        <dd className="text-slate-700 dark:text-slate-300">
          <Code>{f.sourceId}</Code>
          {f.alsoSeenIn?.map((s) => (
            <span key={s.sourceId}>
              {" "}
              · also in{" "}
              <a href={s.sourceUrl} className="text-blue-700 hover:underline dark:text-blue-400" target="_blank" rel="noreferrer">
                {s.sourceId}
              </a>
            </span>
          ))}
        </dd>
        {f.dismissReason && (
          <>
            <dt className="text-slate-500 dark:text-slate-400">Dismissed</dt>
            <dd className="text-slate-700 dark:text-slate-300">{f.dismissReason}</dd>
          </>
        )}
      </dl>

      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200">
          Why it was flagged ({f.matchedTerms.length} matched terms) · id <span className="font-mono">{f.id}</span>
        </summary>
        <ul className="mt-2 space-y-1">
          {f.matchedTerms.map((t) => (
            <li key={t}>
              <Code>{t}</Code>
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
      {children}
    </p>
  );
}
