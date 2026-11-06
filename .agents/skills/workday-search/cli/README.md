# workday-search-cli

CLI for reading jobs from public Workday career sites through the unauthenticated
CXS JSON API. Built for the Trondheim employer registry (Equinor, Norconsult,
ASKO Midt-Norge, NG Meny and If), but the API is the same for any Workday tenant.

**Data source**: `POST https://<host>/wday/cxs/<tenant>/<site>/jobs`
**Authentication**: none.
**Dependencies**: none (Bun + `fetch` + JSON/regex). `bun install` only pulls TypeScript dev types.

## Installation

```bash
cd .agents/skills/workday-search/cli
bun install   # optional — only installs TypeScript dev types
```

## Commands

| Command | Description |
|---------|-------------|
| `search` | Pool jobs from every enabled `ats=workday` employer in the registry |
| `detail` | Read one posting (full URL preferred) |

`search` accepts `--format json|table|plain` (default `json`); `detail` accepts
`--format json|plain`. All errors are written to **stderr** as
`{ "error": "...", "code": "..." }` with exit code `1`.

## Search flags

| Flag | Alias | Description |
|------|-------|-------------|
| `--query` | `-q` | Keywords sent to Workday as `searchText`. |
| `--location` | `-l` | `area` (Trondheim commute area from `job_scraper/area.json`), a place (`Trondheim`, `Heimdal`, `Stjørdal`, …), or omit. |
| `--jobage` | | Posted within N days, parsed from Workday's relative `postedOn` label. |
| `--page` | | 1-indexed page; `offset = (page - 1) * limit`. |
| `--limit` | `-n` | Workday page size and cap on emitted results (maximum 100). |
| `--location-detail-limit` | | Maximum ambiguous postings whose detail is fetched to verify a location. Default 20. |
| `--format` | | `json` \| `table` \| `plain`. |

`meta.errors` lists registry rows that could not be used (for example a Workday
row with an empty `ats_ref`) and sites that failed. One failing site never fails
the run.

## Registry

Read from `job_scraper/employers.csv`, falling back to
`trondheim-patches/employers.seed.csv`. Only rows with `ats=workday`, a non-empty
`ats_ref`, and `enabled` not false are read. `company` is the row's `name`.

`ats_ref` is a public career-site URL, for example:

```
https://norconsult.wd3.myworkdayjobs.com/Norconsult_Career_Site
https://norgesgruppen.wd3.myworkdayjobs.com/karriere
https://equinor.wd3.myworkdayjobs.com/EQNR
https://if.wd502.myworkdayjobs.com/Careers/
```

The CLI derives:

- `origin` — the URL origin (`https://norconsult.wd3.myworkdayjobs.com`)
- `tenant` — the first host label (`norconsult`)
- `site` — the first path segment after any locale (`no-NO`, `en-US`), stopping
  before `/job/`.

Rows that share one site (ASKO and NG Meny both use NorgesGruppen's `karriere`
site) are fetched once. A brand token in the posting title/path/bullet fields
picks the matching registry name. A posting for another group brand (SPAR,
Joker, KIWI) keeps that brand as `company`; unknown employers keep their own
name.

## Location semantics

`--location area` reads `job_scraper/area.json` and matches the Workday
`locations` facet descriptors against every municipality name, alias and place
(diacritic-insensitive, country suffix stripped, so `Rotvoll, Norway` matches
Trondheim). Matching facet ids are passed as
`appliedFacets: { "locations": [...] }`.

Facet ids are grouped by their own `facetParameter` and sent under that key:
most tenants use `locations`, while NorgesGruppen exposes a
`locationHierarchy1` (municipality) facet whose ids are rejected under
`locations`. If a site exposes no matching facet (or rejects the facet body),
the CLI lists postings and matches `locationsText` client-side. Ambiguous labels
such as `"4 Locations"`, `"Multiple Locations"` and `"Nordic"` are resolved by
fetching the posting detail and checking `location` + `additionalLocations`
(bounded by `--location-detail-limit`).

A specific `--location Trondheim` accepts every district in the municipality. A
district such as `--location Heimdal` accepts Heimdal or the municipality label
`Trondheim`, but not other districts.

## Detail

URLs are preferred:

```bash
bun run src/cli.ts detail "https://norconsult.wd3.myworkdayjobs.com/Norconsult_Career_Site/job/Trondheim/Sommerjobb-2027---Dam-og-vassdrag_REQ-6486" --format plain
```

Also accepted:

- `<tenant>/<site>/job/...` (resolved through the registry for the `wdN` host)
- a bare `/job/...` path when the registry has exactly one Workday site

A 404 or an empty payload is `NOT_FOUND`. The detail response's `jobDescription`
is run through `visibleHtml` + tag stripping before output.

## Testing

`bun run test` uses offline fixtures only. Set `WORKDAY_FIXTURE_DIR` to serve
search pages from `<tenant>.<site>.search.json` (or `.search.filtered.json` /
`.search.query.json`) and detail from
`<tenant>.<site>.detail.<sanitized-externalPath>.json` / `detail.json`.
`WORKDAY_REGISTRY` and `WORKDAY_AREA` point at fixture copies of the registry and
area files. With no fixture directory the CLI uses the network.
