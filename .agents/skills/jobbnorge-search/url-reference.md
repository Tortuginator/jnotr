# Jobbnorge — URL and API reference

Verified live on **2026-11-06** against `www.jobbnorge.no`,
`publicapi.jobbnorge.no` and `id.jobbnorge.no`.

## Access

- Public. No credential, token or login.
- `https://www.jobbnorge.no/robots.txt` returns:

  ```
  User-agent: *
  Disallow: /ledige-stillinger/joblisting/pdf/*
  ```

  Only the PDF download path is disallowed. The search page, detail page and
  JSON endpoints used by this skill are not disallowed.
- Keep request volume low. This is a personal job-search helper, not a crawler.
- Terms note: no separate API terms page was reviewed beyond `robots.txt` and
  the public Swagger documentation. The endpoints are public and unauthenticated;
  use them for personal job search at low volume and re-check `robots.txt` if
  the integration is reused commercially.

## Official API specification

- Swagger: `https://publicapi.jobbnorge.no/swagger/v1/swagger.json`
- API version in paths: `v1`
- Base URL: `https://publicapi.jobbnorge.no`

## Endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `https://publicapi.jobbnorge.no/v1/Jobs` | GET | Search live job advertisements. |
| `https://publicapi.jobbnorge.no/v1/County` | GET | All counties with their municipalities (used to resolve `--location`). |
| `https://publicapi.jobbnorge.no/v1/JobCategory` | GET | Job-category tree (not used). |
| `https://publicapi.jobbnorge.no/v1/Jobs/count` | GET | Number of published jobs (not used). |
| `https://publicapi.jobbnorge.no/v1/Jobs/suggestions?search=` | GET | Search suggestions (not used). |
| `https://www.jobbnorge.no/ledige-stillinger/stilling/<id>` | GET | Human detail page. 302 to `…/<id>/<slug>`. The HTML is an Angular shell; the description is loaded by XHR. |
| `https://id.jobbnorge.no/api/joblisting/job-info?jobId=<id>&languageId=<n>` | GET | Detail metadata: employer, deadline, scope, duration, workplaces, contacts. |
| `https://id.jobbnorge.no/api/joblisting?jobId=<id>&languageId=<n>` | GET | Detail content: `components[]` with headings and HTML text, `activeLanguages`, `isPublished`, `positionCount`, contacts. |

### `/v1/Jobs` parameters

From the Swagger spec and live requests:

| Parameter | Type | Meaning |
| --- | --- | --- |
| `county` | int array | County code (fylkesnummer). Trøndelag = `50`. A county **name** is rejected; the numeric id is required. |
| `municipality` | int array | Municipality code (kommunenummer). Trondheim = `5001`. |
| `category` | int array | Job-category id (not used). |
| `employer` | int array | Employer id (not used). |
| `department` | int array | Department id (not used). |
| `term` | string | Free-text search term. |
| `orderby` | enum | `Published`, `Deadline`, `Employer`. The CLI requests `Published`. |
| `period` | enum | `Day`, `Week`, `All`. `Day` = last 1 day, `Week` = last 7 days (observed: 44 vs 242 live ads on the verification date). |
| `results` | int | Page size. The CLI caps its request at 100; the API accepted up to 500 in recon. |
| `page` | int | **0-indexed** page. `page=0` is the first slice; `page=1` is the next. The CLI's `--page` is 1-indexed per the portal contract and sends `page = --page - 1`. |
| `abroad` | bool | Include jobs outside Norway. |
| `language` | int | Response language. |

**Array parameters:** repeated query parameters work and are OR-ed, e.g.
`?municipality=5001&municipality=5031`. A comma-separated value
(`municipality=5001,5031`) is rejected with HTTP 400:

```json
{ "errors": { "municipality": ["The value '5001,5031,5028' is not valid."] } }
```

The CLI therefore repeats `municipality` for `--location area`.

### `/v1/Jobs` result fields

`JobResultV1` from Swagger, confirmed live:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | int | Job id; also the id in the detail URL. |
| `isJobListing` | bool | Observed `false` for normal listings. |
| `jobScope` | string/null | e.g. `Heltid`. |
| `jobDuration` | string/null | e.g. `Fast`, `Vikariat/Midlertidig`. |
| `deadline` | string/null | `dd.mm.yyyy`. |
| `employer` | string/null | Employer display name. Sometimes truncated by the API. |
| `title` | string/null | Posting title. |
| `summary` | string/null | Short intro text. |
| `logo` | string/null | Logo URL. |
| `link` | string/null | Canonical `https://www.jobbnorge.no/ledige-stillinger/stilling/<id>`. |
| `location` | string/null | Usually a municipality name; can be `Flere` for multi-location jobs. |
| `postCode` | string/null | Postal code (Swagger). |
| `promoted` | bool | Promoted listing flag. |
| `positionCount` | int | Number of positions. |
| `isInternal` | bool/null | Internal-listing flag (Swagger). |

**There is no publication-date field.** `period` filters on publication, but
the payload does not return the date. The skill therefore emits `date: null`
and documents the `--jobage` approximation.

### `/v1/County` response

