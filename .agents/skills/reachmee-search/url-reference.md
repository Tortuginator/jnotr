# ReachMee URL Reference

Verified live on **6 November 2026** against the Trondheim employers in
`job_scraper/employers.csv`.

> **Access note.** None of the ReachMee hosts used here serves a useful
> `robots.txt` (`web103.reachmee.com`, `web106.reachmee.com` and the Attract
> hosts return `404`), so there is no robots rule to rely on. Keep request
> volume low, do not use the data commercially or for bulk collection, and
> review ReachMee's and each employer's terms before running the skill.

## What changed from the plan

The plan's assumed pattern:

```
https://webNNN.reachmee.com/ext/<I-code>/<customer>/main?site=<n>
```

is **stale for the registry seed URLs**. Verified on 6 Nov 2026:

| URL | Status |
|-----|--------|
| `https://web103.reachmee.com/ext/I003/475` | 404 |
| `https://web103.reachmee.com/ext/I003/475/main` | 404 |
| `https://web103.reachmee.com/ext/I003/475/main?site=1` | 404 |
| `https://web103.reachmee.com/ext/I010/2617` | 404 |
| `https://web103.reachmee.com/ext/I017/653` | 404 |
| `https://web106.reachmee.com/ext/I002/1338` | 404 |
| `https://web103.reachmee.com/ext/I010/2581` | 404 |

The public ext list works only when the request also carries a
`validator`:

```
GET https://web103.reachmee.com/ext/I010/2581/main?site=6&lang=NO&validator=<32-hex>
```

Without `validator` the same URL is 404. The validator is stable per
customer/site and is published on the employer's career page, usually on a
subscribe/profile link.

## Working pattern 1 — legacy ext list

```
https://<web-host>/ext/<I-code>/<customer>/main?site=<n>&lang=<NO|SE|UK|FI>&validator=<hex>
```

Examples verified with jobs:

| Employer | List URL | Jobs |
|----------|----------|------|
| Asplan Viak | `https://web103.reachmee.com/ext/I010/2581/main?site=6&lang=NO&validator=bb6acbf35f424f0ddb47918d102863c3` | 15 |
| SalMar | `https://web103.reachmee.com/ext/I022/2242/main?site=6&lang=NO&validator=2da9a471bf4758e78b0ab248449754f8` | 5 |
| REMA 1000 | `https://web103.reachmee.com/ext/I011/1065/main?site=6&lang=NO&validator=10f8ac76f15040c270dffcf67a4c8f88` | many |
| Ocean Installer | `https://web103.reachmee.com/ext/I012/2348/main?site=6&lang=UK&validator=d954ced607940bbd8f44d1928c6d0bfb` | 7 |

The list is server-rendered as a table:

```html
<table class="... jobsTableClass" id="jobsTable">
  <thead><tr><th>Stilling</th><th>Sted</th><th>Søknadsfrist</th></tr></thead>
  <tbody>
    <tr>
      <td><a href='https://web103.reachmee.com/ext/I010/2581/job?site=6&lang=NO&validator=...&job_id=215'>Title</a></td>
      <td>Oslo</td>
      <td><span data-order="2026-11-10" style="display:none">2026-11-10</span> 10.11.2026</td>
    </tr>
  </tbody>
</table>
```

Column headers vary by customer. The parser maps, in any order:

| Meaning | Header examples |
|---------|-----------------|
| Title | `Stilling`, `Jobb`, `Jobbrubrik`, `Befattning`, `Tjänst`, `Title`, `Toimeksiannot` |
| Location | `Sted`, `Ort`, `City`, `Plats`, `Location`, `Arbeidssted`, `Paikkakunta`, `Geographical area`, `Region` |
| Published date | `Publicerad`, `Published`, `Publisert`, `Publiceringsdatum` |
| Deadline | `Søknadsfrist`, `Sista ansökningsdag`, `Application deadline`, `Viimeinen hakupäivämäärä`, `Publish to date` |

If there is no published-date column (Asplan Viak, SalMar, REMA), `date` is
`null`; the deadline is not substituted because `--jobage` is defined on the
posting date.

If there is no location column, the parser falls back to the first
non-title, non-date cell. If that is empty too, `location` is `null`.

## Working pattern 2 — Attract career site

```
https://<slug>.attract.reachmee.com/jobs
```

Verified live:

| Site | Status | Jobs |
|------|--------|------|
| `https://sweco.attract.reachmee.com/jobs` | 200 | 86 |
| `https://nina.attract.reachmee.com/jobs` | 200 | 0 |

