# Workday public career-site API — endpoint reference

Verified live on **6 November 2026** against four `ats=workday` registry rows:

| Employer | `ats_ref` | Tenant | Site |
|----------|-----------|--------|------|
| Equinor ASA | `https://equinor.wd3.myworkdayjobs.com/EQNR` | `equinor` | `EQNR` |
| Norconsult Norge AS | `https://norconsult.wd3.myworkdayjobs.com/Norconsult_Career_Site` | `norconsult` | `Norconsult_Career_Site` |
| ASKO Midt-Norge AS | `https://norgesgruppen.wd3.myworkdayjobs.com/karriere` | `norgesgruppen` | `karriere` |
| NG Meny Midt-Norge AS | `https://norgesgruppen.wd3.myworkdayjobs.com/no-NO/karriere/job/...` | `norgesgruppen` | `karriere` |
| If Skadeforsikring NUF | `https://if.wd502.myworkdayjobs.com/Careers/` | `if` | `Careers` |

No authentication, token or API key is needed. The public career site is a thin
front end over the same CXS endpoints used here.

## Career-site URL parsing

A public career-site URL has the form:

```
https://<tenant>.<wdN>.myworkdayjobs.com[/<locale>]/<site>[/job/<slug>]
```

- `host` = URL host, e.g. `norconsult.wd3.myworkdayjobs.com`
- `tenant` = first host label, e.g. `norconsult`
- `site` = first non-empty path segment that is **not** a locale, stopping before
  `/job/`
  - `en-US`, `nb-NO`, `no-NO` are locale segments and are skipped
  - e.g. `/no-NO/karriere/job/Meny-Farmandstredet/...` → site `karriere`
- `externalPath` = everything from `/job/` onward, e.g.
  `/job/Trondheim/Sommerjobb-2027---Dam-og-vassdrag_REQ-6486`

Posting URL: `https://<host>/<site><externalPath>`.

Detail API URL: `https://<host>/wday/cxs/<tenant>/<site><externalPath>`.

## Search endpoint

```
POST https://<host>/wday/cxs/<tenant>/<site>/jobs
Content-Type: application/json
Accept: application/json
```

Body:

```json
{
  "appliedFacets": {},
  "limit": 20,
  "offset": 0,
  "searchText": "sommerstudent"
}
```

- `searchText` is the keyword query; an empty string lists everything.
- `limit` is the page size. 20 is the site default; values up to 100 worked in
  recon. Stay polite and keep it low.
- `offset` is 0-based.
- `appliedFacets` maps a facet parameter (normally `locations`) to an array of
  facet ids.

Response:

```json
{
  "total": 6,
  "jobPostings": [
    {
      "title": "Sommerstudent 2027",
      "externalPath": "/job/Kristiansand/Sommerstudent-2027_REQ-6543",
      "timeType": "Part time",
      "locationsText": "2 Locations",
      "postedOn": "Posted Yesterday",
      "bulletFields": ["REQ-6543"]
    }
  ],
  "facets": [
    {
      "facetParameter": "locationMainGroup",
      "values": [
        {
          "facetParameter": "locations",
          "descriptor": "Locations",
          "values": [
            { "descriptor": "Trondheim", "id": "232415...", "count": 1 }
          ]
        }
      ]
    }
  ],
  "userAuthenticated": false
}
```

### Posting fields

| Field | Meaning | Parsing notes |
|-------|---------|---------------|
| `title` | Posting title | Plain text. |
| `externalPath` | Site-relative posting path | Starts with `/job/`. Unique within a site. |
| `timeType` | Full time / Part time | Not used in search output. |
| `locationsText` | Location label | Often a city; may be `"2 Locations"`, `"4 Locations"`, `"Multiple Locations"` or `"Nordic"`. |
| `postedOn` | Relative posting date | Strings such as `"Posted Today"`, `"Posted Yesterday"`, `"Posted 2 Days Ago"`, `"Posted 30+ Days Ago"` (also seen: months). No timestamp. |
| `bulletFields` | Extra labels | First is usually the requisition id; on NorgesGruppen the second is the brand (`ASKO`, `MENY`, `KIWI`, …). |

### Facets

Facets may be top-level or nested. In the NorgesGruppen/Equinor/Norconsult/If
responses observed, `locations` is nested inside a `locationMainGroup` wrapper:

```json
{
  "facetParameter": "locationMainGroup",
  "values": [
    {
      "facetParameter": "locations",
      "descriptor": "Locations",
      "values": [{ "descriptor": "Trondheim", "id": "...", "count": 4 }]
    }
  ]
}
```

The CLI walks the facet tree recursively and collects ids from any object whose
`facetParameter` is `locations`, matching descriptors against the commute-area
candidates. Facets are scoped to the `searchText` that produced them, so the CLI
probes facets with `searchText: ""`.

Filter with the facet's **own** `facetParameter` as the key:

```json
{ "appliedFacets": { "locations": ["<facet-id>"] } }
```

Most tenants expose a `locations` facet. NorgesGruppen instead exposes a
`locationHierarchy1` facet (descriptor `Municipality`), and the API returns
HTTP 400 when that id is sent under `locations`:

```json
{ "appliedFacets": { "locationHierarchy1": ["414feedc23b5101eda7744b2424d0000"] } }
```

Verified live: that request returns the one MENY Trondheim posting, and
`locationHierarchy1` for Stjørdal returns the SPAR Hegra posting. The CLI
therefore groups matching ids by `facetParameter` and sends the correct key,
falling back to unfiltered listing if a tenant still rejects the body.

Location semantics observed:

- Norconsult: `Trondheim` (4 jobs), and multi-location jobs such as
  `"4 Locations"` can be returned by the Trondheim facet because one of their
  locations is Trondheim.