```json
[
  {
    "id": 50,
    "name": "Trøndelag",
    "municipality": [
      { "id": 5001, "name": "Trondheim" },
      { "id": 5031, "name": "Malvik" },
      { "id": 5028, "name": "Melhus" },
      { "id": 5029, "name": "Skaun" },
      { "id": 5035, "name": "Stjørdal" }
    ]
  }
]
```

County and commute-area ids used by the skill:

| Place | Id |
| --- | --- |
| Trøndelag (county) | `50` |
| Trondheim (municipality) | `5001` |
| Malvik | `5031` |
| Melhus | `5028` |
| Skaun | `5029` |
| Stjørdal | `5035` |

## Detail page and content

### Human page

`https://www.jobbnorge.no/ledige-stillinger/stilling/310059` answers `302` to
`https://www.jobbnorge.no/ledige-stillinger/stilling/310059/<slug>`.

The returned HTML is an Angular shell:

- `<title>` and `<meta name="description">` are server-rendered and contain the
  title, employer and Norwegian-formatted deadline.
- The body has `<div data-ng-include="'/Client/packages/clients/web/views/jobListing.html'" data-ng-controller="JobListing">`
  followed by a loading indicator.
- Inline `configOptions` contains `job.id`, `job.applyUrl`,
  `job.pdfUrl`, and `api.url = 'https://id.jobbnorge.no/api/'`.
- `/Client/JobListing` (the Angular controller) calls
  `GET <api.url>/joblisting?jobId=…&languageId=…` for the content and
  `GET <api.url>/joblisting/job-info?jobId=…&languageId=…` for metadata.

The description is **not** in the server HTML, so parsing the page alone yields
no description. Use the JSON endpoints below.

### `job-info` response

Example (truncated):

```json
{
  "id": 310059,
  "employerName": "NTNU - Norges teknisk-naturvitenskapelige universitet",
  "deadlineOn": "$date('2026-12-04 00:00:00')",
  "jobScope": "Heltid",
  "jobDuration": "Fast",
  "workPlace": [
    { "adress": "Kolbjørn Hejes v 1B ", "area": "Trondheim", "zip": "7034", "municipality": "Trondheim" }
  ],
  "contacts": [
    { "name": "Ole Gunnar Dahlhaug", "email": "ole.g.dahlhaug@ntnu.no", "phone": "", "title": "Head of Department" }
  ]
}
```

- `deadlineOn` is wrapped in `$date('YYYY-MM-DD HH:MM:SS')`.
- `workPlace[]` carries `area`, `municipality`, `zip`, `adress`.
- `job-info` answered for both Norwegian and English postings when called with
  `languageId=1`.

### `joblisting` content response

Example keys: `components`, `activeLanguages`, `employerId`, `isPublished`,
`positionCount`, `contacts`, `logo`, `profileColor`, `excludeAISummary`.

Each component:

```json
{
  "heading": "About the position",
  "text": "<p>The Department …</p><ul><li>…</li></ul>",
  "typeId": 4,
  "orderId": 2,
  "id": 1405805
}
```

- `typeId` observed: `0` intro, `4` list, `6` text/video, etc. The skill does
  not depend on the numeric type; it reads `heading` and `text`.
- `text` is HTML and can include comments, hidden elements and script tags;
  run it through `visibleHtml` before stripping tags.
- `activeLanguages` lists the languages that have content. **A request for a
  language without content returns HTTP 404 with an empty body.** Example: job
  `310059` has only `languageId=2` (English); `languageId=1` returns 404. The
  CLI tries `1, 2, 3, 4` in order and records the first success as `language`
  (`nb`, `en`, `nn`, `se`).
- `isPublished` drives `isActive`.

## Quirks recorded during recon

1. The search payload has no publication date; `date` is always `null`.
2. `period` is only `Day`, `Week` or `All`; there is no arbitrary day window.
3. `municipality` accepts repeated parameters but not comma-separated values.
4. `county=Trøndelag` (name) fails; use `county=50`.
5. `orderby` is enum-valued; the CLI asks for `Published`.
6. **`page` is 0-indexed.** `page=0` is the first page. The CLI's `--page` is
   1-indexed and subtracts one before calling the API. This was verified live:
   with 6 matching ads, `results=5&page=0` returned 5 and `page=1` returned 1.
7. **The municipality filter is not a strict display-string filter.** Some
   multi-municipality ads (and a few national ads) appear under every
   municipality even though `location` shows another city or `Flere`. For
   example, on the verification date `municipality=5029` returned a Bodø
   kommune ad and a Kyiv embassy ad alongside Skaun-area ads. The filter is
   the portal's own registered-municipality match; the CLI does not add a
   stricter client-side location check because it would drop legitimate
   multi-location ads.
8. Employer names in the search payload can be truncated, so the registry
   matcher uses name, aliases and token-set equality rather than raw string
   equality.
9. The detail page 302-redirects to a slug URL; fetch with redirects enabled.
10. Detail content is language-specific and 404s for missing translations.
11. `/v1/Jobs/count` and `/v1/Jobs/suggestions` exist but are not used.
