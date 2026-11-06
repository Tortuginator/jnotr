# teamtailor-search-cli

CLI for reading jobs from Teamtailor career sites through their public RSS feeds.
Built for the Trondheim employer registry, but the feed format is global.

**Data source**: `<site>/jobs.rss?offset=<n>&per_page=100` (Teamtailor's documented public feed).
**Authentication**: none.
**Dependencies**: none (plain Bun + `fetch` + regex). `bun install` only pulls TypeScript dev types.

## Installation

```bash
cd .agents/skills/teamtailor-search/cli
bun install   # optional — only installs TypeScript dev types
```

## Commands

| Command | Description |
|---------|-------------|
| `search` | Pool jobs from every enabled Teamtailor employer in the registry |
| `detail` | Read one posting page (full URL preferred) |

`search` accepts `--format json|table|plain` (default `json`); `detail` accepts `--format json|plain`.
All errors are written to **stderr** as `{ "error": "...", "code": "..." }` with exit code `1`.

## Search flags

| Flag | Alias | Description |
|------|-------|-------------|
| `--query` | `-q` | Case-insensitive match on title + description text. |
| `--location` | `-l` | `area` (Trondheim commute area), a specific place (`Trondheim`, `Oslo`, …), or omit. |
| `--jobage` | | Posted within N days, from the RSS `pubDate`. |
| `--page` | | Feed pages read per employer (100 items/page). Default `1`. |
| `--limit` | `-n` | Cap results emitted after filtering. |
| `--format` | | `json` \| `table` \| `plain`. |

`meta.errors` lists registry rows that could not be used (for example a
Teamtailor row with an empty `ats_ref`) and feeds that failed to load. One
failing feed never fails the run.

`--page` is a feed-pagination control, not a slice of the pooled results: page 2
reads `offset=0` and `offset=100` from each employer, then filters and pools.
Use `--limit` to cap output.

## Registry

Read from `job_scraper/employers.csv`, falling back to
`trondheim-patches/employers.seed.csv`. Only rows with `ats=teamtailor`, a
non-empty `ats_ref`, and `enabled` not false are read. `company` is the row's
`name`, so cross-source deduplication can compare like with like. Rows with a
missing `ats_ref` are skipped and reported; a slug is never guessed.

`ats_ref` must be an RSS URL, e.g. `https://hent.teamtailor.com/jobs.rss`.
Two rows pointing at the same feed are fetched once, and duplicate posting URLs
are emitted once.

## Location semantics

`--location area` reads `job_scraper/area.json` and accepts a posting when any
`tt:location` matches a municipality `name`, alias or place, or its `zip` starts
with one of the municipality's postal prefixes. Diacritics are ignored, so
`Trondheim` also matches `Trondheim`, and `Heimdal` counts as part of Trondheim.

A specific `--location` matches a location `name` or `city` exactly (again
diacritic- and case-insensitive). Omit `--location` to return every location,
including Teamtailor feeds that list jobs outside Norway.

Output `location` is the Teamtailor `tt:name` (or `tt:city`) plus country, for
example `Trondheim, Norway`; multiple locations are joined with `; `.

## Detail

URLs are preferred:

```bash
bun run src/cli.ts detail "https://karriere.hent.no/jobs/8630421-anleggsleder-betong" --format plain
```

A bare id can only be turned into a URL when the registry has exactly one
Teamtailor employer; otherwise the CLI exits with `AMBIGUOUS_ID`. Search results
include the posting `url` for this reason.

## Testing

`bun run test` uses offline fixtures only. Set `TEAMTAILOR_FIXTURE_DIR` to serve
feed pages from `<slug>.rss` / `<slug>.<offset>.rss` and a posting from
`detail.html`; `TEAMTAILOR_REGISTRY` and `TEAMTAILOR_AREA` point at fixture
copies of the registry and area files. With no fixture directory the CLI uses
the network.
