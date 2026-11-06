# Search Queries for Job Scraper — Trondheim

<!-- Trondheim fork: commute-area job search in Norway. -->

## Installed portal CLIs (primary for `/scrape`)

`/scrape` discovers every portal skill under `.agents/skills/*/SKILL.md` and runs its CLI first. This fork adds:

| Skill | Covers | Location handling |
| --- | --- | --- |
| `nav-search` | NAV Arbeidsplassen (all public Norwegian ads except FINN) | `-l area` filters the cached feed by municipality/postal code |
| `jobbnorge-search` | Jobbnorge (academia, state, hospitals) | `-l area` queries the five commute municipalities |
| `teamtailor-search` | Teamtailor career sites in the employer registry | `-l area` filters `tt:location` |
| `webcruiter-search` | Webcruiter employers (Trondheim kommune, St. Olavs, Trøndelag fylkeskommune, …) | `-l area` filters workplaces |
| `reachmee-search` | ReachMee/Attract employers (Sweco, Asplan Viak, ScaleAQ, …) | `-l area` filters posting locations |
| `smartrecruiters-search` | SmartRecruiters employers (Sopra Steria, Ramboll, Sportradar, …) | `-l area` filters posting locations |
| `hrmanager-search` | HR Manager/Talentech employers (Sparebank 1 SMN, MiST, …) | `-l area` filters posting locations |
| `workday-search` | Workday employers (Equinor, Norconsult, ASKO, NG Meny, If) | `-l area` uses Workday location facets and multi-location details |
| `vismatalent-search` | Visma Talent employers (Nortura, plus Webcruiter migrations) | `-l area` filters municipality/county |
| `linkedin-search` | LinkedIn, worldwide | pass `-l "Trondheim, Norway"` |
| `freehire-search` | freehire.me tech aggregator | pass `--country NO --city Trondheim` (facet flags, not `-l`) |

The four Danish demo portals (`jobbank`, `jobdanmark`, `jobindex`, `jobnet`) ship `enabled: false`; `/scrape` skips them.

`nav-search` keeps a local cache. Its `search` command performs one incremental `sync` when the cache is older than 30 minutes, so `/scrape` needs no separate pre-step. If you want to refresh explicitly:

```bash
bun run .agents/skills/nav-search/cli/src/cli.ts sync --since 30 --max-pages 20
```

**Run every CLI with `--format json` and `--limit 20` for `/scrape`.** The CLIs reject unknown flags.

## Location

The commute area is defined in `job_scraper/area.json` (rebuildable; git-ignored) and defaults to:

- Trondheim (5001) — including Heimdal, Ranheim, Tiller, Byåsen, Lerkendal, Moholt, Gløshaugen, Brattøra, Lade, Strinda
- Malvik (5031) — Hommelvik, Vikhammer, Muruvik, Saksvik
- Melhus (5028) — Lundamo, Kvål, Gimse, Hovin, Korsvegen
- Skaun (5029) — Børsa, Buvika, Eggkleiva, Venn
- Stjørdal (5035) — Hell, Hegra, Skatval

**Too far:** Oslo, Bergen, Stavanger, Tromsø, Bodø, Ålesund, and anything outside Trøndelag unless the posting is explicitly remote.

For every area-aware CLI use `--location area`, not a hard-coded city. Use `-l Trondheim` only when you deliberately want to exclude the surrounding municipalities. For `linkedin-search` use `-l "Trondheim, Norway"`.

## Query Categories

Run the top 3 priority categories by default; `/scrape broad` runs all. Write each category in Norwegian and English because the boards mix languages.

In the examples below, `...` stands for an enabled portal skill's CLI path (for example `.agents/skills/jobbnorge-search/cli/src/cli.ts`). Run each term with that portal's documented flags and `--format json`; do not execute the literal `...`.

### Priority 1: Software, data and product

```bash
# Norwegian
... search -q "utvikler" -l area --jobage 14 --limit 20 --format json
... search -q "programvareutvikler" -l area --jobage 14 --limit 20 --format json
... search -q "dataingeniør" -l area --jobage 14 --limit 20 --format json
... search -q "data scientist" -l area --jobage 14 --limit 20 --format json
... search -q "produktleder" -l area --jobage 14 --limit 20 --format json
# English
... search -q "software engineer" -l area --jobage 14 --limit 20 --format json
... search -q "data engineer" -l area --jobage 14 --limit 20 --format json
... search -q "machine learning" -l area --jobage 14 --limit 20 --format json
... search -q "product manager" -l area --jobage 14 --limit 20 --format json
```

### Priority 2: Engineering, science and analysis

```bash
# Norwegian
... search -q "ingeniør" -l area --jobage 14 --limit 20 --format json
... search -q "sivilingeniør" -l area --jobage 14 --limit 20 --format json
... search -q "prosjektleder" -l area --jobage 14 --limit 20 --format json
... search -q "rådgiver" -l area --jobage 14 --limit 20 --format json
... search -q "analytiker" -l area --jobage 14 --limit 20 --format json
# English
... search -q "engineer" -l area --jobage 14 --limit 20 --format json
... search -q "project manager" -l area --jobage 14 --limit 20 --format json
... search -q "analyst" -l area --jobage 14 --limit 20 --format json
... search -q "researcher" -l area --jobage 14 --limit 20 --format json
```

### Priority 3: Public sector, research and education

Jobbnorge and Webcruiter carry most of these.

```bash
... search -q "stipendiat" -l area --jobage 14 --limit 20 --format json
... search -q "postdoc" -l area --jobage 14 --limit 20 --format json
... search -q "forsker" -l area --jobage 14 --limit 20 --format json
... search -q "seniorrådgiver" -l area --jobage 14 --limit 20 --format json
... search -q "saksbehandler" -l area --jobage 14 --limit 20 --format json
... search -q "PhD" -l area --jobage 14 --limit 20 --format json
```

### Priority 4: Adjacent and broader technical roles

```bash
... search -q "devops" -l area --jobage 14 --limit 20 --format json
... search -q "systemutvikler" -l area --jobage 14 --limit 20 --format json
... search -q "forretningsutvikler" -l area --jobage 14 --limit 20 --format json
... search -q "teknisk konsulent" -l area --jobage 14 --limit 20 --format json
... search -q "IT-konsulent" -l area --jobage 14 --limit 20 --format json
... search -q "technical consultant" -l area --jobage 14 --limit 20 --format json
```

## WebSearch Fallback

Use only for portals without a working CLI, a CLI failure, or company career pages. Keep the location term in every query.

```text
site:arbeidsplassen.nav.no "utvikler" Trondheim
site:jobbnorge.no "rådgiver" Trondheim
site:finnoppdrag.no OR site:finn.no/job "utvikler" Trondheim
site:linkedin.com/jobs "software engineer" "Trondheim"
site:careers.nordicsemi.com Trondheim
site:karriere.hent.no Trondheim
```

FINN.no is **not** scraped by a CLI: its robots.txt prohibits automated crawling. Use the FINN saved-search email alerts instead, and do not add a FINN CLI without written permission.

## Language and Date Filters

- Language: apply `04-job-evaluation.md`'s Language Gate. Postings requiring a language not declared in `CLAUDE.md` are excluded; a higher level than declared is flagged, not excluded.
- Date: include postings from the last 14 days or with a future deadline. If the portal returns no date (Jobbnorge currently returns `date: null`), include the result and flag it as "date unknown".
- Deduplication: every skill normalises `company` to `job_scraper/employers.csv`'s registry `name`; `scrape_state.py` then drops the same title+company found on two sources.
