# hrmanager-search-cli

CLI for reading jobs from employers in `job_scraper/employers.csv` whose `ats`
is `hrmanager`, using HR Manager / Talentech's public RSS feed.

- **Data source:** `https://api.hr-manager.net/JobPortal.svc/<customer>/PositionList/rss/`
- **Detail page:** `https://candidate.hr-manager.net/ApplicationInit.aspx?...`
- **Authentication:** none
- **Runtime dependencies:** none (Bun + `fetch` + regex)
- **Registry:** enabled rows with `ats=hrmanager`; `ats_ref` is
  `customer=<name>` or `cid=<n>`.

## Install and run

```bash
cd .agents/skills/hrmanager-search/cli
bun install          # dev types only
bun run typecheck
bun run test
```

```bash
bun run src/cli.ts search -l area --limit 10 --format table
bun run src/cli.ts search -q utvikler -l area --format table
bun run src/cli.ts detail "https://candidate.hr-manager.net/ApplicationInit.aspx?cid=1889&ProjectId=149231" --format plain
```

From the repository root, use the path in `SKILL.md`.

## Commands

| Command | Description |
|---------|-------------|
| `search` | Read every enabled HR Manager feed, filter client-side, paginate |
| `detail <id\|url>` | Fetch one posting's readable description |

`search` accepts `--format json|table|plain` (default `json`); `detail` accepts
`json|plain`. Fatal errors go to stderr as `{ "error": "...", "code": "..." }`
with exit code 1. Per-employer failures are non-fatal and appear in
`meta.errors`.

## Search flags

| Flag | Alias | Description |
|------|-------|-------------|
| `--query` | `-q` | Keywords matched on title and decoded description. |
| `--location` | `-l` | `area`, a municipality/place (`Trondheim`, `Heimdal`), or a city. Omit for no filter. |
| `--jobage` | | Posted within N days (client-side, on `pubDate`). |
| `--page` | | 1-indexed result page. |
| `--limit` | `-n` | Results per page and cap. Default 50. |
| `--format` | | `json` (default) \| `table` \| `plain`. |

## Notes

- `cid=<n>` rows are resolved through the public RSS endpoint
  (`JobPortal.svc/<cid>/PositionList/rss/`), which returns the customer name in
  a `<link>` even on a 400 response. `list.aspx` is disallowed by robots.txt and
  is not used.
- Only `protype=RecruitmentProject` is fetched. `OpenApplication` is a separate
  list and is not part of normal vacancy search.
- Shared feeds (Sparebank 1 SMN and Sparebank 1 Regnskapshuset SMN both use
  `customer=Sparebank1`) are fetched once and attributed to the first enabled
  registry row.
- HR Manager has no dedicated location field in the RSS item. The CLI reads a
  short trailing title segment (`Finansrådgiver - Namsos`) and, when absent, a
  conservative description pattern (`På Heimdal søker vi …`). Unknown locations
  are `null` and are excluded by `-l`.
- The detail page is allowed by `candidate.hr-manager.net/robots.txt`
  (`Allow: /ApplicationInit.aspx?`); the list pages are not.
