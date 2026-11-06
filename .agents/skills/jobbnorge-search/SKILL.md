---
name: jobbnorge-search
version: 1.0.0
description: Use this skill to search Jobbnorge (jobbnorge.no), Norway's job board for academia, state agencies, hospitals and the public sector, including Trondheim, Trøndelag and nationwide. Trigger phrases include jobbnorge, jobbnorge.no, jobs in norway, norwegian jobs, academic jobs norway, university jobs norway, state jobs norway, hospital jobs norway, phd position norway, postdoc norway, forsker jobb, stipendiat, rådgiver jobb, stillinger i norge, ledige stillinger, jobb i Trondheim, jobb i Trøndelag, søk jobb, jobbsøk, offentlige stillinger, statlige stillinger, sykehusjobb, NTNU jobs, St. Olavs hospital jobs, finn jobb.
context: fork
enabled: true
allowed-tools: Bash(bun run .agents/skills/jobbnorge-search/cli/src/cli.ts *)
---

# Jobbnorge job search

Search live vacancies on [Jobbnorge](https://www.jobbnorge.no), the Norwegian
board used by universities, state directorates, hospitals and other
public-sector employers. The CLI reads Jobbnorge's public JSON endpoints, so no
token or login is needed.

## Commands

```bash
# Search the Trondheim commute area
bun run .agents/skills/jobbnorge-search/cli/src/cli.ts search -q "rådgiver" -l area --limit 5 --format table

# One municipality
bun run .agents/skills/jobbnorge-search/cli/src/cli.ts search -q "stipendiat" -l Trondheim --format table

# Whole county, last 7 days
bun run .agents/skills/jobbnorge-search/cli/src/cli.ts search -q "utvikler" -l Trøndelag --jobage 7 --format table

# Nationwide
bun run .agents/skills/jobbnorge-search/cli/src/cli.ts search -q "professor" --format json

# Detail by id or URL
bun run .agents/skills/jobbnorge-search/cli/src/cli.ts detail 310059 --format plain
bun run .agents/skills/jobbnorge-search/cli/src/cli.ts detail "https://www.jobbnorge.no/ledige-stillinger/stilling/310059" --format json
```

## Search flags

| Flag | Meaning |
| --- | --- |
| `--query`, `-q` | Free-text term (title, role, skill). Optional. |
| `--location`, `-l` | `area` = Trondheim commute area (municipalities 5001, 5031, 5028, 5029, 5035); a municipality name (Trondheim, Stjørdal, …); a county name (Trøndelag); a 3- or 4-digit municipality code; or a 2-digit county code. Omit for nationwide. |
| `--jobage` | Days since publication. See the coarse-window note below. |
| `--page` | 1-indexed page. Default `1`. (The API's own `page` is 0-indexed; the CLI translates.) |
| `--limit`, `-n` | Client-side cap on emitted results. |
| `--format` | `json` (default), `table`, or `plain`. |

`detail` accepts `--format json|plain` only.

## Output

JSON is the contract used by `/scrape`:

```json
{
  "meta": { "count": 2, "page": 1 },
  "results": [
    {
      "id": "310059",
      "title": "Professor/Associate Professor in Hydropower Technologies",
      "company": "NORGES TEKNISK-NATURVITENSKAPELIGE UNIVERSITET NTNU",
      "location": "Trondheim",
      "date": null,
      "url": "https://www.jobbnorge.no/ledige-stillinger/stilling/310059",
      "deadline": "2026-12-04",
      "jobScope": "Heltid",
      "jobDuration": "Fast",
      "summary": "The Department of Energy and Process Engineering has a vacancy for a"
    }
  ]
}
```

Every result has at least `id`, `title`, `company`, `location`, `date`, and
`url`; missing values are `null`, never omitted. Errors go to stderr as
`{"error":"…","code":"…"}` and exit `1`.

## Notes and portal quirks

- **No publication date in search results.** The search API returns deadline,
  not publication date, so `date` is always `null`. Use `deadline` for sorting
  decisions. This is deliberate, not a parser gap.
- **`--jobage` is coarse.** Jobbnorge exposes only `Period=Day` (24 hours) and
  `Period=Week` (7 days). `--jobage 1` maps to Day; every larger value maps to
  Week, the closest bounded window. When the approximation applies, the JSON
  `meta.note` says so.
- **`--location area`** sends the five municipality codes as repeated
  `municipality` parameters. Jobbnorge rejects a comma-separated list.
- **The portal's municipality filter is not a strict display-string filter.**
  Some multi-municipality and national ads appear under every municipality
  even when `location` shows another city or `Flere`. The CLI keeps the
  portal's match rather than dropping potentially relevant multi-location ads.
- **County names are resolved locally** from `/v1/County`; the search API wants
  the numeric county id (Trøndelag = 50), not the name.
- **Company normalisation** maps the API's `employer` string to the registry
  `name` in `job_scraper/employers.csv` (or `trondheim-patches/employers.seed.csv`)
  by name or pipe-separated aliases, so duplicates across portals line up.
  Unmatched employers keep the API spelling.
- **Detail language fallback.** Jobbnorge stores a posting's content per
  language. The CLI tries Norwegian Bokmål, English, Nynorsk and Sámi until one
  returns content; the chosen code is reported as `language`.
- **Detail description** is rebuilt from the site's content components, with
  paragraphs and list items preserved and hidden/script text removed.
- **Access.** Jobbnorge's `robots.txt` disallows only
  `/ledige-stillinger/joblisting/pdf/*`. The search and detail endpoints are
  public. Keep request volume low; this is a personal job-search helper.

## Files

- `url-reference.md` — endpoints, parameters, ids and parser anchors.
- `cli/` — zero-runtime-dependency Bun CLI and offline tests.
