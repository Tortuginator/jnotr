---
name: webcruiter-search
version: 1.0.0
description: >
  Use this skill to find jobs published on Webcruiter by Norwegian employers,
  especially the large Trondheim and Trøndelag employers (Trondheim kommune,
  St. Olavs hospital, Trøndelag fylkeskommune, NAV, Vy, NRK, Statnett, Tensio,
  OKEA and others in the employer registry). It reads every enabled
  Webcruiter employer in job_scraper/employers.csv and pools their public job
  lists. Trigger phrases: Webcruiter jobs, Webcruiter stillinger, jobber i
  Trondheim, ledige stillinger Trondheim, stillinger Trøndelag, offentlige
  jobber Norge, jobb i Trondheim kommune, jobb hos St. Olavs, jobb i
  Trøndelag fylkeskommune, norske jobber, søk jobb, jobs in Trondheim, Norway
  jobs, public sector jobs Norway, find a job in Trøndelag, look up this
  Webcruiter posting.
context: fork
enabled: true
allowed-tools: Bash(bun run .agents/skills/webcruiter-search/cli/src/cli.ts *)
---

# Webcruiter Search Skill

Read public Webcruiter job lists for the Trondheim employers in
`job_scraper/employers.csv` (`ats=webcruiter`). The skill calls the JSON
endpoint behind `candidate.webcruiter.com/.../companyadverts?companylock=<id>`,
normalises each result's `company` to the registry `name`, and pools the
employers. No authentication and **zero runtime dependencies**.

## ⚠️ Personal use only

Webcruiter's `robots.txt` disallows generic crawlers (`User-agent: * Disallow:
/`) on both `candidate.webcruiter.com` and the tenant hosts, while allowing
Googlebot and facebookexternalhit. This skill is for low-volume personal job
search. Keep request volume low, do not use it commercially or for bulk data
collection, and run it on your own responsibility. See `url-reference.md`.

## When to use this skill

- Find jobs from Trondheim kommune, St. Olavs hospital, Trøndelag
  fylkeskommune, NAV, Vy, NRK, Statnett and the other registry employers
- Filter by role, Trondheim commute area, or posting age
- Read one Webcruiter posting's full description

## Commands

```bash
bun run .agents/skills/webcruiter-search/cli/src/cli.ts search [flags]
bun run .agents/skills/webcruiter-search/cli/src/cli.ts detail <url|tenant:advertId> [--format json|plain]
```

### Search flags

| Flag | Alias | Description |
|------|-------|-------------|
| `--query` | `-q` | Keywords matched against title, company, category, location and description |
| `--location` | `-l` | `area` for the commute area in `job_scraper/area.json`, or a municipality/place/city. Omit for no filter |
| `--jobage` | | Keep postings published within N days (undated postings are dropped) |
| `--page` | | 1-indexed page of the pooled results (default 1) |
| `--limit` | | Page size and cap on emitted results (default 50) |
| `--format` | | `json` (default), `table`, `plain` |

Every enabled `ats=webcruiter` registry row is read. A row with a missing or
unrecognised `ats_ref` is reported in `meta.errors` as `{employer, error}` and
does not fail the run. Requests run at most four employers at a time.

### Detail

```bash
bun run .agents/skills/webcruiter-search/cli/src/cli.ts detail 7254:5198357738 --format plain
bun run .agents/skills/webcruiter-search/cli/src/cli.ts detail "https://7254.webcruiter.no/Main/Recruit/Public/5198357738" --format plain
```

Search results use `tenant:advertId` as their `id`. Detail also accepts the
posting URL (`OpenAdvertUrl`). A bare advert id is rejected because the public
URL needs a tenant host.

## Usage examples

```bash
# Everything in the Trondheim commute area
bun run .agents/skills/webcruiter-search/cli/src/cli.ts search -l area --limit 10 --format table

# Nursing roles in Trondheim, last two weeks
bun run .agents/skills/webcruiter-search/cli/src/cli.ts search -q sykepleier -l Trondheim --jobage 14 --format table

# Developer roles anywhere in the registry
bun run .agents/skills/webcruiter-search/cli/src/cli.ts search -q utvikler --format json

# Read one posting
bun run .agents/skills/webcruiter-search/cli/src/cli.ts detail 7254:5198357738 --format plain
```

## Output formats

| Format | Best for |
|--------|----------|
| `json` | Default - `{meta:{count,page,errors},results:[...]}`, programmatic use |
| `table` | Quick scanning of id, title, company, location and date |
| `plain` | Reading a single posting's description |

Each result always has `id`, `title`, `company`, `location`, `date` and `url`.
Missing values are `null`, never omitted. `date` is `YYYY-MM-DD` from
`PublishedDate`.

## Notes

- Location comes from `Workplace`/`Workplace2`/`Workplace3` and
  `WorkPlaceFacet3`, so `-l area` works for Trondheim kommune's many units.
- The registry name is used verbatim as `company` (for example `TRONDHEIM
  KOMMUNE`), which keeps cross-source deduplication stable.
- `--location area` reads `job_scraper/area.json`; if it is missing, the CLI
  exits 1 with a JSON error rather than silently returning everything.
- `--jobage` is applied client-side to the posting date. Undated postings are
  dropped when the filter is set.
- Webcruiter paginates the companysearch endpoint with `take`, `skip`, `page`
  and `pageSize`; the skill fetches up to 200 postings per employer.
