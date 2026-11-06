---
name: easycruit-search
version: 1.0.0
description: >
  Use this skill to search public Visma EasyCruit career sites for employers in
  the Trondheim registry — Stjørdal kommune, Handelshøyskolen BI and Trøndelag
  brann- og redningstjeneste — or to look up one EasyCruit vacancy. Trigger
  phrases: easycruit, easycruit jobs, Visma EasyCruit, Stjørdal kommune jobs,
  Stjørdal kommune ledige stillinger, jobb i Stjørdal, ledige stillinger
  Stjørdal, søk jobb Stjørdal, Stjørdal kommune stillinger, BI jobs Trondheim,
  Handelshøyskolen BI jobb, BI ledige stillinger, TBRT jobs, Trøndelag brann og
  redning jobb, brannkonstabel Trøndelag, branninspektør Trøndelag, søk jobb
  Trøndelag, jobb i Trondheim, stillinger i Trondheim, offentlige jobber
  Trøndelag, academic jobs Norway, public sector jobs Norway, Norwegian
  municipality jobs, look up this EasyCruit vacancy.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run .agents/skills/easycruit-search/cli/src/cli.ts *)
---

# EasyCruit Search Skill

Reads public postings from Visma EasyCruit career sites for the enabled
employers in `job_scraper/employers.csv` with `ats=easycruit`. Results are
normalised to the registry company name (for example `STJØRDAL KOMMUNE`), which
keeps cross-source duplicates together for `/scrape`.

No credentials and no runtime dependencies beyond `bun`.

## Personal use and access

`robots.txt` on these sites permits every path except `/intranet/`. This skill
reads the public RSS and XML feeds at low volume for personal job search: keep
it to your own search needs rather than bulk collection, commercial use or a
tight schedule. It never impersonates a browser and never solves or bypasses
the AWS WAF JavaScript challenge that some EasyCruit HTML pages present; it
uses the public XML/RSS endpoints that return 200 and reports a challenge if one
appears.

## When to use this skill

- Search the Trondheim commute area (`-l area`) or a named place (`-l Stjørdal`)
- Search a role with `-q` (e.g. `lærer`, `sykepleier`, `brannkonstabel`)
- Fetch the full readable description of one posting

## Commands

```bash
bun run .agents/skills/easycruit-search/cli/src/cli.ts search [flags]
bun run .agents/skills/easycruit-search/cli/src/cli.ts detail <slug/id|url> [--format json|plain]
```

Search flags:

- `--query <text>` / `-q <text>` — keywords matched against title **and**
  description (Norwegian compounds work: `lærer` matches `Lærervikar`).
- `--location <text>` / `-l <text>` — `area` reads `job_scraper/area.json`;
  a municipality matches itself and its places (`-l Stjørdal` matches Skatval,
  Hell and Hegra), while a named place matches only that place (`-l Skatval`
  does not return the rest of Stjørdal). Whole-token matching prevents
  `Vennesla` matching `Venn` or `Helle` matching `Hell`.
- `--jobage <days>` — posting start within N days, from the XML joblist
  `date_start`. The RSS feed itself has no per-item `pubDate`.
- `--page <n>` — 1-indexed result page.
- `--limit <n>` / `-n <n>` — results per page and cap (default 50).
- `--detail-limit <n>` — maximum detail pages fetched per run (default 40).
- `--format json|table|plain` — default `json`.

Detail input:

- `<slug>/<id>`, for example `stjordal/3673377`
- a full `https://<slug>.easycruit.com/vacancy/<id>` URL (extra path segments
  and query strings are accepted)
- a bare vacancy id is rejected: EasyCruit sites do not share an ID namespace,
  so the CLI will not guess an employer.

## Usage examples

```bash
# Everything in the Trondheim commute area
bun run .agents/skills/easycruit-search/cli/src/cli.ts search -l area --limit 10 --format table

# Lærer roles in Stjørdal
bun run .agents/skills/easycruit-search/cli/src/cli.ts search -q lærer -l Stjørdal --limit 10 --format table

# Sustainability / environment roles across the registry
bun run .agents/skills/easycruit-search/cli/src/cli.ts search -q bærekraft -l area --format table

# Emergency-service roles
bun run .agents/skills/easycruit-search/cli/src/cli.ts search -q brann -l area --format table

# Full detail for one posting
bun run .agents/skills/easycruit-search/cli/src/cli.ts detail stjordal/3673377 --format plain
```

## Output formats

| Format | Best for |
|--------|----------|
| `json` | Default — `{ meta, results }`, each result has `id`, `title`, `company`, `location`, `date`, `url` (nulls included) |
| `table` | Quick human-readable scanning |
| `plain` | Reading a single posting's full detail |

`--format json` returns:

```json
{
  "meta": { "count": 2, "page": 1, "totalMatched": 3, "errors": [] },
  "results": [
    {
      "id": "stjordal/3673377",
      "title": "Ledig 0-hjemmel for fastlege ved Skatval legekontor",
      "company": "STJØRDAL KOMMUNE",
      "location": "Skatval legekontor, Stjørdal",
      "date": "2026-11-05",
      "url": "https://stjordal.easycruit.com/vacancy/3673377/240765"
    }
  ]
}
```

Every result has all six fields; missing values are `null`, never omitted. In
`table` and `plain` output a missing title is rendered as `(untitled)`.
`errors` is `{ "employer": "...", "error": "..." }` for an employer that could
not be read; one failing employer does not fail the run. Errors themselves are
written to stderr as `{ "error": "...", "code": "..." }` with exit code `1`.
The one-line employer-error summary printed by `table`/`plain` also goes to
stderr, never stdout.

## Notes

- **RSS link quirk.** On the sites verified on 6 November 2026 every `<item>`'s
  `<link>` points at the same first vacancy. The CLI therefore takes unique IDs
  and dates from the public XML joblist
  (`/export/xml/vacancy/list.xml`) and joins RSS descriptions back by title.
  `url-reference.md` records both structures.
- **Dates.** The HTML detail page does not expose a publication date; the XML
  joblist/detail does (`date_start`). Detail reads both endpoints so the date is
  populated without a second interpretation.
- **Locations.** Search tries the detail page's `div.jd-location` for the rows
  it is about to print. When the XML workplace is only a department name
  (`Ved våre barnehager`), the municipality derived from the registry employer
  name is appended (`Ved våre barnehager, Stjørdal`). An explicit workplace such
  as `Oslo` is left alone, so it is not rewritten into an area match.
- **Partial RSS.** Some sites' `/rss` is partial: BI returns 4 RSS items against
  14 XML vacancies (the PhD roles are absent). Descriptions for the missing rows
  are fetched from the detail endpoint when a `-q` filter needs them.
- **Registry.** `job_scraper/employers.csv` is the single source of truth. An
  enabled `ats=easycruit` row with a missing or invalid `ats_ref` is skipped and
  listed in `meta.errors`; the CLI never guesses or silently repairs a URL.
- **Challenge handling.** HTML search/root pages and plain `/vacancy/<id>` may
  return HTTP 202 from AWS WAF. The CLI does not solve that challenge; a
  challenge hit during list parsing is reported as a per-employer `meta.errors`
  entry, and a challenge during detail enrichment is reported the same way
  while the rest of the run continues. A genuine 404 detail is silently absent
  (there is nothing to report).
