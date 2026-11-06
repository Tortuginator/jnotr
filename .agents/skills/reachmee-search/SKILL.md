---
name: reachmee-search
version: 1.0.0
description: >
  Use this skill to find jobs published on ReachMee by Norwegian and Nordic
  employers, especially the Trondheim/Trøndelag employers in the registry
  (Asplan Viak, Sweco Norge, Bravida Norge, ScaleAQ, Bouvet, NINA, Møller,
  TOBB and others). It reads every enabled ReachMee employer in
  job_scraper/employers.csv through either a legacy
  webNNN.reachmee.com/ext/... list (with a validator) or an
  <slug>.attract.reachmee.com career site. Trigger phrases: ReachMee jobs,
  ReachMee stillinger, jobber i Trondheim, ledige stillinger Trondheim,
  stillinger Trøndelag, jobb hos Asplan Viak, jobb hos Sweco, jobb i Bravida,
  jobb i ScaleAQ, jobb hos Bouvet, jobb i NINA, norske jobber, søk jobb, jobs
  in Trondheim, Norway jobs, engineering jobs Norway, consultancy jobs
  Trondheim, find a job in Trøndelag, look up this ReachMee posting.
context: fork
enabled: true
allowed-tools: Bash(bun run .agents/skills/reachmee-search/cli/src/cli.ts *)
---

# ReachMee Search Skill

Read public ReachMee job lists for the Trondheim employers in
`job_scraper/employers.csv` (`ats=reachmee`). ReachMee exposes two public
shapes, and the skill handles both:

1. **Legacy ext lists** — `https://webNNN.reachmee.com/ext/<I-code>/<customer>/main`
   with a per-customer `validator` query parameter.
2. **Attract career sites** — `https://<slug>.attract.reachmee.com/jobs`,
   server-rendered and validator-free.

No authentication and **zero runtime dependencies**.

## ⚠️ Personal use only

Keep request volume low. The skill discovers a validator or Attract site for
employers whose seeded `ats_ref` is incomplete, which costs a few extra
requests per run. Do not use it commercially or for bulk data collection; run
it on your own responsibility. See `url-reference.md` for the verified
patterns and the stale seed URLs.

## When to use this skill

- Find jobs from Asplan Viak, Sweco, Bravida, ScaleAQ, Bouvet, NINA and the
  other `ats=reachmee` registry employers
- Filter by role, Trondheim commute area, or posting age where the list has a
  published date
- Read one ReachMee posting's full description

## Commands

```bash
bun run .agents/skills/reachmee-search/cli/src/cli.ts search [flags]
bun run .agents/skills/reachmee-search/cli/src/cli.ts detail <posting-url> [--format json|plain]
```

### Search flags

| Flag | Alias | Description |
|------|-------|-------------|
| `--query` | `-q` | Keywords matched against title, company and list text |
| `--location` | `-l` | `area` for the commute area in `job_scraper/area.json`, or a municipality/place/city. Omit for no filter |
| `--jobage` | | Keep postings with a published date within N days |
| `--location-detail-limit <n>` | | When `--location` is set and a list row has no location, fetch up to N detail pages to find one (default 200) |
| `--page` | | 1-indexed page of the pooled results (default 1) |
| `--limit` | | Page size and cap on emitted results (default 50) |
| `--format` | | `json` (default), `table`, `plain` |

Every enabled `ats=reachmee` registry row is read. If a row has no usable list
(the seeded URL is stale and no validator/Attract site can be found), the skill
records `{employer, error}` in `meta.errors` instead of silently returning
nothing. Requests run at most four employers at a time.

### Detail

```bash
bun run .agents/skills/reachmee-search/cli/src/cli.ts detail "https://web103.reachmee.com/ext/I010/2581/job?site=6&lang=NO&validator=...&job_id=215" --format plain
bun run .agents/skills/reachmee-search/cli/src/cli.ts detail "https://sweco.attract.reachmee.com/jobs/25705-ai-och-jarnvag" --format plain
```

ReachMee detail needs the tenant/site/validator context encoded in the posting
URL. Search results therefore use the full posting URL as their `id`, so the
`id` field can be passed straight to `detail`. A bare `job_id` is rejected.

## Usage examples

```bash
# All ReachMee jobs in the registry
bun run .agents/skills/reachmee-search/cli/src/cli.ts search --limit 10 --format table

# Summer/student roles in the Trondheim area
bun run .agents/skills/reachmee-search/cli/src/cli.ts search -q sommerjobb -l area --format table

# Engineering roles at any ReachMee employer
bun run .agents/skills/reachmee-search/cli/src/cli.ts search -q ingeniør --format json

# Read one posting
bun run .agents/skills/reachmee-search/cli/src/cli.ts detail "https://web103.reachmee.com/ext/I010/2581/job?site=6&lang=NO&validator=...&job_id=215" --format plain
```

## Output formats

| Format | Best for |
|--------|----------|
| `json` | Default - `{meta:{count,page,errors},results:[...]}`, programmatic use |
| `table` | Quick scanning of a short job id, title, company, location and date |
| `plain` | Reading a single posting's description |

Each result always has `id`, `title`, `company`, `location`, `date` and `url`.
Missing values are `null`, never omitted.

## Notes

- **Location fallback.** Legacy ext lists often have a `Sted`/`Ort` column and
  those values are used. Some Attract lists have no location column at all
  (Sweco's Trainee site is one). With `--location`, rows whose list entry has no
  location are resolved from the posting's detail page (up to
  `--location-detail-limit`, default 200) before the filter is applied; if more rows than the cap lack a location, `meta.warning` reports the number not checked. Without
  `--location`, those rows keep `location: null`.
- **Date fallback.** ReachMee lists commonly expose only a deadline
  (`Søknadsfrist` / `Sista ansökningsdag`), not a posting date. `date` is
  `null` in that case, and `--jobage` drops undated results. When a list has a
  `Publicerad` / `Published` / `Publisert` column, that date is used.
- `--location area` reads `job_scraper/area.json`; if it is missing, the CLI
  exits 1 with a JSON error rather than silently returning everything.
- The registry `name` is used verbatim as `company`, which keeps cross-source
  deduplication stable.
- The seed `ats_ref` values `https://web103.reachmee.com/ext/I003/475` and
  similar were stale on 6 Nov 2026 (404 without a validator). The skill tries
  the employer's Attract site, then its `career_url`, and reports a clear error
  when neither yields a usable list.
