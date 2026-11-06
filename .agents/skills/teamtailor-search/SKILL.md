---
name: teamtailor-search
version: 1.0.0
description: >
  Use this skill to search jobs published on Teamtailor career sites, especially
  Norwegian employers in Trondheim and the Trondheim commute area (Malvik, Melhus,
  Skaun, Stjørdal). Teamtailor powers the public career pages of many Norwegian
  companies, including HENT, Nordic Semiconductor, Veidekke, Skatteetaten, BDO,
  Aker BP, Securitas and Kriminalomsorgen. Invoke for open positions, vacancies,
  stillinger, ledige stillinger, jobsøkning, jobb i Trondheim, jobb i Norge,
  engineering, prosjektleder, utvikler, ingeniør, sivilingeniør, data, software,
  construction, project manager or any role advertised on a Teamtailor career
  site. Also use to look up a specific Teamtailor posting URL.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run .agents/skills/teamtailor-search/cli/src/cli.ts *)
---

# Teamtailor Search Skill

Search jobs from the public Teamtailor RSS feeds of every employer in the local
registry. No authentication, no API key, and **zero runtime dependencies** — it
runs with just `bun`.

Teamtailor is the recruitment system behind many Norwegian career sites. This
skill reads their documented public feed (`<site>/jobs.rss`) rather than scraping
HTML, so it covers every Teamtailor employer in the registry with one connector.

## When to use this skill

- Search for jobs at Trondheim-area employers across Teamtailor career sites
- Filter by role keywords (Norwegian or English), posting age, or commute area
- Read the full description of a specific Teamtailor posting

## Setup: employer registry

The skill reads enabled rows with `ats=teamtailor` from
`job_scraper/employers.csv`, falling back to
`trondheim-patches/employers.seed.csv`. Each row supplies:

- `name` — used as the result `company` (so cross-source dedup compares like with like)
- `ats_ref` — the Teamtailor RSS URL, e.g. `https://hent.teamtailor.com/jobs.rss`
- `enabled` — false rows are skipped

Rows with `ats=teamtailor` but an empty `ats_ref` are skipped and listed in
`meta.errors`; a feed slug is never guessed.

## Commands

### Search job listings

```bash
bun run .agents/skills/teamtailor-search/cli/src/cli.ts search [flags]
```

Key flags:
- `--query <text>` / `-q <text>` — case-insensitive match on title + description.
- `--location <text>` / `-l <text>` — `area` for the Trondheim commute area
  (`job_scraper/area.json`), a place such as `Trondheim`, `Heimdal` or `Oslo`
  (matches location name or city), or omit for all locations.
- `--jobage <days>` — posted within N days, from the RSS `pubDate`.
- `--page <n>` — feed pages read per employer (100 items/page). Default 1.
- `--limit <n>` / `-n <n>` — cap results emitted after filtering.
- `--format json|table|plain` — default `json`.

`meta.errors` lists registry rows that could not be used and feeds that failed;
one failing feed does not fail the run. `meta.count` is the number of results
emitted.

### Fetch full job detail

```bash
bun run .agents/skills/teamtailor-search/cli/src/cli.ts detail <id|url> [--format json|plain]
```

Pass the posting `url` from a search result. Bare ids are only usable when the
registry has exactly one Teamtailor employer; otherwise the CLI exits with
`AMBIGUOUS_ID`. The posting page is parsed from its JSON-LD `JobPosting` data.

## Usage examples

```bash
# Any Trondheim-area job, readable table
bun run .agents/skills/teamtailor-search/cli/src/cli.ts search -l area --limit 10 --format table

# Engineering roles in the commute area, last 30 days
bun run .agents/skills/teamtailor-search/cli/src/cli.ts search -q engineer -l area --jobage 30 --format table

# Norwegian-language query
bun run .agents/skills/teamtailor-search/cli/src/cli.ts search -q "prosjektleder" -l Trondheim --format table

# Jobs in Heimdal specifically
bun run .agents/skills/teamtailor-search/cli/src/cli.ts search -l Heimdal --format table

# Full detail for one posting (URL preferred)
bun run .agents/skills/teamtailor-search/cli/src/cli.ts detail "https://karriere.hent.no/jobs/8630421-anleggsleder-betong" --format plain
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

- Data comes from Teamtailor's public RSS feed; no credentials are required.
- Feeds are paginated with `offset`/`per_page` (maximum 100 per page). At most four
  feeds are fetched concurrently.
- `--page` controls how many feed pages are read per employer; it is not a slice
  of the pooled result set. Use `--limit` to cap output.
- `tt:name` is the posting's location label and may differ from `tt:city` (for
  example `Trondheim` / `Heimdal`); either can satisfy `--location`.
- Some Teamtailor employers use a custom careers domain (for example
  `karriere.hent.no`) while the feed stays on `*.teamtailor.com`. Search results
  carry the custom-domain posting URL; pass that URL to `detail`.
- `guid` is a UUID while the posting URL slug carries a numeric id; `id` uses the
  guid when present, so `detail` prefers URLs.
