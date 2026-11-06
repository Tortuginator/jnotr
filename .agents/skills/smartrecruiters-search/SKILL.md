---
name: smartrecruiters-search
version: 1.0.0
description: >
  Use this skill to find jobs published on SmartRecruiters by Norwegian
  employers in the Trondheim employer registry — Aker Solutions, Ramboll Norge,
  Sopra Steria, Sportradar and Tietoevry Banktech — or to look up one
  SmartRecruiters posting. Trigger phrases: smartrecruiters, smartrecruiters
  jobs, jobs at Sopra Steria Norway, Ramboll Norge jobs, Sportradar Trondheim
  jobs, Aker Solutions careers, Tietoevry Banktech jobs, find developer jobs in
  Trondheim, IT jobs Trondheim, jobb i Trondheim, ledige stillinger Trondheim,
  jobb hos Ramboll, jobb hos Sopra Steria, søk jobb Trøndelag, nyutdannet jobb
  Trondheim, engineer jobs Norway, Norway tech jobs, Trondheim software jobs,
  look up this SmartRecruiters posting.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run .agents/skills/smartrecruiters-search/cli/src/cli.ts *)
---

# SmartRecruiters Search Skill

Reads public postings from SmartRecruiters company accounts for the enabled
employers in `job_scraper/employers.csv` with `ats=smartrecruiters`. Results are
normalised to the registry company name (for example `SOPRA STERIA AS`), which
keeps cross-source duplicates together for `/scrape`.

No credentials and no runtime dependencies beyond `bun`.

## ⚠️ Personal use only

`api.smartrecruiters.com/robots.txt` disallows generic automated agents while
allowing select crawlers. This skill reads the public company postings API at
low volume for personal job search only: do not use it commercially, for bulk
collection, or on a schedule tighter than your own search needs. Review
SmartRecruiters' terms and run it on your own responsibility.

## When to use this skill

- Search the Trondheim commute area (`-l area`) or a named place (`-l Trondheim`)
- Search a role with `-q` (e.g. `utvikler`, `data engineer`, `rådgiver`)
- Fetch the full readable description of one posting

## Commands

```bash
bun run .agents/skills/smartrecruiters-search/cli/src/cli.ts search [flags]
bun run .agents/skills/smartrecruiters-search/cli/src/cli.ts detail <id|url> [--format json|plain]
```

Search flags:

- `--query <text>` / `-q <text>` — keywords, forwarded to the API as `q`.
- `--location <text>` / `-l <text>` — `area` reads `job_scraper/area.json`;
  a specific place matches its city/municipality and places; omit for no filter.
- `--jobage <days>` — posting released within N days (client-side).
- `--page <n>` — 1-indexed result page.
- `--limit <n>` / `-n <n>` — results per page and cap (default 50).
- `--format json|table|plain` — default `json`.

## Usage examples

```bash
# Everything in the Trondheim commute area
bun run .agents/skills/smartrecruiters-search/cli/src/cli.ts search -l area --limit 10 --format table

# Developer roles in Trondheim, last 30 days
bun run .agents/skills/smartrecruiters-search/cli/src/cli.ts search -q utvikler -l Trondheim --jobage 30 --format table

# Data roles across the registry
bun run .agents/skills/smartrecruiters-search/cli/src/cli.ts search -q "data engineer" -l area --format table

# Full detail for one posting
bun run .agents/skills/smartrecruiters-search/cli/src/cli.ts detail 744000160192843 --format plain
```

## Output

`--format json` returns:

```json
{
  "meta": { "count": 2, "page": 1, "totalMatched": 42, "errors": [] },
  "results": [
    {
      "id": "744000160192843",
      "title": "Senior systemutvikler",
      "company": "SOPRA STERIA AS",
      "location": "Trondheim, Trøndelag, Norway",
      "date": "2026-11-05",
      "url": "https://jobs.smartrecruiters.com/SopraSteria1/744000160192843"
    }
  ]
}
```

Every result has all six fields; missing values are `null`, never omitted.

## Notes

- `-l` also constrains the API to `country=no`, because all registry employers
  are Norwegian. This keeps large group accounts small.
- Per-employer failures (bad slug, 404, network error) are non-fatal and appear
  in `meta.errors` as `{ "employer": "...", "error": "..." }`.
- A registry `ats_ref` of `v1` is the API version, not a slug. Rows that still
  carry it are reported as errors; Sportradar has a verified override.
- `api.smartrecruiters.com/robots.txt` disallows generic crawlers while allowing
  the company API path to LinkedInBot. The endpoints are public and intended
  for job widgets; keep volume low and use this only for personal job search.
- SmartRecruiters caps `limit` at 100; the CLI pages internally and then applies
  `--page`/`--limit` client-side.
