# SAP SuccessFactors assessment — Trondheim round 2

Research date: 6 Nov 2026. Scope: the seven new SuccessFactors rows in
`trondheim-patches/employers.seed.set2.csv` plus the seven existing
SuccessFactors rows in `job_scraper/employers.csv`. No registry or code changes.

Method: `python3 tools/fetch_page.py` (robots-enforced, browser-header retry,
no WAF bypass), the public NAV Arbeidsplassen search API
(`https://arbeidsplassen.nav.no/stillinger/api/search?q=...`), the
`jobbnorge-search` CLI, and WebSearch only for URLs that were unreachable.
`NAV_API_TOKEN` is not set, so the `nav-search` feed CLI was not run; the public
Arbeidsplassen search HTML/API was used instead.

## Result table

| Employer | ATS | Public feed URL | robots / terms | NAV / Jobbnorge evidence | Recommendation |
|---|---|---|---|---|---|
| STATSFORVALTEREN I TRØNDELAG | SuccessFactors (SAP HR Cloud, `dfohr3810`) | `https://dfohr3810.jobs.hr.cloud.sap/search/` (HTML only) | robots allows `/search/`; disallows `/services/`; `/search/` returned WAF 403 | NAV 2 ads, 1 in area (Juridisk rådgiver, Trondheim/Steinkjer), medium=`sap`; Jobbnorge 0 current (LinkedIn says they use Jobbnorge employer 1826) | RELY ON NAV/JOBNORGE |
| MATTILSYNET | SuccessFactors (SAP HR Cloud, `dfohr3940`) | `https://dfohr3940.jobs.hr.cloud.sap/search/` (HTML only) | same robots; `/search/` returned WAF 403 | NAV 10 active, none in area today, medium=`sap`; a Malvik control-technician ad (deadline 30.10.2026) shows area roles are published; Jobbnorge 0 | RELY ON NAV |
| FISKERIDIREKTORATET | **Not SuccessFactors** — applications go to ContactRH | none (career host `jobb.fiskeridir.no` did not respond; no SF feed) | career host transport error; no robots result | NAV 1 active (Bergen), medium=`sap`; ad `applicationUrl` is `https://direktoratet-for-forvaltn.contactrh.com/jobs/14035/...`; Jobbnorge 0 | RELY ON NAV; correct the registry label |
| FELLESKJØPET AGRI SA | SuccessFactors CSB (brand `FKA`) | `https://karriere.felleskjopet.no/FKA/search/` (HTML, 20 jobs) | robots allows `/FKA/search/`; disallows `/services/`; 200 OK | NAV 16 ads, 1 in area (Produktsjef I-Mek, Trondheim), medium=`FINN`; Jobbnorge 0 | RELY ON NAV (see FINN caveat) |
| LERØY SEAFOOD GROUP ASA | SuccessFactors CSB (`career55.sapsf.eu`) | `https://careers.leroyseafood.com/search/` (HTML, 4 jobs) | robots allows `/search/`; disallows `/services/`; WAF 403 after first requests | NAV 1 (Kjøllefjord); the SF-only Trondheim job “Sjåfør/Pakkeoperatør” (deadline 20.11.2026) is absent from NAV and Jobbnorge | BLOCKED / no stable public access |
| VOITH HYDRO AS | SuccessFactors CSB (`career5.successfactors.eu`, `companyId=VOITH`) | `https://jobs.voith.com/search/` (HTML only) | robots allows `/search/`; disallows `/services/`; WAF 403 | NAV 3 ads (Gamle Fredrikstad), matching the SF list; Jobbnorge 0 | RELY ON NAV |
| FELLESKJØPET FORUTVIKLING AS | SuccessFactors CSB, same `FKA` site as Felleskjøpet Agri | `https://karriere.felleskjopet.no/FKA/search/` | same as Felleskjøpet Agri | No separate ads; group vacancies appear under Felleskjøpet; NAV 0 exact, Jobbnorge 0 | RELY ON NAV/JOBNORGE |
| TINE SA | SuccessFactors CSB (`career55.sapsf.eu`) | `https://careers.tine.no/search/` (HTML, 22 jobs) | robots allows `/search/`; disallows `/services/`; 200 OK | NAV 21 ads, incl. Distriktssjef Trøndelag (Heimdal); Jobbnorge 0 | RELY ON NAV |
| ARBEIDSTILSYNET | SuccessFactors CSB (`dfohr1960.jobs.hr.cloud.sap`) | `https://jobb.arbeidstilsynet.no/search/` (HTML only) | robots allows `/search/`; disallows `/services/`; WAF 403 | NAV 1 in area (Seniorrådgivere seksjon regelverk, Trondheim); Jobbnorge 0 | RELY ON NAV |
| DNB BANK ASA | SuccessFactors CSB (`career2.successfactors.eu`) | `https://jobb.dnb.no/search/` (HTML only) | robots allows `/search/`; disallows `/services/`; WAF 403 | NAV 4 ads, none in area; Jobbnorge 0 | RELY ON NAV |
| ORKLA SNACKS NORGE AS | SuccessFactors CSB (`career5.successfactors.eu`) | `https://careers.orkla.com/search/` (HTML only) | robots allows `/search/`; disallows `/services/`; WAF 403 | NAV 10 Orkla-group ads, none in area; Jobbnorge 0 | RELY ON NAV |
| DIREKTORATET FOR FORVALTNING OG ØKONOMISTYRING | SuccessFactors CSB (`dfohr1000.jobs.hr.cloud.sap`) | `https://karriere.dfo.no/search/` (HTML only) | robots allows `/search/`; disallows `/services/`; WAF 403 | NAV 4 ads, none in area; Jobbnorge 0 | RELY ON NAV |
| AVARN SECURITY AS | SuccessFactors CSB (`career2.successfactors.eu`) | `https://jobs.avarnsecurity.com/search/` (HTML only) | robots allows `/search/`; disallows `/services/`; WAF 403 | NAV 22 ads, 2 in area (Trondheim legevakt; Stjørdal airport); Jobbnorge 0 | RELY ON NAV |
| GJENSIDIGE FORSIKRING ASA | SuccessFactors CSB (`career5.successfactors.eu`) | `https://jobs.gjensidige.com/search/` (HTML only) | robots allows `/search/`; disallows `/services/`; WAF 403 | NAV 14 ads, 1 in area (Trondheim); Jobbnorge 0 | RELY ON NAV |

