# NAV Arbeidsplassen feed - URL and field reference

Verified against the live service on **6 November 2026**. Documentation:
<https://navikt.github.io/pam-stilling-feed/>. OpenAPI:
<https://pam-stilling-feed.ekstern.dev.nav.no/api/openapi.json>.

## Authentication

Every request needs a bearer token:

```
Authorization: Bearer <token>
Accept: application/json
```

- Private tokens: email **nav.team.arbeidsplassen@nav.no**, confirm the terms at
  <https://arbeidsplassen.nav.no/vilkar-api>, and provide identifier, contact
  email, phone, and contact person.
- Public experimental token: `GET https://pam-stilling-feed.nav.no/api/publicToken`
  returns plain text beginning `Current public token for Nav Job Vacancy Feed:`
  followed by the JWT on the next line. It rotates at irregular intervals.
  Never hardcode it and never fetch it automatically from the CLI.
- The CLI reads the token only from `NAV_API_TOKEN`.

## Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `https://pam-stilling-feed.nav.no/api/v1/feed` | GET | First (oldest) feed page |
| `https://pam-stilling-feed.nav.no/api/v1/feed?last` | GET | Newest feed page |
| `https://pam-stilling-feed.nav.no/api/v1/feed/{feedPageId}` | GET | A specific page (the `next_url` target) |
| `https://pam-stilling-feed.nav.no/api/v1/feedentry/{uuid}` | GET | Full ad detail for one UUID |

There is no `prev_url`. The feed is a singly linked list from older to newer.

### Feed headers and parameters

| Name | In | Notes |
|------|----|-------|
| `If-Modified-Since` | header | RFC 1123 date, e.g. `Fri, 30 Oct 2026 13:00:00 GMT`. Starts the response at entries modified after that time. |
| `If-None-Match` | header | ETag value from a previous response; may return `304 Not Modified`. |
| `last` | query | `?last` returns the newest page. Observed to ignore `If-Modified-Since`. |

Responses carry `ETag` and `Last-Modified` headers. `Last-Modified` is not a
reliable proxy for "now" in the observed responses; use item dates.

### Feed page response

```json
{
  "version": "https://jsonfeed.org/version/1.1",
  "title": "NAV Job Vacancy Feed",
  "home_page_url": "https://arbeidsplassen.nav.no",
  "feed_url": "/api/v1/feed",
  "description": "...",
  "next_url": "/api/v1/feed/<next-page-uuid>",
  "id": "<current-page-uuid>",
  "next_id": "<next-page-uuid>",
  "items": [FeedItem]
}
```

- Page size observed: **1000 items**.
- `next_url` and `next_id` are `null` on the final page.
- The first page without `If-Modified-Since` starts at the oldest retained data
  (June 2023 in the observed feed), not at "now". The feed is ordered oldest to
  newest within and across pages, so `next_url` moves **forward in time**.
- `?last` returns the current final (newest) page. It can contain fewer than
  1000 items; at the time of recon it held a single item.
- `If-Modified-Since` filters to entries after the supplied timestamp. The first
  returned item can be later than the header value because of data boundaries.

### Feed item

```json
{
  "id": "<entry id, usually the same UUID as _feed_entry.uuid>",
  "url": "/api/v1/feedentry/<uuid>",
  "title": "Job title",
  "content_text": "Stillingsannonse",
  "date_modified": "2026-11-05T10:00:00+01:00",
  "_feed_entry": {
    "uuid": "<ad UUID>",
    "status": "ACTIVE",
    "title": "Job title",
    "businessName": "Employer display name",
    "municipal": "TRONDHEIM",
    "sistEndret": "2026-11-05T10:00:00+01:00"
  }
}
```

Observed `content_text` values: every sampled item contained the literal
`"Stillingsannonse"`, so it is not a usable description. The full description is
only on the detail endpoint.

`municipal` is uppercase. There is no postal code, city, or organisation number
in the feed summary; those come from the detail's `workLocations` and
`employer`.

### Detail response

