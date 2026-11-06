# nav-search-cli

CLI for Norwegian job vacancies from **NAV Arbeidsplassen**'s official job feed
(`pam-stilling-feed.nav.no`). The feed is a change log, so the CLI keeps a local
cache with `sync` and searches that cache.

**Data source**: NAV Job Vacancy Feed, `GET /api/v1/feed` and
`GET /api/v1/feedentry/<uuid>`.
**Authentication**: bearer token in `NAV_API_TOKEN`.
**Dependencies**: none at runtime (Bun + `fetch`). `bun install` only pulls dev
type definitions.

## Setup

```bash
export NAV_API_TOKEN="<private token from NAV>"
cd .agents/skills/nav-search/cli
bun install   # optional; only TypeScript dev types
```

Request a private token from **nav.team.arbeidsplassen@nav.no** and accept the
[API terms](https://arbeidsplassen.nav.no/vilkar-api). A rotating public token
for experiments is available at
`https://pam-stilling-feed.nav.no/api/publicToken`, but it changes irregularly
and is not suitable for routine use. The CLI never fetches that endpoint
automatically and never hardcodes a token.

## Commands

| Command | Description |
|---------|-------------|
| `sync` | Pull feed pages into `job_scraper/nav_cache.jsonl` and update `job_scraper/nav_feed_state.json` |
| `search` | Search the cache (active ads only) |
| `detail` | Fetch and print one ad's full detail from NAV |

All errors are written to **stderr** as `{ "error": "...", "code": "..." }` with
exit code `1`.

## Quick examples

```bash
# First run: recent Trondheim-area changes with low volume
bun run src/cli.ts sync --since 7 --max-pages 2

# Developer roles in the commute area
bun run src/cli.ts search -q utvikler -l area --limit 5 --format table

# Data engineering roles in Trondheim, last two weeks
bun run src/cli.ts search -q "data engineer" -l Trondheim --jobage 14

# Full detail
bun run src/cli.ts detail 1306dcfd-f0c5-4fba-8835-d9a456dbd6b3 --format plain
```

## Flags

### sync

| Flag | Description |
|------|-------------|
| `--since <days>` | Keep changes from the last N days. Default: 30. |
| `--max-pages <n>` | Maximum feed pages to pull. Default: 20. |
| `--dry-run` | Fetch and report without writing cache or cursor. |

### search

| Flag | Alias | Description |
|------|-------|-------------|
| `--query <text>` | `-q` | Case-insensitive match on title and description. |
| `--location <place>` | `-l` | `area`, a municipality name, or omit for all. |
| `--jobage <days>` | | Published/changed within N days. |
| `--page <n>` | | 1-indexed page. Default: 1. |
| `--limit <n>` | `-n` | Results per page. Default: 20. |
| `--max-age-minutes <n>` | | Refresh a stale cache when a token is set. Default: 30. |
| `--format json\|table\|plain` | | Default: `json`. |

### detail

`detail <uuid|url> [--format json|plain]`. Accepts a bare UUID, a feed-entry
path, a full feed-entry URL, or a public `arbeidsplassen` ad URL.

## Cache

- `job_scraper/nav_cache.jsonl` - one normalized JSON object per ad, upserted by
  `_feed_entry.uuid`.
- `job_scraper/nav_feed_state.json` - cursor, newest date, last page id, and
  recent page ids.

Both are user data and should not be committed. Writes are atomic. An `ACTIVE`
feed entry never overrides a newer or equally new `INACTIVE` state for the same
UUID.

`--location area` reads `job_scraper/area.json`; if it is missing, the CLI uses
Trondheim, Malvik, Melhus, Skaun, and Stjørdal. `company` is normalized to
`job_scraper/employers.csv` by name, aliases, or organisation number, falling
back to `trondheim-patches/employers.seed.csv`.

## Development

```bash
bun run typecheck
bun run test
```

Tests are fixture-only and never call the live API. See `../url-reference.md`
for endpoints, field paths, paging, and source quirks.
