# Webcruiter URL Reference

Verified live on **6 November 2026** against the Trondheim employers in
`job_scraper/employers.csv`.

> **Access note.** `https://candidate.webcruiter.com/robots.txt` and every
> tenant host's `robots.txt` return `User-agent: *` / `Disallow: /`, with
> explicit `Allow` rules only for Googlebot and facebookexternalhit. This skill
> is for low-volume personal use and does not evade bot protection. Review the
> current robots.txt and Webcruiter's terms before running it.

## List endpoint

```
POST https://candidate.webcruiter.com/api/odvert/companysearch/<companySiloId>?lang=nb-NO
Content-Type: application/json
```

`<companySiloId>` is the numeric company lock (the `companylock` value on the
public page, or the numeric tenant subdomain).

Request body (verified — `take` and `pageSize` agree, and `skip` is
`(page-1) * pageSize`):

```json
{ "take": 100, "skip": 0, "page": 1, "pageSize": 100 }
```

Pagination example verified on company lock `7254`:

| `page` | `skip` | Returned ids (first three) |
|--------|--------|----------------------------|
| 1 | 0 | 5198357738, 5197874504, 5195793574 |
| 2 | 3 | 5197874504, 5195793574, 5198352346 |
| 3 | 6 | 5198352346, 5197769096, 5198920314 |

Response:

```json
{
  "Facets": { "workPlaceFacet3": [...], "jobCategory": [...], "jobTypeEn": [...] },
  "LastFilterQuery": "(companyIds/any(b: b eq '7254'))",
  "Data": [ { "Id": "...", "Heading": "...", ... } ],
  "Total": 86,
  "Aggregates": null
}
```

## Data item fields used

| Field | Example | Use |
|-------|---------|-----|
| `Id` | `5198357738` | Advert id; result id is `tenant:Id` |
| `TenantId` | `7254` | Tenant/company lock |
| `CompanyName` | `Trondheim kommune` | Fallback company |
| `Heading` | `Barnehagelærer` | Title |
| `HeadingNotOverruled` | `Presthus Gård og Vikåsen barnehager, Trondheim kommune` | Title fallback / query text |
| `JobType` | `Permanent position` | Query text |
| `JobCategory` | `Medarbeider` | Query text |
| `Presentation` | plain text or HTML | Query text; detail fallback |
| `PublishedDate` | `27/10/2026` | Result date (dd/mm/yyyy) |
| `PublishedIntranetDate` | `27/10/2026` | Date fallback |
| `ApplicationDeadline` | `2026-11-09T22:59:59+00:00` | Not used as the posting date; `date` stays null if no publish date exists |
| `Workplace` | `Ranheim` | Location |
| `Workplace2` / `Workplace3` | `Ranheim` | Location |
| `WorkPlaceFacet` | `Presthus Gård og Vikåsen barnehager` | Query/location text |
| `WorkPlaceFacet2` / `WorkPlaceFacet3` | `["..."]` | Query/location text |
| `OpenAdvertUrl` | `https://7254.webcruiter.no/Main/Recruit/Public/5198357738?language=en&link_source_id=0` | Result URL |
| `ApplyUrl` | `/nb-NO/cv?advertId=...` | Not used |

`OpenAdvertUrl` redirects `302` from `/Main/...` to `/Main2/...`; the CLI
follows redirects.

## Registry `ats_ref` forms

The registry contains all of these, and the skill accepts each:

| Form | Example | Resolution |
|------|---------|------------|
| Company lock | `companylock=7254` | `7254` |
| Company lock | `companylock=748307` | `748307` |
| Tenant URL | `https://960040.webcruiter.no` | `960040` |
| Tenant URL with path | `https://23151000.webcruiter.no/Main/Recruit/Public/...` | `23151000` |
| Candidate page | `https://candidate.webcruiter.com/nb-no/Home/companyadverts?companylock=7254` | `7254` |

Rows with an empty `ats_ref` (for example Britannia Hotel and NGU as seeded)
are reported in `meta.errors`; the skill does not guess a tenant.

## Verified employers (6 Nov 2026)

| Employer (registry) | `ats_ref` | API total |
|---------------------|-----------|-----------|
| TRONDHEIM KOMMUNE | `companylock=7254` | 86 |
| ST. OLAVS HOSPITAL HF | `companylock=748307` | 85 |
| TRØNDELAG FYLKESKOMMUNE | `https://960040.webcruiter.no` | 25 |
| VY BUSS AS | `https://23151000.webcruiter.no` | 24 (group feed, includes Swedish jobs) |
| ARBEIDS- OG VELFERDSETATEN | `companylock=2106` | 57 |
| NORSK RIKSKRINGKASTING AS | `https://238765.webcruiter.no` | 11 |
| STATNETT SF | `https://903000.webcruiter.no` | 21 |
| SYKEHUSAPOTEKENE I MIDT-NORGE HF | `companylock=748308` | 2 |
| OKEA ASA | `https://55632.webcruiter.no` | 8 |
| TENSIO TS AS | `https://62532.webcruiter.no` | 2 |
| HEMIT HF | `companylock=748302` | 3 |
| AUTRONICA FIRE AND SECURITY AS | `companylock=23287000` | 0 |

The Vy feed is group-wide; `company` is normalised to the registry name
(`VY BUSS AS`) even when Webcruiter reports `Vy Buss AB`.

## Detail page

```
GET https://<tenant>.webcruiter.no/Main/Recruit/Public/<advertId>
```

The skill follows the `302` to `/Main2/Recruit/Public/<advertId>`.

Parsing anchors (verified on advert `5198357738`):

| Content | Anchor |
|---------|--------|
| Title | first `<h1>` → `<span class="we-editable disabled">` |
| Subtitle | `<h1><small><span class="we-editable disabled">` |
| Key info rows | `key-info-header` label span → `key-info-value` div |
| Company | key-info label `Arbeidsgiver` |
| Location | key-info label `Sted` |
| Deadline | key-info label `Søknadsfrist` |
| Employment type | key-info label `Ansettelsesform` |
| Description | every `<div class="... we-bullets">` block, in page order |

The description blocks are cleaned with `visibleHtml` (comments,
`script`/`style`/`template`, `hidden`, `display:none`) and tag stripping before
output, so hidden text never reaches the model.

Detail target forms:

- `tenant:advertId` — for example `7254:5198357738`
- posting URL on `<tenant>.webcruiter.no` — the `OpenAdvertUrl` from search

A bare numeric advert id is rejected: without a tenant host it cannot be
resolved safely.

## Failure behaviour

- `404` → not found (empty result for list calls; `NOT_FOUND` for detail).
- `429`/`5xx` and network errors → exponential backoff with jitter, up to six
  retries.
- A failing employer is recorded in `meta.errors` and never fails the whole
  run.
