# SmartRecruiters URL reference

Verified live **6 November 2026**. All requests use
`Mozilla/5.0 (compatible; smartrecruiters-search-cli/1.0)`.

## Endpoints

### Posting list

```
GET https://api.smartrecruiters.com/v1/companies/<slug>/postings?limit=100&offset=0
```

| Param | Verified behaviour |
|-------|--------------------|
| `limit` | Capped by the API at **100** even when a larger value is requested. |
| `offset` | Zero-based; use `offset += content.length` until `offset >= totalFound`. |
| `q` | Honoured (full-text). `q=Trondheim` on `SopraSteria1` returned 22 items, including jobs in Oslo whose text mentions Trondheim. |
| `country` | Honoured as ISO-3166 alpha-2, **lowercase**. `country=no` returned 102 Sopra Steria jobs; `country=Norway` returned 0. |
| `location` | **Ignored.** `location=Trondheim` returned all 2093 Sopra Steria postings. Do not send it. |

Response:

```json
{
  "offset": 0,
  "limit": 100,
  "totalFound": 102,
  "content": [
    {
      "id": "744000160192843",
      "name": "Senior systemutvikler",
      "uuid": "…",
      "jobAdId": "…",
      "refNumber": "REF100",
      "company": { "identifier": "SopraSteria1", "name": "Sopra Steria" },
      "releasedDate": "2026-11-05T09:00:00.000Z",
      "location": {
        "city": "Trondheim",
        "region": "Trøndelag",
        "country": "no",
        "address": "…",
        "postalCode": "7010",
        "remote": false,
        "hybrid": true,
        "latitude": "…",
        "longitude": "…",
        "fullLocation": "Trondheim, Trøndelag, Norway"
      },
      "industry": { "id": "…", "label": "…" },
      "department": { "id": "…", "label": "…" },
      "function": { "id": "…", "label": "…" },
      "typeOfEmployment": { "id": "permanent", "label": "Full-time" },
      "experienceLevel": { "id": "…", "label": "…" },
      "customField": [ … ],
      "visibility": "PUBLIC",
      "ref": "https://api.smartrecruiters.com/v1/companies/<slug>/postings/<id>",
      "language": { "code": "no", "label": "Norwegian" }
    }
  ]
}
```

Location filtering uses `location.city`, `location.fullLocation`,
`location.postalCode` (for `area.json` postal prefixes) and `location.country`.

### Posting detail

```
GET https://api.smartrecruiters.com/v1/companies/<slug>/postings/<id>
```

Returns the list item plus:

- `postingUrl` / `applyUrl` — public `https://jobs.smartrecruiters.com/<slug>/<id>-<slug>`
- `jobAd.sections` — object keyed by `companyDescription`, `jobDescription`,
  `qualifications`, `additionalInformation`; each value is `{ title, text }`
  where `text` is HTML.

The CLI concatenates the preferred section order with paragraph breaks and runs
the result through `visibleHtml` before stripping tags.

### Public posting URL

```
https://jobs.smartrecruiters.com/<slug>/<id>
```

Verified `200` for `https://jobs.smartrecruiters.com/SopraSteria1/744000160192843`
(the slug suffix is optional). Search results use this short form.

## Registry `ats_ref` forms

`job_scraper/employers.csv` rows with `ats=smartrecruiters`:

| Employer | Registry `ats_ref` | Live result |
|----------|--------------------|-------------|
| Aker Solutions AS | `v1` | **Invalid** — `v1` is the API version. `v1` returns `totalFound: 0`; probing `AkerSolutions`, `akersolutions`, `AkerSolutionsASA`, `AkerSolutionsNorway`, `aker` found only one India posting, no Norway jobs. Reported in `meta.errors`. |
| Ramboll Norge AS | `Ramboll3` | Valid; 1045 total, 88 with `country=no`, including Trondheim. |
| Tieto Banktech Norway AS | `my` | Valid company endpoint, `totalFound: 0` on 6 Nov 2026. |
| Sopra Steria AS | `SopraSteria1` | Valid; 2093 total, 102 with `country=no`, including several Trondheim roles. |
| Sportradar AS | `v1` | **Invalid in the registry**; the verified slug is `Sportradar` (106 total, 3 Norway, all Trondheim). The CLI carries a documented override keyed by registry name. |

`ats_ref` may also be a full API URL; the CLI extracts the
`/companies/<slug>/` segment. `v1`-style values are rejected rather than
guessed.

## Access and terms

- **robots.txt:** `https://api.smartrecruiters.com/robots.txt` returns
  `User-agent: LinkedInBot / Allow: /v1/companies/` and
  `User-agent: * / Disallow: /`. The company API path is also the public API
  used by SmartRecruiters' own job widgets and needs no login. This CLI is for
  personal, low-volume job search; it does not impersonate a browser.
- **Authentication:** none.
- **Rate limits:** the API may return 429; the CLI backs off with jitter
  (max 6 retries) and caps request volume by filtering `country=no` when a
  location is given.
- **Verification date:** 6 Nov 2026.