Counts: 14 rows, 13 distinct career sites (the two Felleskjøpet entities share
`FKA`). Recommendations: RELY ON NAV/JOBNORGE 13/14; BLOCKED 1/14 (Lerøy);
BUILD 0/14.

## What the SuccessFactors sites expose

Every SF host uses the same Career Site Builder robots policy:

```
User-agent: *
Disallow: /applybutton/
Disallow: /talentcommunity/
Disallow: /mobile/talentcommunity/
Disallow: /emailsubscribe/
Disallow: /email/image/
Disallow: /services/
Disallow: /preapply/
Disallow: /error
Disallow: /unsubscribe/
Disallow: /reset/
```

- `/search/` and `/job/...` are robots-allowed and server-render the job list on
  TINE and Felleskjøpet.
- The machine-readable CSB feed (`/services/recruiting/v1/jobs`) and any
  `/services/...` RSS/JSON endpoint are **disallowed** on every SF host. No
  permitted JSON or RSS feed was found: `/search/rss` and `?rss=true` returned
  the HTML search page on Lerøy, Felleskjøpet and Voith.
- HTML result structure (verified on Lerøy and TINE):
  - `li.job-tile[data-url]` — one job
  - `a.jobTitle-link` — title and `href`
  - `#job-<id>-desktop-section-location-value` — “City, NO, postcode”
  - `#job-<id>-desktop-section-customfield2-value` — company
  - Felleskjøpet uses `a[href^="/FKA/job/"]` plus the result-count text
    “Resultater 1 – 20 fra 20”.

## WAF / bot block

After the first few requests, the SAP edge returned this on the job-list
endpoint for 10 of the 12 reachable SF hosts:

```
HTTP 403
{"error":{"status-code":"403","message":" Policy ID LNOaKPtD Block","request-id":"..."}}
```

