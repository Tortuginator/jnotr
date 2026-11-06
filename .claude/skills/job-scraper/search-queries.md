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
| `easycruit-search` | EasyCruit employers (Stjørdal kommune, Trøndelag brann- og redningstjeneste, Handelshøyskolen BI) | `-l area` or `-l <place>` (e.g. `-l Stjørdal`); `--jobage` is supported from the XML job list where available |
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

Run the top 3 priority categories by default; `/scrape broad` runs all. Write each category in Norwegian and English because the boards mix languages. The default top 3 are Priority 1 (software, data and product), Priority 2 (ecology, bioeconomy and sustainability - the round-2 focus) and Priority 3 (engineering, science and analysis); use `/scrape broad` to reach public sector and adjacent roles as well.

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

### Priority 2: Ecology, bioeconomy and sustainability

This is the starting sustainability query set from the round-2 handoff, not yet confirmed by the human. It covers ecology and biodiversity, environmental management, climate and sustainability advisory, bioeconomy and circular economy, aquaculture/fisheries, forestry and agriculture, and life-cycle analysis.

```bash
# Norwegian
... search -q "økologi" -l area --jobage 14 --limit 20 --format json
... search -q "økolog" -l area --jobage 14 --limit 20 --format json
... search -q "naturforvaltning" -l area --jobage 14 --limit 20 --format json
... search -q "naturmangfold" -l area --jobage 14 --limit 20 --format json
... search -q "miljørådgiver" -l area --jobage 14 --limit 20 --format json
... search -q "miljøkoordinator" -l area --jobage 14 --limit 20 --format json
... search -q "bærekraft" -l area --jobage 14 --limit 20 --format json
... search -q "bærekraftsrådgiver" -l area --jobage 14 --limit 20 --format json
... search -q "klimarådgiver" -l area --jobage 14 --limit 20 --format json
... search -q "bioøkonomi" -l area --jobage 14 --limit 20 --format json
... search -q "sirkulærøkonomi" -l area --jobage 14 --limit 20 --format json
... search -q "biolog" -l area --jobage 14 --limit 20 --format json
... search -q "marinbiolog" -l area --jobage 14 --limit 20 --format json
... search -q "akvakultur" -l area --jobage 14 --limit 20 --format json
... search -q "havbruk" -l area --jobage 14 --limit 20 --format json
... search -q "fiskehelse" -l area --jobage 14 --limit 20 --format json
... search -q "skogbruk" -l area --jobage 14 --limit 20 --format json
... search -q "landbruk" -l area --jobage 14 --limit 20 --format json
... search -q "vannforvaltning" -l area --jobage 14 --limit 20 --format json
... search -q "miljøovervåking" -l area --jobage 14 --limit 20 --format json
... search -q "livsløpsanalyse" -l area --jobage 14 --limit 20 --format json
# English
... search -q "ecology" -l area --jobage 14 --limit 20 --format json
... search -q "ecologist" -l area --jobage 14 --limit 20 --format json
... search -q "biodiversity" -l area --jobage 14 --limit 20 --format json
... search -q "environmental advisor" -l area --jobage 14 --limit 20 --format json
... search -q "sustainability" -l area --jobage 14 --limit 20 --format json
... search -q "ESG" -l area --jobage 14 --limit 20 --format json
... search -q "climate" -l area --jobage 14 --limit 20 --format json
... search -q "circular economy" -l area --jobage 14 --limit 20 --format json
... search -q "bioeconomy" -l area --jobage 14 --limit 20 --format json
... search -q "aquaculture" -l area --jobage 14 --limit 20 --format json
... search -q "natural resource management" -l area --jobage 14 --limit 20 --format json
... search -q "life cycle assessment" -l area --jobage 14 --limit 20 --format json
... search -q "EU taxonomy" -l area --jobage 14 --limit 20 --format json
... search -q "CSRD" -l area --jobage 14 --limit 20 --format json
```

Sustainability roles often carry generic titles (`rådgiver`, `seniorrådgiver`, `prosjektleder`), so the CLIs must match the query against title **and** description, not title alone; otherwise these terms miss most relevant postings. Use `job_scraper/employers.csv`'s `relevance`, `theme` and `set` columns to prioritise the specialist employers this category is meant to reach.

### Priority 3: Engineering, science and analysis

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

### Priority 4: Public sector, research and education

Jobbnorge and Webcruiter carry most of these.

```bash
... search -q "stipendiat" -l area --jobage 14 --limit 20 --format json
... search -q "postdoc" -l area --jobage 14 --limit 20 --format json
... search -q "forsker" -l area --jobage 14 --limit 20 --format json
... search -q "seniorrådgiver" -l area --jobage 14 --limit 20 --format json
... search -q "saksbehandler" -l area --jobage 14 --limit 20 --format json
... search -q "PhD" -l area --jobage 14 --limit 20 --format json
```

### Priority 5: Adjacent and broader technical roles

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
site:stjordal.easycruit.com "bærekraft" Stjørdal
```

FINN.no is **not** scraped by a CLI: its robots.txt prohibits automated crawling. Use the FINN saved-search email alerts instead, and do not add a FINN CLI without written permission.

## Language and Date Filters

- Language: apply `04-job-evaluation.md`'s Language Gate. Postings requiring a language not declared in `CLAUDE.md` are excluded; a higher level than declared is flagged, not excluded.
- Date: include postings from the last 14 days or with a future deadline. If the portal returns no date (Jobbnorge currently returns `date: null`), include the result and flag it as "date unknown".
- Deduplication: every skill normalises `company` to `job_scraper/employers.csv`'s registry `name`; `scrape_state.py` then drops the same title+company found on two sources.
