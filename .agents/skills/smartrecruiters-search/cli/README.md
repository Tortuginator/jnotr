# smartrecruiters-search-cli

CLI for reading jobs from the employers in `job_scraper/employers.csv` whose
`ats` is `smartrecruiters`, using SmartRecruiters' public postings API.

- **Data source:** `https://api.smartrecruiters.com/v1/companies/<slug>/postings`
- **Authentication:** none
- **Runtime dependencies:** none (Bun + `fetch` + regex)
- **Registry:** enabled rows with `ats=smartrecruiters`; `company` in results is
  the registry `name`, so cross-source deduplication sees one spelling.

## Install and run

```bash
cd .agents/skills/smartrecruiters-search/cli
bun install          # dev types only
bun run typecheck
bun run test
```

```bash
bun run src/cli.ts search -l area --limit 10 --format table
bun run src/cli.ts search -q utvikler -l Trondheim --jobage 30 --format table
bun run src/cli.ts detail 744000160192843 --format plain
```

From the repository root, use the path in `SKILL.md`.

## Commands

| Command | Description |
|---------|-------------|
| `search` | Pool the enabled SmartRecruiters employers, filter by location/age, paginate |
| `detail <id\|url>` | Fetch one posting's readable description |

`search` accepts `--format json|table|plain` (default `json`); `detail` accepts
`json|plain`. Fatal errors go to stderr as `{ "error": "...", "code": "..." }`
with exit code 1. Per-employer failures are non-fatal and appear in
`meta.errors`.

## Search flags

| Flag | Alias | Description |
|------|-------|-------------|
| `--query` | `-q` | Keywords; forwarded to the API as `q` (full-text). |
| `--location` | `-l` | `area`, a municipality/place (`Trondheim`, `Malvik`, `Heimdal`), or a city. Omit for no filter. |
| `--jobage` | | Posted within N days (client-side, on `releasedDate`). |
| `--page` | | 1-indexed result page. |
| `--limit` | `-n` | Results per page and cap. Default 50. |
| `--format` | | `json` (default) \| `table` \| `plain`. |

## Notes

- `-l` also sends `country=no` to the API, because every registry employer is
  Norwegian and this keeps group-wide accounts (e.g. Ramboll, 1000+ postings)
  small. A bare `-q` without `-l` searches all countries.
- A registry `ats_ref` of `v1` is the API version, not a company slug. Such rows
  are reported in `meta.errors`; `SPORTRADAR AS` has a verified override
  (`Sportradar`) in `src/helpers.ts`.
- A bare numeric `detail` id is looked up across the enabled registry slugs.
- SmartRecruiters caps `limit` at 100 per request; the CLI pages internally.
- `api.smartrecruiters.com/robots.txt` disallows `/` for generic agents while
  allowing `/v1/companies/` to LinkedInBot. The API is public and serves the
  official job widgets, but keep volume low and use it only for personal job
  search. See `../url-reference.md`.
