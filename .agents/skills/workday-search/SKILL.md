---
name: workday-search
version: 1.0.0
description: >
  Use this skill to search jobs published on Workday career sites, especially
  Norwegian employers in Trondheim and the Trondheim commute area (Malvik,
  Melhus, Skaun, Stjørdal). Workday powers the public career sites of Equinor,
  Norconsult, ASKO Midt-Norge, NG Meny and If, and many other large employers.
  Invoke for open positions, vacancies, stillinger, ledige stillinger, jobb i
  Trondheim, jobb i Norge, jobsøkning, søk jobb, sommerjobb, nyutdannet,
  ingeniør, sivilingeniør, utvikler, data scientist, prosjektleder, butikkmedarbeider,
  lager, logistikk, forsikring or any role advertised on a Workday career site.
  Also use to search Workday jobs in Norway, read a Workday posting URL, or look
  up a specific Workday job. Triggers in English: Workday job search, Equinor
  careers, Norconsult careers, ASKO jobs, Meny jobs, If careers, engineering jobs
  Trondheim, Norway jobs, find a job in Trondheim.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run .agents/skills/workday-search/cli/src/cli.ts *)
---

# Workday Search Skill

Search jobs from the public Workday career sites of every `ats=workday` employer
in the local registry. No authentication, no API key, and **zero runtime
dependencies** — it runs with just `bun`.

Workday hosts career sites for large Norwegian employers. This skill reads the
same JSON API the public career site calls
(`/wday/cxs/<tenant>/<site>/jobs`), so it covers every Workday employer in the
registry with one connector.

## When to use this skill

- Search for jobs at Trondheim-area employers on Workday career sites
- Filter by role keywords (Norwegian or English), posting age, or commute area
- Read the full description of a specific Workday posting

## Setup: employer registry

The skill reads enabled rows with `ats=workday` from
`job_scraper/employers.csv`, falling back to
`trondheim-patches/employers.seed.csv`. Each row supplies:

- `name` — used as the result `company` (so cross-source dedup compares like with like)
- `ats_ref` — the public career-site URL, e.g.
  `https://norconsult.wd3.myworkdayjobs.com/Norconsult_Career_Site`
- `enabled` — false rows are skipped

Rows with `ats=workday` but an empty or invalid `ats_ref` are skipped and listed
in `meta.errors`; a tenant or site is never guessed.

## Commands

### Search job listings

```bash
bun run .agents/skills/workday-search/cli/src/cli.ts search [flags]
```

Key flags:
- `--query <text>` / `-q <text>` — sent to Workday as `searchText`.
- `--location <text>` / `-l <text>` — `area` for the Trondheim commute area
  (`job_scraper/area.json`), a place such as `Trondheim`, `Heimdal` or `Stjørdal`,
  or omit for all locations.
- `--jobage <days>` — posted within N days, parsed from Workday's relative
  `postedOn` label.
- `--page <n>` — 1-indexed; `offset = (page - 1) * limit`.
- `--limit <n>` / `-n <n>` — Workday page size and cap on emitted results (max 100).
- `--location-detail-limit <n>` — max ambiguous postings whose detail is fetched
  to verify a location. Default 20.
- `--format json|table|plain` — default `json`.

`meta.errors` lists registry rows that could not be used and sites that failed;
one failing site does not fail the run. `meta.count` is the number of results
emitted.

### Fetch full job detail

```bash
bun run .agents/skills/workday-search/cli/src/cli.ts detail <id|url> [--format json|plain]
```

Pass the posting `url` from a search result (best). Also accepted: a
`<tenant>/<site>/job/...` id, or a bare `/job/...` path when the registry has
exactly one Workday site. The detail JSON is read from
`/wday/cxs/<tenant>/<site><externalPath>`.

## Usage examples

```bash
# Any Trondheim-area job, readable table
bun run .agents/skills/workday-search/cli/src/cli.ts search -l area --limit 10 --format table

# Summer internships in the commute area
bun run .agents/skills/workday-search/cli/src/cli.ts search -q sommerstudent -l area --format json

# Data roles in Trondheim posted in the last 14 days
bun run .agents/skills/workday-search/cli/src/cli.ts search -q data -l Trondheim --jobage 14 --format table

# Norwegian-language query for engineers
bun run .agents/skills/workday-search/cli/src/cli.ts search -q "ingeniør" -l area --format table

# Full detail for one posting (URL preferred)
bun run .agents/skills/workday-search/cli/src/cli.ts detail "https://norconsult.wd3.myworkdayjobs.com/Norconsult_Career_Site/job/Trondheim/Sommerjobb-2027---Dam-og-vassdrag_REQ-6486" --format plain
```

## Output formats

| Format | Best for |
|--------|----------|
| `json` | Default — `{ meta, results }`, each result has `id`, `title`, `company`, `location`, `date`, `url` (nulls included) |
| `table` | Quick human-readable scanning |
| `plain` | Reading a single posting's full detail |

All errors are written to **stderr** as `{ "error": "...", "code": "..." }` and the
process exits with code `1`.

## Notes

- Data comes from the unauthenticated JSON API behind each public Workday career
  site. No credentials are required. Check `robots.txt` and the site terms before
  bulk use; keep volume low.
- `ats_ref` parsing: origin = URL origin, tenant = first host label, site = first
  non-locale path segment before `/job/`. `no-NO`/`en-US` prefixes are skipped.
- `meta.errors` never aborts the run: a broken registry row or a failing tenant
  is reported, and the remaining sites still return results.
- Workday search results expose only `postedOn` (a relative label such as
  "Posted 2 Days Ago"), not a timestamp; `date` is that label converted to
  `YYYY-MM-DD`. Unknown labels become `null`, and `--jobage` does not drop
  postings whose date cannot be parsed.
- Location facets are query-scoped on some tenants; the CLI probes facets with an
  empty `searchText` and then applies the ids to the real query.
- NorgesGruppen exposes its location facet as `locationHierarchy1`
  (municipality) rather than `locations`; the API rejects the same ids under
  `locations` with HTTP 400. The CLI uses the facet's own parameter as the
  `appliedFacets` key, so `-l area` still finds the MENY Trondheim posting.
  If a tenant rejects the facet body, it falls back to matching `locationsText`
  and verifies ambiguous labels such as `"4 Locations"` via the detail endpoint.
- Equinor labels its Trondheim office `Rotvoll, Norway`; that is a Trondheim
  district in `job_scraper/area.json`, so `-l area` finds those jobs.
- If's postings often say `Nordic` with additional locations; only a detail
  fetch can confirm whether Trondheim is among them.
- ASKO and NG Meny share NorgesGruppen's Workday site. Search results are
  attributed by brand token when possible (ASKO / MENY). Postings for another
  group brand (SPAR, Joker, KIWI) keep that brand as `company` rather than being
  falsely attributed to a registry row.
