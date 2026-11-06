# reachmee-search-cli

CLI for reading public ReachMee job lists for every enabled employer in
`job_scraper/employers.csv` with `ats=reachmee`.

**Data sources**:
- legacy public lists on `webNNN.reachmee.com/ext/<I-code>/<customer>/main`
  (require a per-customer `validator` query parameter);
- modern Attract career sites on `<slug>.attract.reachmee.com/jobs`.

**Authentication**: none.
**Dependencies**: none (plain `bun` + `fetch`). `bun install` only pulls dev types.

> **Personal use only.** Keep volume low, do not use this commercially or for
> bulk collection, and run it on your own responsibility.

## Commands

| Command | Description |
|---------|-------------|
| `search` | Pool jobs from every enabled ReachMee employer in the registry |
| `detail` | Fetch and clean one posting's description |

All errors are written to **stderr** as `{ "error": "...", "code": "..." }` with
exit code `1`. Per-employer failures are reported in `meta.errors` and do not
fail the run.

## Examples

```bash
bun run src/cli.ts search --limit 10 --format table
bun run src/cli.ts search -q sommerjobb -l area --format table
bun run src/cli.ts search -q ingeniør --format json
bun run src/cli.ts detail "https://web103.reachmee.com/ext/I010/2581/job?site=6&lang=NO&validator=...&job_id=215" --format plain
```

## Search flags

| Flag | Alias | Description |
|------|-------|-------------|
| `--query` | `-q` | Keywords matched against title, company and list text |
| `--location` | `-l` | `area` or a municipality/place/city; omit for no filter |
| `--jobage` | | Keep postings with a published date within N days |
| `--page` | | 1-indexed page of the pooled results (default 1) |
| `--limit` | | Page size and cap (default 50) |
| `--format` | | `json` (default), `table`, `plain` |

See `../SKILL.md` for the full reference and `../url-reference.md` for the
verified endpoints, including the validator and Attract patterns.
