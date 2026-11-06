# Teamtailor public jobs RSS — endpoint reference

Verified live on **6 November 2026** against HENT
(`https://hent.teamtailor.com/jobs.rss`) and Nordic Semiconductor
(`https://nordicsemiconductor.teamtailor.com/jobs.rss`).

Teamtailor documents the feed as an RSS 2.0 export of a career site's jobs. No
authentication, token or API key is needed.

## Feed URL

```
https://<site>/jobs.rss?offset=0&per_page=100
```

- `<site>` is normally `<company-slug>.teamtailor.com`.
- A custom careers domain serves the same feed at the same path, for example
  `https://careers.example.com/jobs.rss`.
- `per_page` is capped at 100. Requesting more does not return more.
- `offset` is 0-based and counts items, not pages.

### Pagination

Read pages until a page returns fewer than `per_page` items:

| Page | URL |
|------|-----|
| 1 | `.../jobs.rss?offset=0&per_page=100` |
| 2 | `.../jobs.rss?offset=100&per_page=100` |
| 3 | `.../jobs.rss?offset=200&per_page=100` |

A 404 on the feed is treated as an empty feed, not a fatal error. A feed that
still has 100 items after the last requested offset may have more; the CLI reads
as many pages as `--page` asks for (1 by default).

## RSS structure

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:tt="https://teamtailor.com/locations">
  <channel>
    <title>HENT</title>
    <description></description>
    <link>https://hent.teamtailor.com/jobs</link>
    <item>
      <title>Prosjektingeniør</title>
      <description>&lt;h3&gt;...HTML...&lt;/h3&gt;</description>
      <pubDate>Wed, 04 Nov 2026 07:42:37 +0100</pubDate>
      <link>https://karriere.hent.no/jobs/8662023-prosjektingenior</link>
      <guid>86c3422d-dc0a-4e53-ae5a-c3254713a4fe</guid>
      <remoteStatus>none</remoteStatus>
      <tt:locations>
        <tt:location>
          <tt:name>Trondheim</tt:name>
          <tt:address>Vestre Rosten 69</tt:address>
          <tt:zip>7072</tt:zip>
          <tt:city>Heimdal</tt:city>
          <tt:country>Norway</tt:country>
        </tt:location>
        <tt:location>
          <tt:name>Bodø</tt:name>
          <tt:address>Klinkerveien 8</tt:address>
          <tt:zip>8006</tt:zip>
          <tt:city>Bodo</tt:city>
          <tt:country>Norway</tt:country>
        </tt:location>
      </tt:locations>
      <tt:department>...</tt:department>
      <tt:role>...</tt:role>
    </item>
  </channel>