Server-rendered list structure:

```html
<section class="at-jobs-block">
  <ul class="at-jobs-list">
    <li class="at-jobs-list-item at-joblist-header">
      <div class="at-jobs-list-cell-40"><h5 title="Tjänst">Tjänst</h5></div>
      <div class="at-jobs-list-cell-30"><h5 title="Sista ansökningsdag">Sista ansökningsdag</h5></div>
      ...
    </li>
    <li class="at-jobs-list-item">
      <div class="at-jobs-list-cell-40">
        <h6 class="at-job-title"><a href="https://sweco.attract.reachmee.com/jobs/25705-...">Title</a></h6>
      </div>
      <div class="at-jobs-list-cell-30">2027-01-19</div>
      ...
    </li>
  </ul>
</section>
```

The header labels are read from each `<h5 title="...">`; the same header
mapping is used. Attract lists frequently omit location (Sweco's does), so
`location` is `null` there.

Attract detail page:

```
GET https://<slug>.attract.reachmee.com/jobs/<id>-<slug>
```

| Content | Anchor |
|---------|--------|
| Title | `article.at-job-details header h2` |
| Location | `span.at-location` |
| Department | `span.at-department` |
| Deadline | `span.at-application-date` |
| Description | `div.at-job-body` |

## Registry `ats_ref` forms

| Form | Example | Handling |
|------|---------|----------|
| Ext URL with validator | `.../main?site=6&lang=NO&validator=...` | Used directly |
| Ext URL without validator | `https://web103.reachmee.com/ext/I010/2581` | Discover validator |
| Ext URL with stale customer | `https://web103.reachmee.com/ext/I003/475` | Try Attract, then career page; error if neither works |
| Host only | `https://web103.reachmee.com` | Discover from website/Attract/career page |
| Attract site | `https://nina.attract.reachmee.com` | Fetch `<base>/jobs` |

Discovery order for an incomplete ref:

1. If the ref is an Attract host, use `<base>/jobs`.
2. If `ats_ref` already has a validator, use the ext `/main` URL.
3. Try `https://<website-slug>.attract.reachmee.com/jobs`, where the slug is
   the first label of the registry `website` after stripping `www.`
   (`www.sweco.no` → `sweco`; `www.nina.no` → `nina`).
4. Fetch the registry `career_url` and read every ReachMee link from it.
   A subscribe/profile link is enough because it carries `validator`, `site`
   and `lang`, which the skill reuses for `/main`.
5. If none works, record `{employer, error}` in `meta.errors`.

Verified discovery on 6 Nov 2026:

| Employer | Seed `ats_ref` | Result |
|----------|----------------|--------|
| SWECO NORGE AS | `https://web103.reachmee.com/ext/I017/653` | `sweco.attract.reachmee.com` (86 jobs) |
| STIFTELSEN NINA | `https://nina.attract.reachmee.com` | Attract site (0 jobs) |
| ASPLAN VIAK AS | `https://web103.reachmee.com/ext/I010/2581` | validator found on `asplanviak.no/karriere/` |
| BRAVIDA NORGE AS | `https://web103.reachmee.com/ext/I003/475` | no Attract site, no ReachMee link on career page → error |
| BOUVET NORGE AS | `https://web106.reachmee.com/ext/I002/1338` | no Attract site and no `career_url` → error |
| SCALE AQUACULTURE AS | `https://web103.reachmee.com/ext/I010/2617` | no Attract site; career page uses Talentech → error |
| HEMIT/others | — | not `ats=reachmee` |

## Detail page — legacy ext

```
GET https://web103.reachmee.com/ext/I010/2581/job?site=6&lang=NO&validator=<hex>&job_id=215
```

| Content | Anchor |
|---------|--------|
| Title | `h1#jobad-heading` (fallback `og:title`) |
| Company | `<title>` prefix before `|` (e.g. `Asplan Viak AS | ...`) |
| Location | `p.extid` |
| Description | `div.jobad-body` |
| Deadline | `Sista ansökningsdag` / `Søknadsfrist` text if present |

## Failure behaviour

- `404` on a list URL is recorded per employer in `meta.errors` (the seed
  `ats_ref` is stale or lacks a validator).
- `404` on a detail URL exits 1 with `NOT_FOUND`.
- `429`/`5xx` and network errors retry with exponential backoff and jitter, up
  to six times.
- A failing employer never fails the whole search run.
