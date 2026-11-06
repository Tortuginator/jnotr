# vismatalent-search-cli

CLI for reading public Visma Talent career-site job lists for every enabled
employer in `job_scraper/employers.csv` with `ats=vismatalent`.

**Data source**: the public JSON API at
`hire.vismatalent.com/Services/Public/CareerSites/GetJobList?siteGuid=<guid>`.
**Authentication**: none.
**Dependencies**: none (plain `bun` + `fetch`). `bun install` only pulls dev types.

> **Personal use only.** `hire.vismatalent.com/robots.txt` disallows generic
> crawlers (`User-agent: *` / `Disallow: /`) except for a few public paths.
> Keep volume low, do not use this commercially or for bulk collection, and run
> it on your own responsibility.

## Commands

| Command | Description |
|---------|-------------|
| `search` | Pool jobs from every enabled Visma Talent employer in the registry |
| `detail` | Fetch and clean one posting from its career site |

All errors are written to **stderr** as `{ "error": "...", "code": "..." }` with
exit code `1`.

## Examples

```bash
bun run src/cli.ts search -l area --limit 10 --format table
bun run src/cli.ts search -q kokk -l Stavanger --format table
bun run src/cli.ts search -q utvikler --jobage 14 --format json
bun run src/cli.ts detail 0ceb6ff0-777f-4216-93b6-be2d4ae34a16:821f710e-4079-45b1-a3b1-27b410df725d --format plain
bun run src/cli.ts detail "https://hire.vismatalent.com/Public/Assignment.aspx?guidAssignment=821f710e-4079-45b1-a3b1-27b410df725d&language=nb" --format plain
```

## Search flags

| Flag | Alias | Description |
|------|-------|-------------|
| `--query` | `-q` | Keywords matched against title and description |
| `--location` | `-l` | `area` or a municipality/county/country/place; omit for no filter |
| `--jobage` | | Keep postings published within N days |
| `--page` | | 1-indexed page of the pooled results (default 1) |
| `--limit` | | Page size and cap (default 50) |
| `--format` | | `json` (default), `table`, `plain` |

## Detail target forms

- `<siteGuid>:<jobGuid>` (the `id` emitted by `search`)
- a bare job GUID, when only one registry career site contains it
- a URL containing `guidAssignment`, optionally with a `siteGuid` query
  parameter or a `/careers/<siteGuid>` path segment

See `../SKILL.md` for the full reference and `../url-reference.md` for the
endpoint details.
