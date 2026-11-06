# easycruit-search CLI

Searches public Visma EasyCruit career sites for the employers in
`job_scraper/employers.csv` with `ats=easycruit` (falling back to
`trondheim-patches/employers.seed.csv`). The canonical employer name from the
registry is used as `company`, so cross-source duplicates stay together in
`/scrape`.

Zero runtime dependencies: Bun + `fetch` + regex.

## Install and check

```bash
cd .agents/skills/easycruit-search/cli
bun install
bun run typecheck
```

`bun install` only pulls TypeScript and Bun's type definitions; the CLI itself
has no dependencies.

## Usage

```bash
# Everything in the Trondheim commute area
bun run src/cli.ts search -l area --limit 10 --format table

# Lærer roles in Stjørdal
bun run src/cli.ts search -q lærer -l Stjørdal --limit 10 --format table

# Full detail for one posting
bun run src/cli.ts detail stjordal/3673377 --format plain
```

Search flags: `-q/--query`, `-l/--location`, `--jobage <days>`, `--page <n>`,
`-n/--limit <n>`, `--detail-limit <n>` (default 40), `--format json|table|plain`
(default `json`). Detail takes `<slug>/<id>` or a full EasyCruit vacancy URL;
a bare vacancy id is rejected because EasyCruit sites do not share an ID
namespace.

## Data sources

| Endpoint | Purpose |
|---|---|
| `https://<slug>.easycruit.com/export/xml/vacancy/list.xml` | Unique vacancy IDs, titles, `date_start`, workplace |
| `https://<slug>.easycruit.com/rss` | Per-item descriptions, fetched only for `-q` searches (the `<link>` field is **not** unique) |
| `https://<slug>.easycruit.com/vacancy/<id>/rss` | Public HTML detail with `.jd-location`, `.jd-deadline`, `.jd-description` |
| `https://<slug>.easycruit.com/export/xml/vacancy/<id>.xml` | XML detail with `date_start` and the full description |

The root and plain `/vacancy/<id>` URLs may return an AWS WAF JavaScript
challenge (HTTP 202). The CLI never solves or bypasses it; the XML/RSS paths
above are public and return 200, and a challenge is reported as an employer
error or a blocked detail rather than worked around.

## Offline tests

`EASYCRUIT_FIXTURE_DIR` makes every request read a recorded fixture instead of
the network. `EASYCRUIT_REGISTRY` and `EASYCRUIT_AREA` point the CLI at fixture
registry/area files. See `tests/easycruit.test.ts`.

A live smoke test is included and opt-in:

```bash
EASYCRUIT_LIVE=1 bun run test
```

## Notes

- `--jobage` filters on the XML joblist's `date_start`. The RSS feed has no
  per-item `pubDate`; the joblist is the date source.
- Per-employer failures (bad `ats_ref`, missing XML list, WAF challenge) are
  non-fatal and appear in `meta.errors` as
  `{ "employer": "...", "error": "..." }`.
- `job_scraper/area.json` is matched with whole-token phrase matching, so
  `Vennesla` does not match Skaun's `Venn` and `Helle` does not match
  Stjørdal's `Hell`. A named municipality matches its places, but a named place
  matches only itself (`-l Skatval` is not rewritten to all of Stjørdal).
- RSS descriptions are fetched only when `--query`/`-q` is supplied; a
  location-only search makes one request per employer instead of two.
- The merged registry is the single source of truth for employer base URLs. An
  enabled `ats=easycruit` row with a missing or invalid `ats_ref` is skipped and
  reported; the CLI never guesses or silently repairs a URL.