- Equinor: no `Trondheim` descriptor; its Trondheim office is labelled
  `Rotvoll, Norway` (a Trondheim district). `Stjørdal, Norway` is also present.
- NorgesGruppen: the location facet is `locationHierarchy1` (municipality), not
  `locations`. Sending its ids under `locations` returns HTTP 400 with
  `{"errorCode":"HTTP_400",...}`; sending them under `locationHierarchy1` works.
  Other facets (e.g. brand) work too. If a tenant rejects the facet body, fall
  back to listing and matching `locationsText`.
- If: location facet has country values (`Norway`, `Sweden`, …) and place values
  (`Oslo`, `Stockholm`, `Nordic`, …). Postings commonly say `"4 Locations"`;
  verify with the detail endpoint.

## Detail endpoint

```
GET https://<host>/wday/cxs/<tenant>/<site><externalPath>
Accept: application/json
```

Response:

```json
{
  "jobPostingInfo": {
    "id": "f128badf6cf81001e6bbce27c3490000",
    "title": "Sommerjobb 2027 – Dam og vassdrag",
    "jobDescription": "<p>...</p><br /><ul>...</ul>",
    "location": "Trondheim",
    "additionalLocations": ["Turku", "Espoo"],
    "postedOn": "Posted 14 Days Ago",
    "startDate": "2026-10-23",
    "endDate": "2026-12-02",
    "timeType": "Full time",
    "jobReqId": "REQ-6486",
    "externalUrl": "https://norconsult.wd3.myworkdayjobs.com/Norconsult_Career_Site/job/Trondheim/Sommerjobb-2027---Dam-og-vassdrag_REQ-6486",
    "country": { "descriptor": "Norway", "id": "..." },
    "jobRequisitionLocation": {
      "descriptor": "Trondheim",
      "country": { "descriptor": "Norway", "alpha2Code": "NO" }
    }
  }
}
```

| Field | Meaning | Parsing notes |
|-------|---------|---------------|
| `jobDescription` | Body HTML | Run through `visibleHtml` before stripping tags; preserve `<br>`, `<p>`, `<li>` breaks. |
| `location` | Primary location label | May be a region (`Nordic`) while `additionalLocations` holds cities. |
| `additionalLocations` | Extra location labels | Array of strings, may be absent. |
| `postedOn` | Relative posting label | Same format as search. |
| `startDate` | ISO posting/period start | Used as the detail `date` when present. |
| `endDate` | ISO application deadline | Printed as `End`. |
| `timeType` | Employment type | |
| `jobReqId` | Requisition id | |
| `externalUrl` | Canonical public posting URL | Preferred over a constructed URL. |
| `country` | Country object | `{ descriptor, id }`. |
| `jobRequisitionLocation` | Register location | Can differ from `location`; also checked for area matching. |

A 404 or a payload without `jobPostingInfo` is reported as `NOT_FOUND`.

## Registry schema

`job_scraper/employers.csv`, falling back to
`trondheim-patches/employers.seed.csv`. The Workday skill reads:

| Column | Used for |
|--------|----------|
| `orgnr` | Retained on the employer object; not part of output. |
| `name` | Result `company` (normalised cross-source dedup key). |
| `ats` | Must equal `workday` (case-insensitive). |
| `ats_ref` | Public Workday career-site URL. Empty/invalid → skipped and recorded in `meta.errors`. |
| `enabled` | `false`/`0`/`no`/`nei`/`disabled`/`off` → skipped silently. |

Rows that share one site (ASKO and NG Meny on NorgesGruppen) are fetched once.
Brand tokens from the row name are matched against the posting title/path/bullet
fields. A posting for another group brand (SPAR, Joker, KIWI) keeps that brand as
`company`; an unknown employer keeps its own name, matching the plan's
deduplication rule.

## robots.txt and terms

Checked 6 November 2026:

| Host | robots.txt |
|------|------------|
| `norconsult.wd3.myworkdayjobs.com` | `User-agent: *` / `Allow: /Norconsult_Career_Site/` / `Disallow: /refreshFacet/` |
| `norgesgruppen.wd3.myworkdayjobs.com` | `Allow: /karriere/` / `Disallow: /refreshFacet/` |
| `equinor.wd3.myworkdayjobs.com` | `Allow: /EQNR/` / `Disallow: /refreshFacet/` |
| `if.wd502.myworkdayjobs.com` | `Allow: /Careers/` / `Disallow: /refreshFacet/` |

The career-site paths used here are allowed; `/refreshFacet/` is not used. The
`/wday/cxs/` API path is not disallowed by any of the four files. This is a
personal-use connector: keep volume low, do not use it commercially or for bulk
data collection, and re-check the site terms before changing the request rate.
The CLI sends an honest User-Agent
`Mozilla/5.0 (compatible; workday-search-cli/1.0)`.

## Quirks observed

- `postedOn` is relative text, not a timestamp. `startDate` in the detail payload
  is the reliable ISO date; search results have to parse `postedOn`.
- Norconsult search with `searchText: "sommerstudent"` returned 6 of 67 jobs,
  confirming the API honours `searchText`.
- Equinor's Trondheim jobs are under `Rotvoll, Norway`; a naive `Trondheim`
  descriptor match alone misses them.
- NorgesGruppen's location facet is `locationHierarchy1`; its ids are rejected
  (HTTP 400) under `locations` but accepted under `locationHierarchy1`.
- If's jobs often use `Nordic` plus `additionalLocations`; only a detail fetch
  tells whether Trondheim is included.
- Two registry rows (ASKO, NG Meny) point at the same NorgesGruppen site, so
  grouping by origin+site avoids duplicate fetches and duplicate postings.
- `externalPath` values are stable and unique within a site; the search `id` is
  `<tenant>/<site><externalPath>` so pooled results stay unambiguous.
