---
name: vismatalent-search
version: 1.0.0
description: >
  Use this skill to find jobs published on Visma Talent career sites
  (hire.vismatalent.com) by Norwegian employers, especially Nortura SA and the
  employers Visma is migrating from Webcruiter to Visma Talent. It reads every
  enabled Visma Talent employer in job_scraper/employers.csv and pools their
  public job lists, with Trondheim/Norway location filtering through
  job_scraper/area.json. Trigger phrases: Visma Talent jobs, Visma Talent
  stillinger, hire.vismatalent.com, Nortura jobs, Nortura stillinger, jobber i
  Nortura, Norwegian employer career sites, stillinger Norge, ledige stillinger
  Norge, jobber i Trondheim, ledige stillinger Trondheim, jobb i Trondheim,
  jobb i Norge, søk jobb, norske jobber, Webcruiter migration, Webcruiter til
  Visma Talent, jobs in Norway, jobs in Trondheim, Norwegian jobs, find a job
  in Norway, Norwegian employer jobs, look up this Visma Talent posting.
context: fork
enabled: true
allowed-tools: Bash(bun run .agents/skills/vismatalent-search/cli/src/cli.ts *)
---

# Visma Talent Search Skill

Read public Visma Talent job lists for the Norwegian employers in
`job_scraper/employers.csv` (`ats=vismatalent`). The skill calls the public JSON
API behind each employer's career site, normalises each result's `company` to
the registry `name`, and pools the employers. No authentication and **zero
runtime dependencies**.

Visma Talent is the platform Visma is migrating Webcruiter customers onto, so
this connector is expected to grow as more Norwegian employers move across.

## ⚠️ Personal use only

`https://hire.vismatalent.com/robots.txt` returns `User-agent: *` /
`Disallow: /`, with `Allow` rules only for the public apply pages, one legacy
assignment page and the media bank. The public JSON endpoints used here are
therefore inside a disallowed path. This skill is for low-volume personal job
search: keep request volume low, do not use it commercially or for bulk data
collection, and run it on your own responsibility. Review the current
robots.txt and Visma's terms before running it. See `url-reference.md`.

## When to use this skill

- Find jobs from Nortura SA and other registry employers on Visma Talent
- Filter by role, Trondheim commute area, or posting age
- Read one Visma Talent posting's full description
- Check whether a Webcruiter employer has moved to Visma Talent

## Commands

```bash
bun run .agents/skills/vismatalent-search/cli/src/cli.ts search [flags]
bun run .agents/skills/vismatalent-search/cli/src/cli.ts detail <siteGuid:jobGuid|jobGuid|url> [--format json|plain]
```

### Search flags

| Flag | Alias | Description |
|------|-------|-------------|
| `--query` | `-q` | Keywords matched case-insensitively against title and description |
| `--location` | `-l` | `area` for the commute area in `job_scraper/area.json`, or a municipality/county/country/place. Omit for no filter |
| `--jobage` | | Keep postings published within N days (undated postings are dropped) |
| `--page` | | 1-indexed page of the pooled results (default 1) |
| `--limit` | | Page size and cap on emitted results (default 50) |
| `--format` | | `json` (default), `table`, `plain` |

Every enabled `ats=vismatalent` registry row is read. A row with a missing or
unparseable `ats_ref` is reported in `meta.errors` as `{employer, error}` and
does not fail the run. Requests run at most four employers at a time.

### Detail

```bash
bun run .agents/skills/vismatalent-search/cli/src/cli.ts detail 0ceb6ff0-777f-4216-93b6-be2d4ae34a16:821f710e-4079-45b1-a3b1-27b410df725d --format plain
bun run .agents/skills/vismatalent-search/cli/src/cli.ts detail 821f710e-4079-45b1-a3b1-27b410df725d --format plain
bun run .agents/skills/vismatalent-search/cli/src/cli.ts detail "https://hire.vismatalent.com/Public/Assignment.aspx?guidAssignment=821f710e-4079-45b1-a3b1-27b410df725d&language=nb" --format plain
```

Search results use `<siteGuid>:<jobGuid>` as their `id`. Detail accepts:

- `<siteGuid>:<jobGuid>` — unambiguous and cheapest
- a bare job GUID — resolved across registry career sites; an error if the GUID
  appears on more than one site
- a URL containing `guidAssignment`, optionally with a `siteGuid` query
  parameter or a `/careers/<siteGuid>` path segment

Detail fetches `GetJobList` for the resolved site, finds the job GUID in that
list, and reads the description from `Assignment.Description` (the list already
contains the full HTML). A 404, an empty list or a missing GUID returns
`NOT_FOUND` with exit code 1.

## Usage examples

```bash
# Everything in the Trondheim commute area
bun run .agents/skills/vismatalent-search/cli/src/cli.ts search -l area --limit 10 --format table

# All current Nortura jobs
bun run .agents/skills/vismatalent-search/cli/src/cli.ts search --limit 10 --format json

# Kitchen or food-production roles in Stavanger, last two weeks
bun run .agents/skills/vismatalent-search/cli/src/cli.ts search -q kokk -l Stavanger --jobage 14 --format table

# Developer roles anywhere in the registry
bun run .agents/skills/vismatalent-search/cli/src/cli.ts search -q utvikler --format json

# Read one posting
bun run .agents/skills/vismatalent-search/cli/src/cli.ts detail 0ceb6ff0-777f-4216-93b6-be2d4ae34a16:821f710e-4079-45b1-a3b1-27b410df725d --format plain
```

## Output formats

| Format | Best for |
|--------|----------|
| `json` | Default - `{meta:{count,page,errors},results:[...]}`, programmatic use |
| `table` | Quick scanning of id, title, company, location and date |
| `plain` | Reading a single posting's description |

Each search result always has `id`, `title`, `company`, `location`, `date` and
`url`. Missing values are `null`, never omitted. `date` is `YYYY-MM-DD` from
`PublishStartDate`.

Detail JSON adds `description`, `employmentType`, `department`, `published`,
`endDate` and `refNo`.

## Notes

- `ats_ref` may be a full career URL
  (`https://hire.vismatalent.com/spa/nb/public/careers/<siteGuid>`) or a bare
  site GUID; the CLI takes the last path segment when it is a GUID.
- `location` uses `Assignment.Municipality.Name`, falling back to
  `County.Name` then `Country.Name`. Location matching also uses those fields,
  `LocName` and the department name, so `-l area` works for registry employers
  with units in the Trondheim area.
- `LocName` observed live is `nb-NO` (the language), not a place, so it is not
  used as the display location.
- `-l area` reads `job_scraper/area.json`; if it is missing, the CLI exits 1
  with a JSON error rather than silently returning everything.
- `--jobage` is applied client-side to `PublishStartDate`. Undated postings are
  dropped when the filter is set.
- The parser tolerates extra fields and a missing `Assignment` object; a job
  without `Guid` is skipped.
- If no registry file exists, search exits 1 with code `NO_REGISTRY`.