```json
{
  "uuid": "<ad UUID>",
  "sistEndret": "2026-11-05T10:30:00+01:00",
  "status": "ACTIVE",
  "ad_content": {
    "uuid": "<ad UUID>",
    "published": "2026-11-05T10:00:00+01:00",
    "expires": "2026-11-25T00:00:00+01:00",
    "updated": "2026-11-05T10:30:00+01:00",
    "workLocations": [
      {
        "country": "NORGE",
        "address": "Erling Skakkes gate 14",
        "city": "TRONDHEIM",
        "postalCode": "7013",
        "county": "TRØNDELAG",
        "municipal": "TRONDHEIM"
      }
    ],
    "contactList": [ ... ],
    "title": "Job title",
    "description": "<p>HTML description</p>",
    "sourceurl": "",
    "source": "IMPORTAPI",
    "applicationUrl": "https://...",
    "applicationDue": "2026-11-25T00:00:00",
    "occupationCategories": [ ... ],
    "categoryList": [ ... ],
    "jobtitle": "",
    "link": "https://arbeidsplassen.nav.no/stillinger/stilling/<uuid>",
    "employer": {
      "name": "Employer name",
      "orgnr": "942110464",
      "description": "...",
      "homepage": "..."
    },
    "engagementtype": "Fast",
    "extent": "Heltid",
    "starttime": "",
    "positioncount": "1",
    "sector": "Offentlig"
  }
}
```

- `ad_content` is **absent** for some inactive or explicitly stopped ads. The
  observed response then is only `{ "uuid", "sistEndret", "status": "INACTIVE" }`
  with HTTP 200. Treat this as an inactive ad, not a 404.
- `status` at the root is the current state (`ACTIVE` / `INACTIVE`).
- `description` is HTML. Run `visibleHtml` before stripping tags; hidden
  elements and script/style blocks are not reader-visible.
- `applicationDue` and `expires` may have no timezone; the date part is the
  useful value.
- `employer.orgnr` is the organisation number used for registry matching.
- `link` is the public ad URL; when absent, construct
  `https://arbeidsplassen.nav.no/stillinger/stilling/<uuid>`.

### Not-found response

A missing page or entry returns HTTP 404 with:

```json
{
  "title": "Endpoint GET /api/v1/feedentry/<uuid> not found",
  "status": 404,
  "type": "https://javalin.io/documentation#endpointnotfound",
  "details": {}
}
```

The CLI maps a 404 to `NOT_FOUND` for `detail` and to an empty result for
internal fetches.

## Quirks found in recon

1. **The feed is oldest-first.** Following `next_url` from the default first
   page walks toward the present, not into history. On a first sync the CLI
   therefore anchors at `?last` and estimates a recent window, then crawls
   forward from there.
2. **`?last` returns only the newest partial page.** There is no previous-page
   link, so a low-volume sync cannot reconstruct arbitrary history backward.
3. **`content_text` is a placeholder.** Do not use it for keyword matching;
   match titles and the detail description.
4. **Detail can 200 without `ad_content`.** Inactive ads are masked this way.
5. **Status is a change log.** The same UUID appears repeatedly as an ad changes;
   the last entry wins. An old `ACTIVE` entry must not override a newer
   `INACTIVE` one.
6. **Municipality spelling is uppercase** (`TRONDHEIM`, `STJØRDAL`), and the
   feed does not carry a postal code. Area matching therefore uses
   `municipal` and, when a detail has been fetched, `workLocations.postalCode`.
7. **Active ads can expire between syncs.** A cached `ACTIVE` summary may
   already be `INACTIVE` when its detail is fetched; the detail's status is
   authoritative at fetch time.

## Fields used by the CLI

| CLI field | Feed source | Detail source |
|-----------|-------------|---------------|
| `id` / `uuid` | `_feed_entry.uuid` | `uuid` |
| `title` | `_feed_entry.title` | `ad_content.title` |
| `company` | `_feed_entry.businessName` (normalized) | `ad_content.employer.name` / `orgnr` |
| `location` | `_feed_entry.municipal` (title-cased) | `ad_content.workLocations[].city` or `municipal` |
| `municipal` | `_feed_entry.municipal` | `ad_content.workLocations[].municipal` |
| `postal_code` | none | `ad_content.workLocations[].postalCode` |
| `date` | `date_modified` | `ad_content.published` (fallback `updated` / `sistEndret`) |
| `date_modified` | `date_modified` / `sistEndret` | `sistEndret` |
| `deadline` | none | `ad_content.applicationDue` (fallback `expires`) |
| `employment_type` | none | `ad_content.engagementtype` |
| `extent` | none | `ad_content.extent` |
| `status` | `_feed_entry.status` | root `status` |
| `description` | `content_text` when not the placeholder | `ad_content.description` (HTML cleaned) |
| `url` | public ad URL | `ad_content.link` or public ad URL |

## Rate limiting

No published quota was found. The CLI uses an honest User-Agent and exponential
backoff with jitter on 429 and 5xx (up to roughly six retries). Keep `sync` to
one incremental pull per run and use `--max-pages` to cap volume.
