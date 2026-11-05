# API Integration Health Monitor

Watches each integration's public provider sources (changelogs, deprecation pages,
status feeds) and flags only the changes that touch what that integration actually
uses. See [BRIEF.md](BRIEF.md) for the full spec. The full README comes in build step 8.

**Live dashboard:** https://chayan171999.github.io/API-Integration-health-monitor/

**Status:** build steps 1–4 of 8 are done: the monitor (fetching, diffing, link checks,
rule-based classifier, dedupe and status scoring for GitHub, Slack and Stripe), the
dashboard (overview and per-integration detail pages), and the daily job. No API keys
needed.

## Daily job

[.github/workflows/monitor.yml](.github/workflows/monitor.yml) runs at 06:17 UTC, or
on demand from *Actions → Daily monitor → Run workflow*. It runs the monitor, validates
`/data`, commits with the built-in `GITHUB_TOKEN` (for example
`monitor: 2026-11-05: 1 red, 2 yellow, 7 green`), then redeploys the dashboard. A
failing source doesn't fail the job; it shows up as source health.

The job commits to `main` every day, so run `git pull` before working locally.

## Dashboard

A Next.js static export built from `/data`. Plain HTML, no server, no secrets.

```bash
npm run dev      # http://localhost:3000, reads /data live
npm run build    # static site in out/
DASHBOARD_DATA_DIR=path/to/other/data npm run build   # render a different dataset
```

- `/` shows counts by status, deadlines in the next 60 days, and every integration
  sorted red → yellow → unknown → green, then by days to deadline.
- `/integrations/<slug>/` shows status and reason, open findings with excerpt, source
  link, affects, dates, confidence, matched terms and next action. It also shows what
  the integration uses, source health, doc-link health, upgrade notes, info findings
  (collapsed) and closed findings.

**Deploy to GitHub Pages:** push the repo to GitHub, then in *Settings → Pages* set
*Source* to **GitHub Actions**. [.github/workflows/pages.yml](.github/workflows/pages.yml)
builds and deploys on every push that changes `data/`, `app/` or `lib/`. It sets the
`/<repo>` base path automatically.

**Or Vercel Hobby:** import the repo. Vercel detects Next.js; the static export lands
in `out/`.

## Run it

Requires Node ≥ 22.18, which runs `.ts` files directly. There is no build step.

```bash
npm install
npm run monitor                        # collect -> diff -> link check -> classify -> dedupe -> score
npm run monitor -- --only slack        # one or more integrations (status is rescored for all)
npm run monitor -- --reclassify        # classify all current content, not just what changed
npm run monitor -- --today 2026-11-05  # pin "today"
npm test                               # unit tests: status rules, classifier, diff, dedupe, links, robots
npm run validate                       # check every JSON file in /data against lib/schema.ts
npm run typecheck
```

`MONITOR_DEBUG=1` logs every HTTP request with its duration.

## How a change becomes a flag

1. **Collect.** Fetch each source politely: robots.txt, generic User-Agent, 20 s hard
   timeout, one retry, 1 s between requests to the same host.
2. **Diff.** Feeds compare item IDs and hashes. Pages compare per-entry hashes, where an
   entry is one top-level list item or one paragraph, under its heading. Only new
   entries go on. GitHub's feed holds one-sentence teasers, so new items get the linked
   post's text.
3. **Link check.** GET every `docLinks` URL. A 404/410, or a redirect to a generic page,
   becomes a `broken_doc_link`. A redirect to another specific page is recorded as
   "moved" but not flagged.
4. **Classify** ([monitor/rules.ts](monitor/rules.ts), [monitor/classify.ts](monitor/classify.ts)).
   A finding needs a category pattern (deprecation, removal, scope, auth, version
   sunset, rate limit, webhook). It changes status only if the same entry also
   mentions something in the manifest's `uses`. Dates count as deadlines only after
   a trigger word ("on", "by", "effective"…). `matchedTerms` records every pattern,
   match and date that fired.
5. **Dedupe.** The same entry seen again updates its finding and keeps human decisions.
   The same announcement on a second source is added to `alsoSeenIn`.
6. **Score** ([monitor/score.ts](monitor/score.ts)). BRIEF section 7, as pure functions.

### Decisions beyond the brief

- **Version-scoped changes are info.** An entry listed under an API version newer
  than the pinned one (GitHub "Version 2026-03-10", Stripe "2026-09-30.endive") only
  matters on upgrade. It shows as an upgrade note and never changes status.
- **The first run doesn't flag history.** With no previous snapshot, entries whose
  newest date is more than 180 days old are skipped unless their deadline is still
  ahead. Undated page sections take the date of the nearest dated section above them.
- **Incidents use status components.** `uses.statusComponents`, case-sensitive and
  as written on the status page, decides whether an incident is relevant. Incidents
  close themselves when the status page says resolved. Changelog findings never
  auto-close.
- **Acknowledged findings** don't drive status, but still count toward the next
  deadline.

## Layout

```
lib/schema.ts               Zod schemas for every JSON file
data/integrations/*.json    hand-written manifests: what each integration uses + sources to watch
data/snapshots/<slug>/      last fetched state per source (item IDs / text blocks + hashes)
data/findings/<slug>.json   findings; edit status/dismissReason by commit to acknowledge or dismiss
data/links/<slug>.json      latest doc-link check
data/status.json            computed status per integration (never hand-edited)
monitor/run.ts              pipeline entrypoint
monitor/collect.ts          one source -> snapshot; failures keep the previous content
monitor/extract.ts          feed -> items, HTML -> heading-scoped blocks -> entries
monitor/diff.ts             new/changed entries -> classification candidates; teaser enrichment
monitor/rules.ts            every pattern the classifier uses, in one file
monitor/match.ts            manifest relevance: exact vs fuzzy matching
monitor/dates.ts            date extraction (chrono-node) with trigger words
monitor/classify.ts         candidate -> finding, with template summary/action
monitor/dedupe.ts           merge new findings into existing ones
monitor/links.ts            doc-link check
monitor/score.ts            severity + status rules
monitor/http.ts             polite GET with robots.txt and a hard timeout
test/                       node:test unit tests
```
