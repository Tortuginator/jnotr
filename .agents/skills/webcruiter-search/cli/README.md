# webcruiter-search-cli

CLI for reading public Webcruiter job lists for every enabled employer in
`job_scraper/employers.csv` with `ats=webcruiter`.

**Data source**: the JSON endpoint behind
`candidate.webcruiter.com/nb-no/Home/companyadverts?companylock=<id>`.
**Authentication**: none.
**Dependencies**: none (plain `bun` + `fetch`). `bun install` only pulls dev types.

> **Personal use only.** Webcruiter's robots.txt disallows generic crawlers on
> both `candidate.webcruiter.com` and the tenant hosts. Keep volume low, do not
> use this commercially or for bulk collection, and run it on your own
> responsibility.

## Commands

| Command | Description |
|---------|-------------|
| `search` | Pool jobs from every enabled Webcruiter employer in the registry |
| `detail` | Fetch and clean one posting's description |

All errors are written to **stderr** as `{ "error": "...", "code": "..." }` with
exit code `1`.

## Examples

```bash
bun run src/cli.ts search -l area --limit 10 --format table
bun run src/cli.ts search -q sykepleier -l Trondheim --format table
bun run src/cli.ts search -q utvikler --jobage 14 --format json
bun run src/cli.ts detail https://7254.webcruiter.no/Main/Recruit/Public/5198357738 --format plain
bun run src/cli.ts detail 7254:5198357738 --format plain
```

## Search flags

| Flag | Alias | Description |
|------|-------|-------------|
| `--query` | `-q` | Keywords matched against title, company, category and description |
| `--location` | `-l` | `area` or a municipality/place/city; omit for no filter |
| `--jobage` | | Keep postings published within N days |
| `--page` | | 1-indexed page of the pooled results (default 1) |
| `--limit` | | Page size and cap (default 50) |
| `--format` | | `json` (default), `table`, `plain` |

See `../SKILL.md` for the full reference and `../url-reference.md` for the
endpoint details.