</rss>
```

### Item fields

| Field | Meaning | Parsing notes |
|-------|---------|---------------|
| `title` | Posting title | XML entities decoded once. |
| `description` | Posting summary/body | HTML escaped in the RSS payload; decode once, then run through `visibleHtml` before stripping tags. |
| `pubDate` | Posting date | RFC-822, e.g. `Wed, 04 Nov 2026 07:42:37 +0100`. Convert to `YYYY-MM-DD` in output. |
| `link` | Canonical posting URL | May be a custom domain (`karriere.hent.no`), not necessarily `*.teamtailor.com`. |
| `guid` | Stable posting id | A UUID in current feeds. Use as the search result `id`; fall back to the last path segment of `link`. |
| `remoteStatus` | Workplace status | Not used by the CLI. |
| `tt:department`, `tt:role` | Optional metadata | May be absent. |
| `tt:locations` | Zero or more locations | See below. |

### Location semantics

`tt:locations` contains zero or more `tt:location` elements:

| Field | Example | Notes |
|-------|---------|-------|
| `tt:name` | `Trondheim` | The location label shown on the career site. |
| `tt:address` | `Vestre Rosten 69` | Street address (may be empty). |
| `tt:zip` | `7072` | Postal code (may be self-closing/empty). |
| `tt:city` | `Heimdal` | City or district; can differ from `tt:name`. |
| `tt:country` | `Norway` | Country name in current feeds. |

`tt:name` and `tt:city` are both meaningful: a Trondheim job can have
`<tt:name>Trondheim</tt:name>` and `<tt:city>Heimdal</tt:city>`. Location matching
therefore checks both, plus `tt:zip` against the commute-area postal prefixes.
A location whose country is explicitly non-Norwegian is not part of the commute
area; this prevents a place name such as `Lund` (a Trondheim neighbourhood) from
matching Lund, Sweden. A missing country is allowed.

Output `location` is `tt:name` (or `tt:city`) plus country, for example
`Trondheim, Norway`. Multiple locations are joined with `; `.

## Posting detail page

Each RSS `link` points at a normal Teamtailor posting page. The page embeds a
schema.org `JobPosting` JSON-LD block, which is the stable source for detail
parsing:

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org/",
  "@type": "JobPosting",
  "title": "Anleggsleder betong",
  "description": "<p>...</p>",
  "datePosted": "2026-10-28T13:20:52+01:00",
  "identifier": { "@type": "PropertyValue", "value": "8630421" },
  "hiringOrganization": { "@type": "Organization", "name": "HENT" },
  "jobLocation": [
    {
      "@type": "Place",
      "address": {
        "streetAddress": "Vestre Rosten 69",
        "addressLocality": "Heimdal",
        "postalCode": "7072",
        "addressCountry": "NO"
      }
    }
  ]
}
</script>
```

Notes:

- `description` is HTML; run `visibleHtml` then preserve paragraph/list breaks.
- `jobLocation` may be an object or an array.
- `addressCountry` is an ISO code (`NO`) on the detail page, while the RSS feed
  uses the country name (`Norway`). The CLI normalises `NO` to `Norway`.
- `hiringOrganization.name` is the Teamtailor company name (for example `HENT`),
  not necessarily the registry row's legal name (for example `HENT AS`). Search
  results always use the registry `name`; detail uses the page's organisation.
- Fallbacks if JSON-LD is absent: `<h1>`, `<title>`, `og:site_name`, `og:url`,
  `article:published_time`, the first `<div class="...prose...">` body, and
  `/locations/<slug>` links.
- A 404 or empty response is `NOT_FOUND`.

## Registry schema

`job_scraper/employers.csv`, falling back to
`trondheim-patches/employers.seed.csv`. The Teamtailor skill reads:

| Column | Used for |
|--------|----------|
| `orgnr` | Retained on the employer object; not part of output. |
| `name` | Result `company` (normalised cross-source dedup key). |
| `ats` | Must equal `teamtailor` (case-insensitive). |
| `ats_ref` | Teamtailor RSS URL. Empty → skipped and recorded in `meta.errors`. |
| `enabled` | `false`/`0`/`no`/`nei`/`disabled`/`off` → skipped silently. |

CSV parsing handles quoted fields, embedded commas, doubled quotes and CRLF.

Two rows pointing at the same feed URL are fetched once; the first row's `name`
wins. Duplicate posting URLs in the pooled results are emitted once.

## Quirks observed

- HENT's feed is on `hent.teamtailor.com`, but its posting links use
  `karriere.hent.no`. Detail requests must follow the link's host, not assume
  `*.teamtailor.com`.
- HENT publishes one item with locations Trondheim/Heimdal, Bodø and Narvik; the
  Trondheim label and the Heimdal city are different fields, so matching on
  either is required.
- Nordic Semiconductor's feed is company-wide and includes Boston, Bristol,
  Lund, Oulu, Singapore and other countries. `--location` filtering is essential;
  omitting it returns the whole company.
- Some registry rows (Norsk Helsenett, Tide Buss, Personal Service og Sikkerhet,
  Stendi, Newsec, Telenor) have `ats=teamtailor` but no `ats_ref`; they are
  reported, never guessed.
- The feed's `guid` is a UUID; the posting URL carries a different numeric id and
  slug. Use the URL for `detail`.
