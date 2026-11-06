# jobbnorge-search-cli

Search [Jobbnorge](https://www.jobbnorge.no), the Norwegian job board for
academia, state agencies, hospitals and the public sector. Zero runtime
dependencies: Bun + `fetch` + regex.

## Commands

```bash
bun run src/cli.ts search -q "rådgiver" -l area --limit 5 --format table
bun run src/cli.ts search -q "stipendiat" -l Trondheim --format json
bun run src/cli.ts detail 310059 --format plain
```

### `search`

| Flag | Meaning |
| --- | --- |
| `--query`, `-q` | Free-text search term. Optional. |
| `--location`, `-l` | `area`, a municipality name, a county name, a 3- or 4-digit municipality code or a 2-digit county code. Omit for nationwide. |
| `--jobage <days>` | 1 = `Period=Day`; 2+ = `Period=Week` (the API has no finer window). |
| `--page <n>` | 1-indexed page. Default 1. |
| `--limit`, `-n` | Client-side result cap. |
| `--format` | `json` (default), `table`, `plain`. |

JSON shape:

```json
{ "meta": { "count": 1, "page": 1 }, "results": [ { "id": "…", "title": "…", "company": "…", "location": "…", "date": null, "url": "…" } ] }
```

Every result includes `id`, `title`, `company`, `location`, `date` and `url`.
Missing values are `null`, never omitted. Errors are written to stderr as
`{"error":"…","code":"…"}` and exit `1`.

### `detail`

Accepts a numeric id or a Jobbnorge URL. `--format json` (default) or `plain`.
The description is fetched from the language-specific content endpoint and
cleaned of hidden, script and comment text.

## Data sources

- Search: `https://publicapi.jobbnorge.no/v1/Jobs`
- Counties/municipalities: `https://publicapi.jobbnorge.no/v1/County`
- Detail metadata: `https://id.jobbnorge.no/api/joblisting/job-info`
- Detail content: `https://id.jobbnorge.no/api/joblisting?jobId=…&languageId=…`

See `../url-reference.md` for parameters, ids and parser anchors.

## Install and test

```bash
bun install
bun run typecheck
bun run test
```

Tests are offline: a local fixture server plus a preload that rewrites
Jobbnorge hosts to it. No live network calls are made by `bun test`.

## Notes

- `date` is `null` because the search payload has no publication date. The
  deadline is returned as `deadline`.
- `--jobage` values above 1 use the portal's 7-day window. The JSON
  `meta.note` reports the approximation.
- The CLI requests at most 100 rows per page. A `--limit` above 100 returns at
  most the first 100 of the current page; use `--page` to continue.
- `--location area` sends the five commute-area municipality codes (5001,
  5031, 5028, 5029, 5035) as repeated `municipality` parameters; Jobbnorge
  rejects a comma-separated list.
- Employer names are normalised against `job_scraper/employers.csv` and
  `trondheim-patches/employers.seed.csv`.
- `robots.txt` disallows only `/ledige-stillinger/joblisting/pdf/*`. Keep
  request volume low.
