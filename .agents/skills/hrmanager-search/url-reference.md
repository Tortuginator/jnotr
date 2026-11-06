# HR Manager URL reference

Verified live **6 November 2026**. All requests use
`Mozilla/5.0 (compatible; hrmanager-search-cli/1.0)`.

HR Manager is now branded **Talentech**. Two hostnames are involved:

| Host | Use | robots.txt |
|------|-----|------------|
| `api.hr-manager.net` | Public RSS position lists and cid resolution | `404` (no published rules) |
| `candidate.hr-manager.net` | Candidate-facing list and detail pages | see below |

## Position list (RSS)

```
GET https://api.hr-manager.net/JobPortal.svc/<customer>/PositionList/rss/?protype=RecruitmentProject&incads=true
```

- `<customer>` is a customer name such as `Sparebank1` or `mist` (case is
  significant enough to keep the value exactly as resolved).
- `protype=RecruitmentProject` is the vacancy list.
- `protype=OpenApplication` is a separate list (0 items for `Sparebank1` on
  6 Nov 2026). The CLI intentionally reads only `RecruitmentProject`.
- `incads=true` includes advertisement content in `<description>`.
- Response is RSS 2.0 (`~88 KB`, 13 items for `Sparebank1` on 6 Nov 2026).

### Item fields

```xml
<item>
  <guid isPermaLink="false">149231</guid>
  <link>https://candidate.hr-manager.net/ApplicationInit.aspx?cid=1889&amp;ProjectId=149231&amp;DepartmentId=19320&amp;MediaId=5</link>
  <a10:author/>
  <title>Autorisert privatøkonomisk rådgiver - Haugesund / Aksdal</title>
  <description>&lt;p&gt;…HTML-escaped advertisement…&lt;/p&gt;</description>
  <pubDate>Wed, 04 Nov 2026 14:12:42 +0100</pubDate>
  <a10:link rel="alternate" type="text/html" href="…"/>
  <a10:updated>2026-11-05T15:24:09+01:00</a10:updated>
  <a10:content type="html"/>
</item>
```

There is **no location or category element**. The CLI derives location from:

1. a short trailing title segment after ` - ` / ` – ` / ` — `
   (`Finansrådgiver - Namsos`), then
2. a conservative description pattern where an `area.json` place is directly
   followed by a hiring/location verb (`På Heimdal søker vi …`,
   `… ligger i Trondheim` does **not** match because the verb precedes the
   place).

Jobs with no recognised location get `location: null` and are excluded by
`-l`. This avoids attributing a Namsos job to Trondheim because its employer's
boilerplate mentions a Trondheim head office.

## cid resolution

Registry rows may carry `cid=<n>` instead of `customer=<name>`.

```
GET https://api.hr-manager.net/JobPortal.svc/<cid>/PositionList/rss/?protype=RecruitmentProject&incads=true
```

The endpoint answers **HTTP 400** but still returns a channel whose `<link>`
names the customer:

```xml
<rss …><channel>
  <title>HR Manager Talent Recruiter - Position List</title>
  <link>https://candidate.hr-manager.net/vacancies/list.aspx?customer=mist</link>
  …
</channel></rss>
```

The CLI extracts `customer=mist`. If the channel has no `<link>`, resolution
fails and the employer is recorded in `meta.errors`; no customer name is
invented.

Verified on 6 Nov 2026:

| cid | Resolved customer | Result |
|-----|-------------------|--------|
| `1004` | `mist` | Valid; 1 item (`Rådgiver samisk kultur og historie`). |
| `1889` | `Sparebank1` | Valid; same feed as the registry's `customer=Sparebank1` row. |
| `139` | — | Empty channel (274 bytes), no `customer=` link. **GK Norge AS is unresolvable**; reported in `meta.errors`. |

`https://candidate.hr-manager.net/vacancies/list.aspx?cid=<n>` also renders a
page for `1004`, but it does **not** expose `customer=<name>` in the HTML and it
is disallowed by robots.txt. The RSS resolution above is both allowed and
reliable.

## Detail page

```
GET https://candidate.hr-manager.net/ApplicationInit.aspx?cid=<cid>&ProjectId=<id>&DepartmentId=<id>&MediaId=5
```

Verified `200` (64 KB). It is the application page but contains the full ad.

Anchors:

- `<div id="AdvertisementInnerContent">` — the readable advertisement. The CLI
  extracts this balanced `<div>` and converts HTML to text, preserving
  paragraphs and list breaks.
- `<meta property="og:title" content="…">` — posting title.
- `<title>Talentech - …</title>` — fallback title (the `Talentech - ` prefix is
  removed).
- `<meta name="description" content="…">` — fallback description.
- `cid` and `ProjectId` appear in the form action and links, so a bare search
  result id can be found by scanning the enabled feeds.

## Registry `ats_ref` forms

| Employer | `ats_ref` | Live result |
|----------|-----------|-------------|
| Sparebank 1 SMN | `customer=Sparebank1` | Valid. 13 items; the portal is alliance-wide (SpareBank 1 Sør-Norge, Forvaltning, Forsikring, Utvikling, Finans Midt-Norge, EiendomsMegler 1). |
| GK Norge AS | `cid=139` | **Unresolvable.** RSS channel is empty and has no customer link. Reported in `meta.errors`. |
| Museene i Sør-Trøndelag AS | `cid=1004` | Resolves to `mist`; 1 item. |
| Sparebank 1 Regnskapshuset SMN AS | `customer=Sparebank1` | Same feed as Sparebank 1 SMN. The CLI fetches it once and attributes jobs to the first enabled row (`SPAREBANK 1 SMN`). |

## Access and terms

- **robots.txt, `candidate.hr-manager.net`:**

  ```
  User-agent: *
  Allow: /ApplicationInit.aspx?
  Disallow: /ApplicationInit.aspx?*SkipAdvertisement=True*
  Disallow: /
  ```

  Longest-match gives `Allow` for the plain `ApplicationInit.aspx?` path used by
  this CLI. The vacancy list pages (`/vacancies/list.aspx`) are disallowed, so
  the CLI never fetches them; it uses the API RSS instead.

- **robots.txt, `api.hr-manager.net`:** returns `404`, so no rules are
  published. The RSS endpoints are public and require no login.

- **Authentication:** none.
- **Rate limits:** the CLI backs off with jitter on 429/5xx (max 6 retries) and
  fetches at most four feeds concurrently.
- **Verification date:** 6 Nov 2026.
