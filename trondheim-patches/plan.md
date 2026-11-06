# Trondheim job search: implementation plan for ai-job-search

Nov 6, 2026 · @Felix

## Goal and scope

Extend a personal fork of [ai-job-search](https://github.com/MadsLorentzen/ai-job-search) (checked at commit `2562379`, 5 Nov 2026) so that `/scrape` finds jobs in the Trondheim area from Norwegian job boards and directly from the career sites of the largest local employers, then ranks them against the CV with the existing `/rank`.

**In scope**

- Three to four Norwegian portal skills: NAV Arbeidsplassen, Jobbnorge, FINN.no (gated on terms), Karrierestart.no (optional).
- An employer registry of Trondheim employers with 50+ staff, built from the Brønnøysund register, with each employer's career site and recruitment system.
- Recruitment-system (ATS) skills that read jobs for every registry employer on that system: Teamtailor, Webcruiter and ReachMee first; SmartRecruiters and HR Manager next.
- Wiring into `/scrape`: permissions, search queries, location defaults, health check.

**Out of scope**

- Auto-applying, logging into portals, or bypassing bot protection.
- Changes to the profile, `/rank`, `/apply` or other framework methodology.
- Pull requests to upstream. Repo policy keeps market-specific skills in forks.

**Done means**

1. One `/scrape` run returns jobs located in the Trondheim commute area from at least NAV, Jobbnorge and the Teamtailor, Webcruiter and ReachMee connectors.
2. The same job found on two sources is shown once.
3. Every new CLI passes its own live smoke test and the fork's CI (`cli-checks`, `security_guards`).
4. The registry can be rebuilt with one command and covers at least the 150 largest employers.

## Rules every agent must follow

Every new source is a **portal skill** under `.agents/skills/<name>/`, built to the contract in `.claude/commands/add-portal.md`. `/scrape` discovers any `SKILL.md` there automatically, so no orchestration code changes. Read `add-portal.md` and the reference implementation `.agents/skills/linkedin-search/` before writing code.

| Rule | Where it is defined |
| --- | --- |
| Layout: `SKILL.md`, `url-reference.md`, `cli/` with `src/cli.ts`, `src/helpers.ts`, `src/commands/{search,detail}.ts`, `tests/` | add-portal.md, Step 3 |
| Commands `search` and \`detail \<id | url>` ; flags  `-q/--query` ,  `--jobage` ,  `--page` ,  `--limit` ,  `--format json |
| JSON `{meta:{count,page}, results:[…]}`; each result has `id, title, company, location, date, url`, nulls never omitted | add-portal.md, contract |
| Errors as JSON on stderr, exit 1 | add-portal.md, contract |
| Honest User-Agent `Mozilla/5.0 (compatible; <portal>-cli/1.0)`; backoff with jitter on 429/5xx; robots.txt respected | add-portal.md; `tools/robots_check.py` |
| `visibleHtml` and `stripInvisible` on all third-party text | linkedin-search `helpers.ts` |
| Zero runtime dependencies (Bun + fetch + regex) | add-portal.md |
| Credentials only from an env var `<SERVICE>_API_TOKEN`; missing → `MISSING_CREDENTIALS` | add-portal.md, contract |
| Register: add `Bash(bun run .agents/skills/<name>/cli/src/cli.ts:*)` to `.claude/settings.json` **and** `ALLOWED_PERMISSIONS` in `tools/security_guards.py` in the same commit | add-portal.md, Step 5 |
| Mandatory live test before registering: typecheck, real `search`, one `detail`, `bun run test` | add-portal.md, Step 4 |

Three more constraints from the repo:

- **Fork only.** `CONTRIBUTING.md` declines country-specific skills upstream. Check that PRs target your own fork, not upstream.
- **Framework files stay untouched where possible.** `/scrape`, `/rank`, `tools/scrape_state.py` and `tools/job_key.py` are upstream-maintained. This plan solves deduplication inside the new skills (see Architecture) so rebases stay clean.
- **Permission prompts are expected.** `.claude/settings.json` sets `ask` on edits to `.agents/**`, `tools/**` and `.claude/**`. Agents should batch their edits and tell the human to expect approvals.

## Architecture

Two kinds of skill feed the unchanged `/scrape`: **board skills** that search a whole job board, and **ATS skills** that read the job lists of every registry employer using one recruitment system. A Python tool builds the registry the ATS skills read.

### Board skills

| Skill | Source | Access | Location filter |
| --- | --- | --- | --- |
| `nav-search` | NAV Arbeidsplassen job feed (`pam-stilling-feed.nav.no/api/v1/feed`) | Bearer token in `NAV_API_TOKEN`. The feed is a change log, not a search API | Client-side, on municipality / postal code in each ad |
| `jobbnorge-search` | Jobbnorge (academia, state, hospitals) | Public site; a public API exists but is documented per employer ID. Recon decides which | Site's county/municipality filter |
| `finn-search` | FINN.no jobs | Public search pages; no API. Proceed only if robots.txt allows, with the personal-use warning | FINN location parameter |
| `karrierestart-search` (optional) | Karrierestart.no | Public pages | To be found in recon |

`nav-search` needs one extra command beyond the contract: `sync` pulls new feed pages since the last cursor into a local cache under `job_scraper/` (git-ignored user data). `search` then queries that cache, so `/scrape` stays fast and NAV sees one incremental pull per run.

### Employer registry

A user-owned file `job_scraper/employers.csv`, one row per employer. ATS skills read it; nothing else writes it except the registry tool.

| Column | Example | Notes |
| --- | --- | --- |
| `orgnr` | 942110464 | Top-level organisation number |
| `name` | Trondheim kommune | Display name, used as `company` in results |
| `aliases` | TRONDHEIM KOMMUNE HELSE OG VELFERD | Pipe-separated register names, for matching |
| `trd_staff` | 14838 | Employees at Trondheim local units |
| `nace` | 84.110 | Industry code, for filtering by field |
| `website`, `career_url` | trondheim.kommune.no |  |
| `ats` | webcruiter | One of the ATS skill keys, or `none` |
| `ats_ref` | companylock=7254 | What the ATS skill needs: Teamtailor feed URL, Webcruiter company lock, ReachMee list URL, SmartRecruiters slug |
| `confidence` | high | high / medium / low from detection |
| `enabled` | true | User switch per employer |

The tool `tools/employer_registry.py` has six subcommands:

1. `fetch` pulls local units from the Brønnøysund API for a list of municipality numbers and a minimum headcount (defaults: `5001`, 50).
2. `rollup` groups units under their top organisation, stopping below ministries, and ranks by local headcount.
3. `merge` unions one or more curated seed files into the working registry by organisation number, preserving the values a human already set.
4. `discover` finds websites and career pages and detects the ATS from links, embedded widgets and redirects; it follows up to three job-listing pages and one apply-link hop.
5. `probe` checks vendors' public job feeds by company-name slug and keeps a hit only when the feed's company name matches.
6. `rebuild` runs `fetch`, `rollup`, `discover` and `probe` in one command.

A first version of this data already exists: `trondheim-recruitment-systems.xlsx` (150 employers, 80 with a detected system). The registry tool's first run should reproduce it, and agents can seed `employers.csv` from it.

### ATS skills

Each ATS skill obeys the same contract as a board skill. `search` iterates over enabled registry rows with its `ats` key, fetches each employer's public job list, filters by query and location, and returns one pooled `results` array. `detail` takes a posting URL.

| Skill | Read method | Registry rows (top 150) |
| --- | --- | --- |
| `teamtailor-search` | Documented public RSS `<site>/jobs.rss` (location in `tt:location`) | 17 |
| `webcruiter-search` | Public company list `candidate.webcruiter.com/.../companyadverts?companylock=<id>` | 15 |
| `reachmee-search` | Public list pages on `webNNN.reachmee.com/ext/...` | 9 |
| `smartrecruiters-search` | Public API `api.smartrecruiters.com/v1/companies/<slug>/postings` | 5 |
| `hrmanager-search` | `candidate.hr-manager.net/vacancies/list.aspx?customer=<name>` | 4 |

Jobbnorge employers are covered by `jobbnorge-search`, so they need no ATS skill. Employers on SuccessFactors, Oracle and Workday are left to the boards in this plan.

### Deduplication and Trondheim focus

The existing `scrape_state.py` drops a job whose URL or company+title was seen before. Cross-source duplicates usually share the title but not the company spelling ("TRONDHEIM KOMMUNE HELSE OG VELFERD" on NAV, "Trondheim kommune" on Webcruiter). So every new skill normalises `company` to the registry's `name`: ATS skills use the row they read; `nav-search` maps the ad's employer organisation number through `orgnr` and `aliases`. Unmatched employers keep their own name. No framework file changes.

Location is a shared setting: a commute-area list of municipalities in `job_scraper/area.json` (default Trondheim 5001, Malvik, Melhus, Skaun, Stjørdal; the human confirms the list). Skills that filter client-side read it when `--location` is `area`; `/scrape` passes `--location Trondheim` or `area` per `search-queries.md`.

&#91;embedded content: architecture · 3 board skills, registry, ATS skills, unchanged /scrape\]

Everything in the middle column is new; the right column is the existing workflow, used as is.

## Work packages

Ten packages, each sized for one agent session and one pull request to the fork. Each lists its files, tasks and the test that closes it.

### WP0 Fork baseline

Files: none new. Owner needs: the fork, Bun, Python 3.10+.

- [ ] Fork, clone, run `/setup` far enough that `CLAUDE.md` holds the real location (Trondheim) and languages (Norwegian level matters for `/rank`'s language gate).
- [ ] Install existing CLIs (`python3 tools/install_portal_clis.py`) and confirm `bun run test` passes in `linkedin-search/cli`.
- [ ] Set `enabled: false` in the four Danish portal skills' frontmatter.
- [ ] Add `job_scraper/area.json` with the commute municipalities (human confirms).

Done when: `/scrape` runs with only LinkedIn (location Trondheim) and returns results.

### WP1 `nav-search`

Files: `.agents/skills/nav-search/**`.

- [ ] Recon per add-portal Step 2 on the [NAV feed docs](https://navikt.github.io/pam-stilling-feed): token flow, feed paging, ad detail endpoint, which fields carry municipality, postal code and employer organisation number. Write all of it into `url-reference.md`.
- [ ] Human registers for a token (email to NAV, accept API terms) and exports `NAV_API_TOKEN`.
- [ ] Implement `sync` (incremental, cursor stored in `job_scraper/nav_feed_state.json`, cache in `job_scraper/nav_cache.jsonl`, active ads only), `search` over the cache with `--location <name|area>`, `--jobage`, `-q` matched on title and description, and `detail <id>`.
- [ ] Map employer organisation number to registry `name` when `job_scraper/employers.csv` exists.

Done when: after `sync`, `search -q utvikler -l area --limit 5` returns ads located in the area with non-null fields, `detail` prints readable text, missing token exits 1 with `MISSING_CREDENTIALS`.

### WP2 `jobbnorge-search`

Files: `.agents/skills/jobbnorge-search/**`.

- [ ] Recon: decide between the public API (check whether it searches without an employer ID) and the public search pages; record county and municipality filter values for Trøndelag and Trondheim.
- [ ] Implement `search` with `-q`, `-l`, `--jobage`, and `detail`.

Done when: a search for `rådgiver` in Trondheim returns NTNU or state-agency jobs with valid URLs; `detail` works.

### WP3 `finn-search` (gated)

Files: `.agents/skills/finn-search/**`.

- [ ] Run `python3 tools/robots_check.py` on FINN's job search and ad paths and read FINN's terms. Report to the human and **stop** unless they decide to proceed.
- [ ] If they proceed: implement per contract with the personal-use warning copied in tone from `linkedin-search`, low default `--limit`, location parameter for Trondheim.

Done when: either a written decision not to build it, or a passing live test.

### WP4 `karrierestart-search` (optional)

Same steps as WP2. Build only if the human is early-career or WP3 is declined.

### WP5 Employer registry tool

Files: `tools/employer_registry.py`, `tests/test_employer_registry.py`, `job_scraper/employers.csv` (user data, git-ignored like other `job_scraper/` state).

- [ ] Implement `fetch`, `rollup`, `discover`, `probe` as described in Architecture; honest User-Agent; robots.txt respected; never retry past a bot-verification page, record it as `blocked`.
- [ ] `discover` keeps manual overrides: a column the human set (`ats`, `ats_ref`, `enabled`) is never overwritten by a re-run.
- [ ] Seed from the existing spreadsheet; the first full run must find a system for at least 75 of the top 150.
- [ ] Register the tool's commands in `.claude/settings.json` and `tools/security_guards.py`.

Done when: `python3 tools/employer_registry.py fetch rollup discover probe --top 150` rebuilds the CSV, tests pass offline against recorded fixtures.

### WP6 `teamtailor-search`

Files: `.agents/skills/teamtailor-search/**`.

- [ ] Read registry rows with `ats=teamtailor`; fetch each `jobs.rss` (paginate with `offset` and `per_page`); parse `tt:location` city and country; filter by `-q` and `-l`; `company` = registry `name`.
- [ ] Concurrency of at most 4 feeds at a time; one failing feed is reported in `meta.errors` and does not fail the run.

Done when: a search with `-l area` returns Trondheim jobs from at least Nordic Semiconductor, Hent and Norsk Helsenett.

### WP7 `webcruiter-search` and `reachmee-search`

One PR per skill, same pattern as WP6, each with its own recon of the list page markup and its detail page. Webcruiter covers Trondheim kommune, St. Olavs and Trøndelag fylkeskommune, so its test must show jobs from at least two of those.

### WP8 `smartrecruiters-search` and `hrmanager-search`

Small follow-ups once WP6 and WP7 have settled the shared pattern. SmartRecruiters uses its public JSON API.

### WP9 Wiring and end-to-end check

Files: `.claude/skills/job-scraper/search-queries.md`, `.claude/settings.json`, `tools/security_guards.py`, fork README.

- [ ] Replace placeholder queries with Norwegian and English role terms from the profile, location Trondheim / `area`.
- [ ] Confirm every new skill is in both permission lists; CI green.
- [ ] Run `/scrape`, then `/scrape health`. Check that a job posted on both NAV and Webcruiter appears once.
- [ ] Document the weekly routine in the fork README: `nav-search sync`, `/scrape`, quarterly registry rebuild.

Done when: all four "Done means" criteria in Goal and scope hold.

## Sequencing and hand-off

WP0 comes first; then three agents can work in parallel on WP1, WP2 and WP5. ATS skills start once WP5 has fixed the registry columns. WP9 closes the plan.

| Wave | Packages | Starts when |
| --- | --- | --- |
| 1 | WP0 | now |
| 2 | WP1, WP2, WP5 in parallel; WP3 recon | WP0 merged |
| 3 | WP6, then WP7 and WP8 in parallel | WP5's CSV columns merged (the tool itself may still be in progress) |
| 3 | WP3 build, WP4 | human decisions recorded |
| 4 | WP9 | WP1, WP2, WP6 and WP7 merged |

**Hand-off rules for agents**

1. One package per branch and PR, named `wp<N>-<skill>`, targeting the fork's `main`. Conventional Commit titles (`feat: add nav-search portal skill`).
2. Start by reading this plan, `add-portal.md` and `linkedin-search`. Do not reread or rewrite other packages' code.
3. Recon findings go into the skill's `url-reference.md` before any parser code.
4. A package is done only when its "Done when" test passes live and CI is green. Paste the live test output into the PR description.
5. Anything that needs the human (token, terms decision, municipality list, approvals) is asked once, up front, as a short list. Do not guess past it.
6. If a source's markup or terms differ from this plan, update `url-reference.md` and leave a comment on the matching section of this doc rather than silently changing scope.
7. Never commit `job_scraper/` contents, tokens or the populated profile.

## Risks and open questions

| Risk | Effect | Mitigation |
| --- | --- | --- |
| FINN's terms or robots.txt forbid automated access | No direct FINN coverage | WP3 is gated; NAV and the ATS skills cover most of the same employers. Fallback: FINN saved-search email alerts, read by a small new command modelled on `/gmail-sync` (which today only tracks application status) |
| NAV token not granted, or feed lacks location fields | WP1 blocked | Register on day one; WP2 and WP5 do not depend on it |
| Employer sites behind bot verification (9 of the top 150, e.g. SINTEF, Bane NOR, Kongsberg) | No direct read | Never bypass. Mark `blocked` in the registry; rely on boards |
| Career-site markup changes | Connector returns zero or junk | Existing `/scrape health` check flags degraded portals; `url-reference.md` records anchors |
| Registry goes stale (new ATS, mergers) | Missed jobs | Quarterly `employer_registry.py` rebuild; manual overrides survive re-runs |
| Teamtailor or ReachMee feeds are group-wide (e.g. Securitas, Møller) | Jobs from other countries | Filter by `tt:location` country and city; registry `confidence` marks doubtful rows |
| Upstream changes to `/scrape` or the contract | Merge conflicts | Framework files untouched; run `tools/check_upstream_updates.py` before each wave |

**Open questions for the human** (answer before wave 2)

- [ ] Which municipalities form the commute area?
- [ ] Which fields or industries should the registry keep? Filtering the 150 by industry code cuts connector runs and noise.
- [ ] Build FINN after reading its terms, or rely on email alerts?
- [ ] Is Karrierestart worth it (early-career roles)?
- [ ] Who registers the NAV token, and under which email?

## Appendix: inputs and reference endpoints

**Data handed to agents**

| File | Contents | Use |
| --- | --- | --- |
| `employers.seed.csv` | 150 employers in the registry schema; `ats` set for 80; `ats_ref` filled where the sweep found it; 27 rows with a system but no `ats_ref` yet | Copy to `job_scraper/employers.csv` to unblock WP6–WP8 before WP5 finishes |
| `trondheim-recruitment-systems.xlsx` | Same 150 with evidence links, confidence and notes | Human review; WP5's regression target |

Both were built on 6 Nov 2026 from the Brønnøysund register (local units in Trondheim with 50+ staff: 634 units, 365 organisations) and a crawl of employer websites that did not pass bot checks.

**Endpoints**

| Source | Endpoint | Notes |
| --- | --- | --- |
| Brønnøysund units | `https://data.brreg.no/enhetsregisteret/api/underenheter?kommunenummer=5001&fraAntallAnsatte=50` | Open, no key; `size`/`page` paging; parent in `overordnetEnhet` |
| Brønnøysund entities | `https://data.brreg.no/enhetsregisteret/api/enheter/<orgnr>` | Website in `hjemmeside` (missing for about 40% of large employers) |
| NAV job feed | `https://pam-stilling-feed.nav.no/api/v1/feed` | Bearer token; excludes FINN ads; [docs](https://navikt.github.io/pam-stilling-feed) |
| Teamtailor | `https://<slug>.teamtailor.com/jobs.rss?offset=0&per_page=100` | Public, [documented](https://support.teamtailor.com/en/articles/11171756-rss-feed-how-to-guide); custom domains serve the same path |
| Webcruiter | `https://candidate.webcruiter.com/nb-no/Home/companyadverts?companylock=<id>` | Public page; markup to be mapped in WP7 recon |
| ReachMee | `https://webNNN.reachmee.com/ext/<I-code>/<customer>/main?site=<n>` | Public pages; per-customer codes in registry |
| SmartRecruiters | `https://api.smartrecruiters.com/v1/companies/<slug>/postings` | Public JSON |
| HR Manager | `https://candidate.hr-manager.net/vacancies/list.aspx?customer=<name>` | Public page |
| Jobbnorge | `https://www.jobbnorge.no/search` | Public; API terms to confirm in WP2 |

Codes for the commute area (verify in WP0): Trondheim 5001, Malvik 5031, Melhus 5028, Skaun 5029, Stjørdal 5035.

## Build record (6 Nov 2026)

This section records what landed after the implementation and two independent validation passes. It does not change the plan above.

### Status

| Package | Status | Notes |
| --- | --- | --- |
| WP0 fork baseline | Done | `CLAUDE.md` location is Trondheim; Danish portals are `enabled: false`; `job_scraper/area.json` covers 5001, 5031, 5028, 5029, 5035. |
| WP1 `nav-search` | Done | Feed sync/caching, area filter, detail enrichment (`--details-limit`), `MISSING_CREDENTIALS`. Verified live with NAV's rotating public token. |
| WP2 `jobbnorge-search` | Done | Public API search/detail; area = five municipalities. `date` is null because the API has no publication date; `--jobage` maps to `period`. |
| WP3 `finn-search` | Not built (decision) | FINN's robots notice and terms prohibit automated crawling without written permission. Use FINN saved-search email alerts instead. |
| WP4 `karrierestart-search` | Not built (optional) | Optional early-career portal; no skill added. |
| WP5 employer registry | Done | `fetch`, `rollup`, `discover`, `probe`, plus one-command `rebuild`. 150-row committed seed; 167-row local working registry with aliases. |
| WP6 `teamtailor-search` | Done | Live jobs from Nordic Semiconductor, HENT and ECURA. Six registry rows still lack `ats_ref` and are reported in `meta.errors`. |
| WP7 `webcruiter-search`, `reachmee-search` | Done | Webcruiter live from Trondheim kommune and St. Olavs. ReachMee refs were refreshed; live area jobs now come from Bouvet Trondheim and Asplan Viak. |
| WP8 `smartrecruiters-search`, `hrmanager-search` | Done | Live from Sportradar/Ramboll/Sopra Steria and Sparebank 1 SMN. |
| WP9 wiring | Done | Permissions, security guards, Trondheim search queries, README routine. `/scrape` and `/scrape health` remain agent workflows rather than executables. |

### ReachMee registry refresh

The five stale ReachMee rows were resolved on 6 Nov 2026:

- Bouvet: validator-bearing `web106.reachmee.com/ext/I002/1338/main`.
- TOBB: `web103.reachmee.com/ext/I022/2124/main` (valid; currently no open ads).
- Brageva: `web103.reachmee.com/ext/I012/2435/main` (valid; currently no open ads).
- Møller Bil Trøndelag: group-wide `web106.reachmee.com/ext/I008/682/main`; filtered by location.
- Bravida: no longer serves a ReachMee list. Its public job list is now on `bravida.no`; the registry marks it `ats=none`, `status=career_site_only` and relies on NAV/boards.

Bravida's current site is not one of the ATS connectors in this plan. Adding a site-specific `bravida` connector would be a separate work package.

### Open decisions and follow-ups

1. **Webcruiter and SmartRecruiters terms.** Both public sources have robots.txt rules that disallow generic automated agents; the CLIs carry personal-use-only warnings. The human must decide whether to keep them enabled. Webcruiter carries Trondheim kommune, St. Olavs and Trøndelag fylkeskommune; NAV and Jobbnorge cover much of the same public-sector ground.
2. **NAV private token.** The experimental public token is for testing only. Register a private token by email to `nav.team.arbeidsplassen@nav.no` for the weekly routine.
3. **Profile.** `/setup` still needs the real name and language levels before `/rank` can apply the Language Gate.
4. **Dedup coverage.** NAV's feed has `orgnr: null` on almost all ads. Company normalization now uses registry names, aliases, containment and legal-suffix-aware token matching (`HF`, `AS`, `ASA`, …), so St. Olavs sub-units such as "Bildediagnostikk - Seksjon røntgenradiografer, St. Olavs hospital" collapse to `ST. OLAVS HOSPITAL HF`. Re-check other large public employers after the first real `/scrape`.
5. **NAV location precision.** The feed's `municipal` is the registered municipality; some nationwide ads list a local municipality. Treat NAV area hits as candidates, not proof of the work location.
6. **Quarterly rebuild.** Run `python3 tools/employer_registry.py rebuild`; `--preserve-seed` is the default in the rebuild command.

## Deeper ATS sweep (6 Nov 2026)

The second sweep found recruitment systems for seven previously `none` employers, bringing the seed to 86 recognised systems (87 if Bravida's former ReachMee classification is counted; Bravida itself is now `career_site_only`). The full evidence trail is in `employers.seed.additions.csv` and the updated spreadsheet.

### Additions merged

| Employer | System | `ats_ref` | Status |
| --- | --- | --- | --- |
| Norconsult | Workday | `https://norconsult.wd3.myworkdayjobs.com/Norconsult_Career_Site` | Connector: `workday-search` |
| ASKO Midt-Norge | Workday | `https://norgesgruppen.wd3.myworkdayjobs.com/karriere` | Connector: `workday-search` |
| Nortura | Visma Talent | `https://hire.vismatalent.com/spa/nb/public/careers/0ceb6ff0-777f-4216-93b6-be2d4ae34a16` | Connector: `vismatalent-search` |
| Rema Distribusjon | ReachMee | `https://web103.reachmee.com/ext/I011/1065/main?site=6&validator=10f8ac76f15040c270dffcf67a4c8f88&lang=NO` | Connector: `reachmee-search` |
| Siemens Energy | Avature | `https://jobs.siemens-energy.com/en_US/jobs` | No connector yet (`no_connector`) |
| Prima Assistanse | Done.ai | `https://prima-assistanse.no/karriere/ledige-stillinger/` | No connector yet (`no_connector`) |
| SJ Norge | CareerHub | empty (rendered portal) | No connector yet (`no_connector`) |

Manual seed values, aliases, NACE/website/career URLs and `enabled` were preserved by the merge; only `trd_staff`, `ats`, `ats_ref`, `confidence` and `status` were updated. Existing Workday employers Equinor, NG Meny and If are now covered by the same connector.

### New work packages

| Package | Status | Notes |
| --- | --- | --- |
| WP10 `workday-search` | Done | Public `POST /wday/cxs/<tenant>/<site>/jobs` search plus `GET ...<externalPath>` detail. Location facets, multi-location detail verification, 5 employers. Live: 10 area results from NG Meny, Equinor, Norconsult, SPAR. |
| WP11 `vismatalent-search` | Done | Public `GetJobList?siteGuid=` API; 1 employer today (Nortura), but this is the Webcruiter migration path. Live: 4 Nortura jobs, area 0 (all current ads are outside Trondheim). |
| WP12 registry deep discovery | Done | `discover` follows up to 3 listing pages and 1 apply link, and recognises Workday, Visma Talent, Avature/avacdn, Done.ai and CareerHub. Live re-run on the 7 additions detected 7/7. |

`workday-search` and `vismatalent-search` are registered in `.claude/settings.json` and `tools/security_guards.py`, and listed in `search-queries.md`.

### Remaining registry follow-ups

- **Siemens Energy (Avature), Prima Assistanse (Done.ai), SJ Norge (CareerHub)** have a detected system but no connector in this fork. Their rows are marked `no_connector` so nobody mistakes a detection for coverage. SJ's public CareerHub URL could not be derived; the career page is `https://sj.no/jobbe-i-sj-norge/`.
- **Bravida** is `career_site_only`; its public job list is on `bravida.no`, not ReachMee.
- **Rema** works through `reachmee-search` with the validator URL above. The `rmpage=apply` discovery signature remains a useful fallback for future rows.
- **Discover output changed:** Workday refs are now full career-site URLs (`https://host/site`), not `<tenant>/<site>`, so they can be consumed directly by `workday-search`.
- **One-command rebuild** remains `python3 tools/employer_registry.py rebuild`, now with `--listings` and `--apply-hops` controls.

## Location-filter audit (6 Nov 2026)

Two independent audits ran every portal CLI with `-l area`, specific locations, no location, and nonsense locations. They found real defects; these are now fixed:

- **Substring place matching** in `webcruiter-search`, `reachmee-search` and `vismatalent-search` let `Vennesla` match Skaun's `Venn`, `kvalifisering` match Melhus's `Kvål`, `Ryen` match Trondheim's `Rye`, and `Helle` match Stjørdal's `Hell`. Matching is now whole-token phrase matching; regression tests cover all four cases.
- **Webcruiter displayed only the first workplace** for multi-location postings (`Oslo` even when the row also covered Trondheim). It now joins all `Workplace*` fields and de-duplicates them.
- **Jobbnorge trusted the API municipality filter**, which returned Bodø and generic `Flere` rows for Trondheim queries. Search now post-filters the result's own `location` against the resolved municipality/area names and reports excluded rows in `meta.note`. Generic `Flere` rows are excluded from location-filtered runs.
- **Workday returned HTTP 400 for `--limit` above 20**, producing zero results with per-employer errors. The CXS page size is now capped at 20 and the CLI pages until `--limit` is satisfied; `--limit 21/30/100` returns the same 11 area jobs with no errors.
- **ReachMee's detail-location cap** was 30 and could silently omit later area jobs. The default is now 200 (all current unknown-location rows) and `meta.warning` reports any rows left unchecked when a lower `--location-detail-limit` is used.
- **NAV ignored `area.json` place names**. `isInArea` and specific municipality filters now match place names with whole-token matching, so Heimdal matches Trondheim, while Vennesla does not match Senn/Venn.

Re-verified live after the fixes:

- `webcruiter -q Vennesla -l area` → 0; `webcruiter -q ingeniør -l area` → 5 rows, multi-location locations include Trondheim.
- `jobbnorge -q utvikler -l area --limit 100` → only Trondheim; `-l Oslo` → only Oslo.
- `workday -l area --limit 20/21/30/100` → 11 rows, no errors.
- `reachmee -l area` → 7 Trondheim-area rows (Bouvet, Rema, Asplan Viak).
- `vismatalent -l area` → 0, correct (all current Nortura ads are outside the area).

Remaining caveats:

- **NAV source data.** The feed's `municipal` is the registered municipality. A Dedicare staffing ad tagged `STJØRDAL`/postal `7500` advertises work on Vestlandet; the filter cannot detect that from the feed. Treat NAV area hits as candidates.
- **ReachMee detail cap.** Area filtering resolves missing list locations from detail pages up to `--location-detail-limit` (default 200). The default covers the current data; if a larger feed leaves rows unchecked, `meta.warning` reports the count.
- **HR Manager null locations.** RSS rows with no extractable location are excluded from location-filtered runs; several Sparebank 1 rows currently have `location: null`.
- **Jobbnorge generic locations.** `Flere` rows are excluded from filtered runs; a detail check would be needed to admit the subset that includes the area.
- **NAV places fallback.** `nav-search` now matches municipal names/aliases, `area.json` place names (whole-token) and postal prefixes. If `area.json` is missing, its built-in fallback still covers the five municipality names only.

## Round 2 build record (6 Nov 2026)

Round 2 extends the registry and `/scrape` toward ecology, bioeconomy and sustainability roles. It does not change the historical records above.

### WP10 registry schema and merge

- Added `relevance`, `theme`, `set` and `third_party_hosts` to `job_scraper/employers.csv`, `trondheim-patches/employers.seed.csv` and `tools/employer_registry.py`. `relevance`, `theme` and `set` are preserved as human-owned values on re-runs; `third_party_hosts` is discover debug data and may be rewritten.
- Added the `merge` subcommand: it unions curated seed files into the working registry by `orgnr`, keeps non-empty base values, and can enable new rows by relevance with `--enable-relevance`.
- Merged the hand-off into the previous 167-row working registry: 342 rows in total (167 base + 175 appended; 5 of the 180 set2 rows matched existing base rows). The merge applied 7 top-150 additions and 33 relevance tags to existing rows.
- 180 rows carry a `set` tag (`next 100` or `sustainability`), of which 91 are enabled. New rows are enabled only when `relevance` is `high` or `possible`; existing top-150 rows keep their previous `enabled` values. The merged registry has 251 enabled rows.

### WP11 discover upgrades

- `discover` now follows up to 3 job-listing pages per employer (default) and one apply-link hop, so systems that appear only on a listing or apply link are still found.
- Added Heartpace (`heartpace.com`) and Jobbsys (`jobbsys.no`) signatures alongside Workday, Visma Talent, Avature/avacdn, Done.ai and CareerHub.
- Added the `third_party_hosts` debug column: it records the third-party hosts loaded by the career, listing and apply pages (sorted, capped), so unknown vendors can be spotted by hand.

### WP12 EasyCruit connector

- Built `easycruit-search` and live-tested it on Stjørdal kommune, Trøndelag brann- og redningstjeneste (TBRT) and Handelshøyskolen BI on 6 Nov 2026.
- Public read paths: `/rss` for descriptions, `/export/xml/vacancy/list.xml` for IDs, title, dates and workplace, `/export/xml/vacancy/<id>.xml` for detail, and `/vacancy/<id>/rss` for the HTML detail page. The AWS WAF challenge on the root and HTML search pages is reported, never solved or bypassed.
- Registry `ats_ref` was filled for the three EasyCruit rows (`https://stjordal.easycruit.com`, `https://tbrt.easycruit.com`, `https://bi.easycruit.com`).

### WP12 SuccessFactors assessment

- Assessed the 14 SuccessFactors rows (13 distinct career sites). NAV or Jobbnorge already carries 13/14, so no `successfactors-search` connector was built.
- Lerøy Seafood Group is the exception: its career site is WAF-blocked and its SF-only Trondheim job does not appear on NAV or Jobbnorge.
- Fiskeridirektoratet was a mislabel: its applications go to ContactRH, not SuccessFactors, and the registry now says `contactrh`.
- The SuccessFactors rows remain `no_connector` and are covered through NAV/Jobbnorge.

### WP13 search terms

- Added a Priority 2 (ecology, bioeconomy and sustainability) query category to `.claude/skills/job-scraper/search-queries.md`, in Norwegian and English, as the round-2 hand-off's starting set. It is not yet confirmed by the human.
- Noted that sustainability roles often have generic titles (`rådgiver`, `seniorrådgiver`, `prosjektleder`), so CLIs must match the query against title **and** description, not title alone.

### Data caveats

- 2 rows carry `status=missing_ats_ref` (GK Norge and Norges geologiske undersøkelse); both are intentionally disabled until a ref is verified. GK's public jobs moved to Teamtailor, and NGU's Webcruiter `companylock=102020` does not serve a working list; NAV/Jobbnorge cover both.
- I K Lykke Drift was listed in the handoff as a ReachMee employer with a `rema.no` website, but the register and the live site show it is a Bunnpris operator. It is now `ats=none`, `status=career_site_only`, website `bunnpris.no`, career page `https://www.bunnpris.no/jobb-i-bunnpris`, and disabled by the next-100 default. No ReachMee ref was invented. `merge` treats a non-empty `status` on an `ats=none` row as a lock, so a later seed re-run cannot turn it back into ReachMee.
- Bot checks are recorded as `blocked` and never retried. The merged registry has 14 such rows, 5 of them round-2 additions (Microchip, Siemens AS, FiiZK, Landbrukstjenester and Hydrogen Mem-Tech).
- 2 round-2 sites still carry `status=check_website`: Hammer Planteskole (enabled sustainability row, TLS/host failure) and Royal Flames Hammerfjell (disabled next-100 row, DNS failure).
- Aliases for the 175 appended rows are not populated yet; the 5 set2 rows that matched existing rows kept their aliases. A Brønnøysund snapshot can backfill roughly two thirds of them, but 87 appended rows are below that snapshot's staff threshold.
- Elkjøp is `enabled=false` by default, so its ReachMee feed is not read until the human enables it.
- Franzefoss Gjenvinning had zero current jobs when checked on 6 Nov 2026.
- BioMar and Salmar are reachable through their connectors but had no current jobs in the commute area on 6 Nov 2026.

### Next

- Run `/scrape` and `/scrape health` against the merged registry, then check that area filtering and cross-source dedup still hold.
- Confirm the private `NAV_API_TOKEN` for regular runs.
- Decide whether to keep Webcruiter and SmartRecruiters enabled under their personal-use terms.
- Optionally enrich aliases for the 175 appended rows from a Brønnøysund fetch.
- Rebuild quarterly with `python3 tools/employer_registry.py rebuild`, preserving seed rows and manual values.