Hosts that returned the block on `/search/`: `dfohr3810`, `dfohr3940`,
`careers.leroyseafood.com`, `jobs.voith.com`, `jobb.arbeidstilsynet.no`,
`jobb.dnb.no`, `careers.orkla.com`, `karriere.dfo.no`,
`jobs.avarnsecurity.com`, `jobs.gjensidige.com`. TINE and Felleskjøpet still
served the list during the same run. No challenge was solved and no retry past
the block was made. This is a WAF policy block, not a robots permission, so a
connector cannot rely on the endpoint without circumventing it.

## Key corrections and caveats

1. **Fiskeridirektoratet is not SuccessFactors.** The public NAV ad applies via
   `direktoratet-for-forvaltn.contactrh.com` (ContactRH), not an SF tenant. The
   seed row’s `ats=successfactors` is a mislabel. The career host
   `jobb.fiskeridir.no` also failed at transport level from this environment.
2. **The DFØ-managed state agencies share a ContactRH application front.**
   Statsforvalteren, Mattilsynet and Fiskeridirektoratet ads sampled from NAV
   all carry `applicationUrl` on `direktoratet-for-forvaltn.contactrh.com`, even
   where the public career site is SF CSB. The SF label describes the career
   site, not the application ATS.
3. **NAV coverage is good but not total.** Every operating employer except
   Lerøy has active NAV coverage (Felleskjøpet Forutvikling has no separate
   ads; the group’s ads appear under Felleskjøpet), and 6 of 14 rows have a
   current Trondheim-area ad. The only confirmed SF-only Trondheim-area job is
   Lerøy’s “Sjåfør/Pakkeoperatør”, whose site is WAF-blocked.
4. **Felleskjøpet’s NAV channel is FINN.** NAV’s public search shows the
   Felleskjøpet ads with `_source.medium = "FINN"`. The repo’s `nav-search`
   documentation says FINN ads are not included in the pam feed, so the CLI may
   miss them even though the public arbeidsplassen search shows them. This was
   not verified against the feed because `NAV_API_TOKEN` is unset.
5. **Jobbnorge is not carrying these employers now.** The `jobbnorge-search`
   CLI returned 0 area results for all 14, and 0 company matches nationally for
   the 13 SF rows. Statsforvalteren’s LinkedIn page points at Jobbnorge
   employer 1826, but the public API returned no current ads for that employer.

## Recommendation

**Do not build `successfactors-search` in this round.** The connector would
cover 13/14 rows on paper, but:

- the only robots-permitted read path is HTML `/search/`;
- the JSON/RSS path under `/services/` is disallowed;
- 10 of 12 reachable job-list endpoints returned a WAF 403, and bypassing it is
  out of scope;
- NAV already carries 13/14 rows, and Jobbnorge adds nothing today;
- the one confirmed SF-only Trondheim job (Lerøy) is on a blocked host.

If the WAF policy changes or a permitted feed appears, these are the base URLs
that would go in `ats_ref` (append `/search/` for the list):

```
STATSFORVALTEREN I TRØNDELAG        https://dfohr3810.jobs.hr.cloud.sap
MATTILSYNET                         https://dfohr3940.jobs.hr.cloud.sap
FELLESKJØPET AGRI SA                https://karriere.felleskjopet.no/FKA
FELLESKJØPET FORUTVIKLING AS        https://karriere.felleskjopet.no/FKA
LERØY SEAFOOD GROUP ASA             https://careers.leroyseafood.com
VOITH HYDRO AS                      https://jobs.voith.com
TINE SA                             https://careers.tine.no
ARBEIDSTILSYNET                     https://jobb.arbeidstilsynet.no
DNB BANK ASA                        https://jobb.dnb.no
ORKLA SNACKS NORGE AS               https://careers.orkla.com
DIREKTORATET FOR FORVALTNING ...    https://karriere.dfo.no
AVARN SECURITY AS                   https://jobs.avarnsecurity.com
GJENSIDIGE FORSIKRING ASA           https://jobs.gjensidige.com
```

Fiskeridirektoratet should not receive an SF `ats_ref`; it belongs on
ContactRH/`ats=none` and is covered by NAV.
