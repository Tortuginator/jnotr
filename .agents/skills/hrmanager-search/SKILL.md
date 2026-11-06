---
name: hrmanager-search
version: 1.0.0
description: >
  Use this skill to find jobs published on HR Manager / Talentech portals by
  Norwegian employers in the Trondheim registry — Sparebank 1 SMN, Sparebank 1
  Regnskapshuset SMN, GK Norge and Museene i Sør-Trøndelag — or to look up one
  HR Manager posting. Trigger phrases: hr manager, hr-manager, talentech,
  talentech jobs, Sparebank 1 SMN jobs, SpareBank 1 jobb, Sparebank 1
  Regnskapshuset jobs, GK Norge jobs, Museene i Sør-Trøndelag jobs, MiST jobs,
  find banking jobs Trondheim, finance jobs Trondheim, jobb i Trondheim, ledige
  stillinger Trondheim, jobb i Trøndelag, søk jobb SpareBank 1, bankjobb
  Trondheim, økonomijobb Trondheim, stilling i Sparebank 1, Trondheim Norway
  jobs, look up this HR Manager posting.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run .agents/skills/hrmanager-search/cli/src/cli.ts *)
---

# HR Manager Search Skill

Reads public vacancy feeds from HR Manager / Talentech portals for the enabled
employers in `job_scraper/employers.csv` with `ats=hrmanager`. Results are
normalised to the registry company name, which keeps cross-source duplicates
together for `/scrape`.

No credentials and no runtime dependencies beyond `bun`.

## When to use this skill

- Search the Trondheim commute area (`-l area`) or a named place (`-l Trondheim`)
- Search a role with `-q` (e.g. `utvikler`, `rådgiver`, `finans`)
- Fetch the full readable description of one posting

## Commands

```bash
bun run .agents/skills/hrmanager-search/cli/src/cli.ts search [flags]
bun run .agents/skills/hrmanager-search/cli/src/cli.ts detail <id|url> [--format json|plain]
```

Search flags:

- `--query <text>` / `-q <text>` — keywords matched on title and description.
- `--location <text>` / `-l <text>` — `area` reads `job_scraper/area.json`;
  a specific place matches its city/municipality and places; omit for no filter.
- `--jobage <days>` — published within N days (client-side).
- `--page <n>` — 1-indexed result page.
- `--limit <n>` / `-n <n>` — results per page and cap (default 50).
- `--format json|table|plain` — default `json`.

## Usage examples

```bash
# Everything in the Trondheim commute area
bun run .agents/skills/hrmanager-search/cli/src/cli.ts search -l area --limit 10 --format table

# Developer roles in the area
bun run .agents/skills/hrmanager-search/cli/src/cli.ts search -q utvikler -l area --format table

# Finance and advisory roles
bun run .agents/skills/hrmanager-search/cli/src/cli.ts search -q rådgiver --jobage 30 --format table

# Full detail for one posting
bun run .agents/skills/hrmanager-search/cli/src/cli.ts detail "https://candidate.hr-manager.net/ApplicationInit.aspx?cid=1889&ProjectId=149231" --format plain
```

## Output

`--format json` returns:

```json
{
  "meta": { "count": 1, "page": 1, "totalMatched": 1, "errors": [] },
  "results": [
    {
      "id": "149240",
      "title": "Saksbehandler",
      "company": "SPAREBANK 1 SMN",
      "location": "Heimdal",
      "date": "2026-11-05",
      "url": "https://candidate.hr-manager.net/ApplicationInit.aspx?cid=1889&ProjectId=149240"
    }
  ]
}
```

Every result has all six fields; missing values are `null`, never omitted.

## Notes

- `ats_ref` may be `customer=<name>` or `cid=<n>`. Cids are resolved through the
  public RSS endpoint (the `customer=<name>` link in its response), never
  guessed. An unresolvable cid (e.g. GK Norge `cid=139` on 6 Nov 2026) appears
  in `meta.errors`.
- Only `protype=RecruitmentProject` is fetched; `OpenApplication` is a separate
  list.
- Shared feeds (Sparebank 1 SMN and Sparebank 1 Regnskapshuset SMN) are fetched
  once and attributed to the first enabled row.
- HR Manager's RSS has no dedicated location field. The CLI uses a short trailing
  title segment (`Finansrådgiver - Namsos`) and, when absent, a conservative
  description pattern (`På Heimdal søker vi …`). Jobs without a recognised
  location are `null` and are excluded when `-l` is set.
- `candidate.hr-manager.net/robots.txt` allows `ApplicationInit.aspx?` but
  disallows the list pages; the CLI uses the API RSS for lists and only fetches
  detail pages. `api.hr-manager.net/robots.txt` returns 404 (no published rules).
- Per-employer failures are non-fatal and appear in `meta.errors` as
  `{ "employer": "...", "error": "..." }`.
